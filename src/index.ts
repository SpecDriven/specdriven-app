// The command line first (specs/app/plugins.feature.md "A plugin loads from
// a local folder"): `specdriven plugin new|build|link` scaffolds, builds or
// links a plugin and exits without starting the server.
if (process.argv[2] === "plugin") {
  const { runPluginCli } = await import("./plugins/cli");
  process.exit(await runPluginCli(process.argv.slice(3)));
}

import index from "./index.html";
import { applyStartupState, handleApi } from "./server/api";
import { shell } from "./plugins/host/loader";
import { installDemoPlugins, isDemoMode, setupDemo } from "./server/demo";
import { isHostedMode } from "./server/hostedMode";
import { isReadOnlyMode } from "./server/readOnlyMode";
import { createEnvBackend, setTokenBackend } from "./server/tokenStore";
import { allowedHosts, listenHostname, rejectRequest } from "./server/requestGuard";
import { initTelemetry } from "./server/telemetry";
import { applyProfile } from "./server/profile";

// `--profile <dir>` (src/server/profile.ts): settings, token and clones in a
// folder of their own — before anything reads where they live.
const profile = applyProfile();
if (profile) console.log(`Using the settings folder ${profile} (--profile)`);

// OpenTelemetry (opt-in via the standard OTEL_* environment variables) must
// be up before the first sync or API call so nothing escapes the pipeline.
initTelemetry();

// Demo mode (DEMO_MODE=1): seed the ephemeral demo dataset and sandbox all
// state under the demo root before startup reads any settings, then fetch
// the demo's marketplace plugins in the background.
if (isDemoMode()) {
  await setupDemo();
  void installDemoPlugins();
}

// Read-only mode (src/server/readOnlyMode.ts): the public spec site. Clone
// the repo it shows and open its first snapshot before startup reads any
// settings; a repo that cannot be cloned stops the start here.
if (isReadOnlyMode()) await (await import("./server/readOnly")).setupReadOnly();

// Hosted mode (src/server/hostedMode.ts): one user's worker behind the
// gateway, which hands it that user's GitHub token in the environment — set
// before the startup sync below, the first thing to need it.
if (isHostedMode()) setTokenBackend(createEnvBackend());

// The API itself lives in server/api.ts so the desktop app can serve the
// same routes over its app:// protocol (specs/app/desktop-app.feature.md).
void applyStartupState();

// A hosted worker serves the API alone: its gateway serves the frontend to
// every user (src/gateway/appShell.ts), so no worker spends memory bundling it.
const routes = (): Record<string, Bun.HTMLBundle | Response> =>
  isHostedMode() ? {} : shellRoutes();

const shellRoutes = () => ({
  "/": index,
  // The platform's health check (railway.json), as the gateway answers it.
  "/healthz": new Response("ok"),

  // Deep links (specs/ui/navigation.feature.md): every /features/... url serves
  // the app shell; the client resolves it against /api/features/:file. The
  // desktop shell already falls back to it for any unbundled path
  // (src/electron/static.ts).
  "/features": index,
  "/features/*": index,
  // The app's own pages (specs/user-info-settings.feature.md "open
  // Settings", "open Plugins") take the editor pane at their own urls.
  "/settings": index,
  // Project settings (src/frontend/ProjectSettingsPage.tsx): the data
  // repo's project-settings.json.
  "/project-settings": index,
  "/plugins": index,
  // Observability (src/frontend/ObservabilityPage.tsx): the app's own logs.
  "/observability": index,
  // Data (src/frontend/DataPage.tsx): the Automerge store, browsed read-only.
  "/data": index,
  // Images (src/frontend/ImagesPage.tsx): the stored images, the unused ones first.
  "/images": index,
  // What's new (src/frontend/WhatsNewPage.tsx): the release notes.
  "/whats-new": index,
  // Updates (src/frontend/UpdatesPage.tsx): the newest release; on the web
  // server the installer one-liner, since it cannot replace itself.
  "/updates": index,
  // The plugins' urls (specs/app/plugins.feature.md "Plugin urls serve the
  // app shell") — the special folders' pages among them: each module
  // behind the kernel names its prefix in its manifest, on or off, so a
  // deep link to a switched-off tab still lands in the app and goes home
  // there. A plugin from a folder adds its prefix once found; the routes
  // are reloaded below when that happens.
  ...Object.fromEntries(shell.prefixes().flatMap((p) => [[p, index], [`${p}/*`, index]])),
});
// Every request the route table sees passes the trust-boundary check first
// (src/server/requestGuard.ts): Host names this machine, writes come from
// the app's own origin and carry JSON or a file upload.
const extraHosts = allowedHosts();
const fetch = async (req: Request) =>
  rejectRequest(req, extraHosts) ??
  (await handleApi(req)) ??
  new Response("Not Found", { status: 404 });

const options = {
  // Bun idles a connection out after 10s by default, which is short for the
  // git clone/push and sync requests this server handles.
  idleTimeout: 60,
  routes: routes(),
  fetch,
  // `bun run build` compiles with --production, which inlines NODE_ENV here:
  // the binary serves the pre-bundled frontend with cache headers, no HMR.
  development:
    process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
};

// A hosted worker listens on the private socket its gateway names
// (src/gateway/workers.ts) instead of a port: only the gateway reaches it.
const unixSocket = process.env.SPECDRIVEN_UNIX_SOCKET?.trim();
// bun-types forbids idleTimeout beside `unix`, but the runtime honors it —
// without it a slow clone through the socket is cut off at Bun's 10s default.
const server = unixSocket
  ? Bun.serve({ ...options, unix: unixSocket } as unknown as Parameters<typeof Bun.serve>[0])
  : Bun.serve({
      ...options,
      // 3000 unless PORT says otherwise — the compiled binary is a single file
      // someone may run alongside a dev server on the same machine.
      port: Number(process.env.PORT) || 3000,
      // Loopback only unless SPECDRIVEN_HOST says otherwise: the API has no
      // login, so it must not be reachable from the network (the demo image
      // sets 0.0.0.0).
      hostname: listenHostname(),
    });

// A plugin folder that appears while the server runs brings its url
// prefixes with it: the route table is swapped for one that serves the
// shell there too, without a restart.
shell.subscribe(() => server.reload({ routes: routes(), fetch }));

// Bound to 127.0.0.1 Bun reports that address; say localhost, the name the
// docs use (it resolves to the same loopback).
const shown = unixSocket
  ? `unix:${unixSocket}`
  : server.hostname === "127.0.0.1"
    ? `http://localhost:${server.port}/`
    : server.url;
console.log(`SpecDriven running at ${shown}`);

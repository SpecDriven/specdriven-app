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
import { initTelemetry } from "./server/telemetry";

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

// The API itself lives in server/api.ts so the desktop app can serve the
// same routes over its app:// protocol (specs/desktop-app.spec.md).
void applyStartupState();

const routes = () => ({
  "/": index,

  // Deep links (specs/navigation.spec.md): every /features/... url serves
  // the app shell; the client resolves it against /api/features/:file. The
  // desktop shell already falls back to it for any unbundled path
  // (src/electron/static.ts).
  "/features": index,
  "/features/*": index,
  // The app's own pages (specs/user-info-settings.feature.md "open
  // Settings", "open Plugins") take the editor pane at their own urls.
  "/settings": index,
  "/plugins": index,
  // The plugins' urls (specs/app/plugins.feature.md "Plugin urls serve the
  // app shell") — the special folders' pages among them: each module
  // behind the kernel names its prefix in its manifest, on or off, so a
  // deep link to a switched-off tab still lands in the app and goes home
  // there. A plugin from a folder adds its prefix once found; the routes
  // are reloaded below when that happens.
  ...Object.fromEntries(shell.prefixes().flatMap((p) => [[p, index], [`${p}/*`, index]])),
});
const fetch = async (req: Request) =>
  (await handleApi(req)) ?? new Response("Not Found", { status: 404 });

const server = Bun.serve({
  // 3000 unless PORT says otherwise — the compiled binary is a single file
  // someone may run alongside a dev server on the same machine.
  port: Number(process.env.PORT) || 3000,
  // Bun idles a connection out after 10s by default, which is short for the
  // git clone/push and sync requests this server handles.
  idleTimeout: 60,
  routes: routes(),
  fetch,
  // `bun run build` compiles with --production, which inlines NODE_ENV here:
  // the binary serves the pre-bundled frontend with cache headers, no HMR.
  development:
    process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
});

// A plugin folder that appears while the server runs brings its url
// prefixes with it: the route table is swapped for one that serves the
// shell there too, without a restart.
shell.subscribe(() => server.reload({ routes: routes(), fetch }));

console.log(`SpecDriven running at ${server.url}`);

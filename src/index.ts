import index from "./index.html";
import { applyStartupState, handleApi } from "./server/api";
import { shell } from "./plugins/host/loader";
import { isDemoMode, setupDemo } from "./server/demo";
import { initTelemetry } from "./server/telemetry";

// OpenTelemetry (opt-in via the standard OTEL_* environment variables) must
// be up before the first sync or API call so nothing escapes the pipeline.
initTelemetry();

// Demo mode (DEMO_MODE=1): seed the ephemeral demo dataset and sandbox all
// state under the demo root before startup reads any settings.
if (isDemoMode()) await setupDemo();

// The API itself lives in server/api.ts so the desktop app can serve the
// same routes over its app:// protocol (specs/desktop-app.spec.md).
void applyStartupState();

const server = Bun.serve({
  // 3000 unless PORT says otherwise — the compiled binary is a single file
  // someone may run alongside a dev server on the same machine.
  port: Number(process.env.PORT) || 3000,
  // Bun idles a connection out after 10s by default, which is short for the
  // git clone/push and sync requests this server handles.
  idleTimeout: 60,
  routes: {
    "/": index,

    // Deep links (specs/navigation.spec.md): every /features/... url serves
    // the app shell; the client resolves it against /api/features/:file. The
    // special folders' pages address the same way (specs/app/roadmap.feature
    // .md, specs/app/tasks.feature.md), so their urls serve the shell too —
    // the desktop shell already falls back to it for any unbundled path
    // (src/electron/static.ts).
    "/features": index,
    "/features/*": index,
    "/roadmap": index,
    "/roadmap/*": index,
    "/tasks": index,
    "/tasks/*": index,
    // The engineering notebook's entries address the same way
    // (specs/app/engineering-notebook.feature.md).
    "/notebook": index,
    "/notebook/*": index,
    // The plugins' urls (specs/app/plugins.feature.md "Plugin urls serve the
    // app shell"): each module behind the kernel names its prefix in its
    // manifest, on or off, so a deep link to a switched-off tab still lands
    // in the app and goes home there.
    ...Object.fromEntries(shell.prefixes().flatMap((p) => [[p, index], [`${p}/*`, index]])),
  },
  fetch: async (req) => (await handleApi(req)) ?? new Response("Not Found", { status: 404 }),
  // `bun run build` compiles with --production, which inlines NODE_ENV here:
  // the binary serves the pre-bundled frontend with cache headers, no HMR.
  development:
    process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
});

console.log(`SpecDriven running at ${server.url}`);

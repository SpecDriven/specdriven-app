import index from "./index.html";
import { applyStartupState, handleApi } from "./server/api";

// The API itself lives in server/api.ts so the desktop app can serve the
// same routes over its app:// protocol (specs/desktop-app.spec.md).
void applyStartupState();

const server = Bun.serve({
  // 3000 unless PORT says otherwise — the compiled binary is a single file
  // someone may run alongside a dev server on the same machine.
  port: Number(process.env.PORT) || 3000,
  routes: {
    "/": index,

    // Deep links (specs/navigation.spec.md): every /features/... url serves
    // the app shell; the client resolves it against /api/features/:file.
    "/features": index,
    "/features/*": index,
  },
  fetch: async (req) => (await handleApi(req)) ?? new Response("Not Found", { status: 404 }),
  // `bun run build` compiles with --production, which inlines NODE_ENV here:
  // the binary serves the pre-bundled frontend with cache headers, no HMR.
  development:
    process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
});

console.log(`SpecDriven running at ${server.url}`);

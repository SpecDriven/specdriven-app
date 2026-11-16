// The Content-Security-Policy on the app's own pages
// (docs/hosted-tenant-isolation.md "Step 2", specs/app/hosted-app.feature.md
// "The app's pages run only the app's own script"). The app shows what a
// repository holds — markdown, images, diagrams — and a repository is its
// person's, or a teammate's, to shape. The policy is what stands between
// such content and the page's own powers: only script the gateway or the
// person's worker serves runs, nothing is sent anywhere but this host, and
// no other site frames the app.
//
// What it has to leave room for, found by going through the app's screens
// with the policy on:
//
//   - the one inline script in src/index.html (the theme, before first
//     paint), let through by its hash, never by 'unsafe-inline';
//   - WebAssembly (Automerge), which needs 'wasm-unsafe-eval' — not 'unsafe-eval';
//   - workers started from blobs (the editors' language workers);
//   - styles set from script (React's style props, CodeMirror's sheets),
//     which is what 'unsafe-inline' on style-src allows;
//   - images from anywhere over https, since a spec's markdown may show one;
//   - the diagram editor's fonts, which Excalidraw loads from its own CDN
//     path and fetches again to put into an exported drawing
//     (src/frontend/excalidraw/ExcalidrawPane.tsx). That path and no more:
//     it is the one place outside this host the page may fetch from, and
//     what it serves there is not the app's to change.
//
// One thing is refused on purpose: Excalidraw's font subsetter asks for
// `eval` as a drawing is exported. It is told no, and the drawing is
// exported with its font all the same.
//
// Script from the person's worker (a plugin's client bundle) comes from
// this same host and so still runs: that is why the account pages have a
// host of their own (server.ts).

type Env = Record<string, string | undefined>;

/** "report" sends the policy as Report-Only: nothing is blocked, and the browser's console says what would be. */
export type AppCspMode = "enforce" | "report" | "off";

/** SPECDRIVEN_APP_CSP=report or =off loosens it without a new build; anything else enforces. */
export function readAppCspMode(env: Env = process.env): AppCspMode {
  const value = env.SPECDRIVEN_APP_CSP?.trim().toLowerCase();
  return value === "off" || value === "report" ? value : "enforce";
}

/** Where Excalidraw's fonts come from; a path ending in "/" allows what is under it. */
const EXCALIDRAW_ASSETS = "https://esm.sh/@excalidraw/";

/**
 * The `'sha256-…'` source of each inline script in a page: what lets exactly
 * those run. The page is read by an HTML parser, as the browser reads it —
 * a pattern for `<script>…</script>` misses the end tags a browser accepts
 * (`</script >`, `</SCRIPT\n>`), and what it took for one script's text
 * would then not be what the browser hashes.
 */
export function inlineScriptHashes(html: string): string[] {
  const scripts: string[] = [];
  let inline = false;
  new HTMLRewriter()
    .on("script", {
      element(element) {
        inline = !element.hasAttribute("src");
        if (inline) scripts.push("");
      },
      text(chunk) {
        if (inline) scripts[scripts.length - 1] += chunk.text;
      },
    })
    .transform(html);
  return scripts
    .filter((body) => body.length > 0)
    .map((body) => `'sha256-${new Bun.CryptoHasher("sha256").update(body).digest("base64")}'`);
}

/** The header to send with the app's pages, or null when the policy is off. */
export function appCsp(mode: AppCspMode, inlineScripts: string[]): { header: string; value: string } | null {
  if (mode === "off") return null;
  const value = [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...inlineScripts].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `font-src 'self' data: ${EXCALIDRAW_ASSETS}`,
    "media-src 'self' data: blob:",
    `connect-src 'self' ${EXCALIDRAW_ASSETS}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
  return { header: mode === "report" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", value };
}

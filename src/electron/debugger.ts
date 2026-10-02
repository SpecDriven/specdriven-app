// Main-process debugger for development builds (README "Debugging"): the
// Debug menu opens Node's inspector inside the Electron main process — where
// the server modules run in the desktop app — so Chrome DevTools or VS Code
// can attach without relaunching with --inspect. Kept free of electron
// imports so the port handling can be tested under bun.

import type * as NodeInspector from "node:inspector";

/** Node's default inspector port: chrome://inspect discovers it unasked. */
export const DEBUG_PORT = 9229;

export type InspectorApi = Pick<typeof NodeInspector, "open" | "url">;

/**
 * Start the inspector on loopback only — anyone who reaches it can run code
 * in the app — preferring DEBUG_PORT and falling back to any free port when
 * that one is taken (a busy port leaves no url rather than throwing). An
 * inspector already running, e.g. a launch with --inspect, is reused.
 * Returns the ws:// url, or null when no port could be opened.
 */
export function startInspector(inspector: InspectorApi, port = DEBUG_PORT): string | null {
  const running = inspector.url();
  if (running) return running;
  for (const candidate of [port, 0]) {
    inspector.open(candidate, "127.0.0.1");
    const url = inspector.url();
    if (url) return url;
  }
  return null;
}

/** The url that opens Chrome's DevTools on that inspector, pasted into Chrome. */
export function devtoolsUrl(wsUrl: string): string {
  return `devtools://devtools/bundled/js_app.html?ws=${wsUrl.replace(/^ws:\/\//, "")}`;
}

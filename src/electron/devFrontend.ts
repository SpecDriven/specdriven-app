// A development run of the desktop shell (`bun run dev:electron`,
// scripts/dev-electron.ts): the windows load the Bun dev server's address,
// so the frontend hot-reloads in them, while every API call their pages
// make is answered by the desktop process itself — the one place that knows
// which folder each window shows (specs/app/multiple-windows.feature.md "A
// development run"). The rules for which request goes where, kept out of
// main.ts so they run under bun test.

/** The dev server's address in a development run (ELECTRON_DEV), or null in the packaged app. */
export function devServerUrl(env: Record<string, string | undefined>): string | null {
  return env.ELECTRON_DEV ? `http://localhost:${env.PORT || 3000}` : null;
}

/**
 * Whether an http request is one of the app's own pages' — to the dev
 * server's address — and so passes through the desktop process's handler.
 * Http to any other host, or to another port of this machine, is not the
 * app's and goes out untouched.
 */
export function isDevServerRequest(url: string, devUrl: string | null): boolean {
  if (!devUrl) return false;
  try {
    return new URL(url).origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Whether the dev server's answer is replaced by the app shell: a page it
 * has no route for — a plugin's page of a folder the dev server itself does
 * not have open, say — still has to load the app, which then finds the page
 * (specs/ui/navigation.feature.md), as the packaged app's handler serves
 * the shell for every path that is no file. Only a page load: a script,
 * image or fetch that is missing stays missing.
 */
export function needsShell(request: { method: string; accept: string | null }, status: number): boolean {
  return status === 404 && request.method === "GET" && (request.accept ?? "").includes("text/html");
}

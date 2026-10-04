// Who may talk to the web server (docs/ARCHITECTURE.md "Local trust
// boundary"). The API has no login: it serves whoever owns the machine, and
// behind it sit routes that write the auto-pushed data repo, install plugins
// and start coding agents that run commands. So the server listens on
// loopback only, and every request that reaches the route table is checked
// here first:
//
//   - Host must name this machine, so a hostile domain re-pointed at
//     127.0.0.1 (DNS rebinding) cannot read or drive the API;
//   - a state-changing request must come from the app's own origin, so any
//     other website open in the same browser cannot post to localhost;
//   - a state-changing body must be JSON or a file upload, so a cross-site
//     form or text/plain post (the kinds a browser sends without a CORS
//     preflight) is refused even where a browser left Origin out.
//
// Only the web server applies it: the desktop app serves the same routes
// over its own app:// scheme, which no web page can reach.

import { json } from "./http";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9.-]+\.localhost)$/i;
const BODY_TYPES = ["application/json", "multipart/form-data"];

type Env = Record<string, string | undefined>;

/**
 * The interface Bun.serve binds: loopback unless SPECDRIVEN_HOST opens it
 * up. Not plain HOST — shells set that to the machine's own name.
 */
export function listenHostname(env: Env = process.env): string {
  return env.SPECDRIVEN_HOST?.trim() || "127.0.0.1";
}

/**
 * Extra Host names the server answers to, beyond loopback, from the
 * comma-separated SPECDRIVEN_ALLOWED_HOSTS — e.g. the public domain of a
 * deployment that sets SPECDRIVEN_HOST=0.0.0.0. "*" turns the Host check off.
 */
export function allowedHosts(env: Env = process.env): string[] {
  return (env.SPECDRIVEN_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** The Host header's name without its port: "[::1]:3000" → "[::1]". */
function hostName(host: string): string {
  return host.replace(/:\d+$/, "").toLowerCase();
}

/** The refusal for a request the server must not serve, or null to serve it. */
export function rejectRequest(req: Request, extraHosts: string[] = []): Response | null {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const name = hostName(host);
  const hostAllowed =
    LOOPBACK_HOST.test(name) ||
    extraHosts.includes("*") ||
    extraHosts.includes(host) ||
    extraHosts.includes(name);
  if (!hostAllowed) return json({ error: `Requests for host "${host}" are not served` }, 403);

  if (SAFE_METHODS.has(req.method)) return null;

  // A browser sends Origin on every cross-origin POST/PUT/DELETE. Only the
  // host is compared: behind a TLS-terminating proxy the request arrives as
  // http while the page's origin is https.
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      // "null" (a sandboxed frame, a file:// page) is never the app.
    }
    if (originHost !== host) return json({ error: "Cross-origin requests are not allowed" }, 403);
  } else if (req.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "Cross-origin requests are not allowed" }, 403);
  }

  // Bun hands an empty body over as null, so a bare POST (reload,
  // interrupt) needs no Content-Type.
  if (req.body !== null && req.headers.get("content-length") !== "0") {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!BODY_TYPES.includes(type)) {
      return json({ error: "Request bodies must be application/json or multipart/form-data" }, 415);
    }
  }
  return null;
}

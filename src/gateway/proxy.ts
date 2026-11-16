// Forward a signed-in user's request to their worker (workers.ts) over its
// unix socket and stream the answer back — the agent-free app still streams
// (server-sent plugin events, long syncs), so neither body is buffered. The
// request goes on as the browser sent it, Host and Origin included, minus
// the gateway's session cookie, which is no business of the app's.
//
// The answer is not trusted the same way (docs/hosted-tenant-isolation.md
// "Step 1", specs/app/hosted-app.feature.md "A worker's answer cannot act
// on the gateway's pages"): a worker runs on a repository its person, or a
// teammate of theirs, controls, and it answers on the origin that also
// serves the account and admin pages. So no cookie it sets reaches the
// browser — the session cookie is the gateway's alone, and the app sets
// none — and nothing it answers on the API can run as a page there.

import { cookiesWithout, type CookieOptions } from "./sessions";
import { WORKER_KEY_HEADER } from "./workers";

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * What an API answer is held to when a browser opens it as a page: no
 * script, no origin of its own (`sandbox`), nothing loaded from anywhere.
 * The app reads its API with fetch and shows its images in `<img>`, where a
 * policy on the answer changes nothing.
 */
export const WORKER_API_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * `worker` is where the person's worker listens and the key it asks for
 * (workers.ts): a worker owns the folder its socket is in and could put a
 * link to another person's socket there, and that worker would refuse a
 * request carrying this one's key.
 */
export async function proxyToWorker(
  req: Request,
  worker: { socket: string; key?: string },
  cookies: CookieOptions,
): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  // The key is the gateway's to send, never the browser's.
  headers.delete(WORKER_KEY_HEADER);
  if (worker.key) headers.set(WORKER_KEY_HEADER, worker.key);
  const cookie = cookiesWithout(headers.get("cookie"), cookies);
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  // Plain bytes from the worker: what it sends is what the browser gets.
  headers.set("accept-encoding", "identity");
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  const upstream = await fetch(`http://localhost${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: "manual",
    signal: req.signal,
    unix: worker.socket,
  } as RequestInit);
  const out = new Headers(upstream.headers);
  for (const name of HOP_BY_HOP) out.delete(name);
  out.delete("set-cookie");
  // Nor may a script it serves become a service worker for the whole host,
  // which would see every later request, a hand-over's code included.
  out.delete("service-worker-allowed");
  if (url.pathname.startsWith("/api/")) {
    out.set("content-security-policy", WORKER_API_CSP);
    out.set("x-content-type-options", "nosniff");
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

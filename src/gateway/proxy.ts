// Forward a signed-in user's request to their worker (workers.ts) over its
// unix socket and stream the answer back — the agent-free app still streams
// (server-sent plugin events, long syncs), so neither body is buffered. The
// request goes on as the browser sent it, Host and Origin included, minus
// the gateway's session cookie, which is no business of the app's.

import { cookiesWithout, type CookieOptions } from "./sessions";

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

export async function proxyToWorker(req: Request, socket: string, cookies: CookieOptions): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
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
    unix: socket,
  } as RequestInit);
  const out = new Headers(upstream.headers);
  for (const name of HOP_BY_HOP) out.delete(name);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

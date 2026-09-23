// The route table's vocabulary, shared by the core routes in api.ts and the
// plugins that add their own (src/plugins/host/services.ts): a handler takes
// the request and the `:name` segments its pattern bound, and answers JSON.

export type Params = Record<string, string>;
export type Handler = (req: Request, params: Params) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** The request's JSON object body, or a throw the route turns into a 400. */
export async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("A JSON object body is required");
  }
  return body;
}

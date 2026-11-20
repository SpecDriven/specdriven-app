// The Worker's routes, apart from Cloudflare itself (src/worker.ts supplies
// the Durable Object behind `connect`), so the app's tests can run them:
//
//   GET  /.well-known/specdriven-sync   which GitHub this server checks against
//   POST /<owner>/<name>/ticket         a GitHub token for a short-lived pass
//   GET  /<owner>/<name>?ticket=…       the repository's WebSocket, with a pass
//
// Each repository has a sync server of its own behind the last route: its own
// running Automerge repo and its own storage, shared with no other.

import { checkWriteAccess, type RepoName } from "./access";
import { signTicket, verifyTicket } from "./tickets";

export interface RouteDeps {
  /** The secret passes are signed with; absent means the server is not set up. */
  secret: string | undefined;
  /** The GitHub host whose repositories this server serves, e.g. github.com. */
  githubHost: string;
  /** That host's REST API, e.g. https://api.github.com. */
  githubApi: string;
  /** How long a pass lasts, in seconds. */
  ticketSeconds: number;
  now(): number;
  fetch: typeof fetch;
  /** Hand a WebSocket upgrade to the repository's own sync server. */
  connect(repoKey: string, request: Request, expiresAt: number): Promise<Response>;
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function repoOf(owner: string | undefined, name: string | undefined): RepoName | null {
  if (!owner || !name || !NAME.test(owner) || !NAME.test(name)) return null;
  if (owner.startsWith(".") || name === "." || name === "..") return null;
  return { owner, name };
}

/** The name a repository's sync server goes by; GitHub's names ignore case. */
export function repoKey(host: string, repo: RepoName): string {
  return `${host}/${repo.owner}/${repo.name}`.toLowerCase();
}

export async function handle(request: Request, deps: RouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((part) => part !== "");

  if (request.method === "GET" && url.pathname === "/.well-known/specdriven-sync") {
    return json({ githubHost: deps.githubHost, ticketSeconds: deps.ticketSeconds });
  }
  if (request.method === "GET" && parts.length === 0) {
    return new Response("SpecDriven sync server\n", { headers: { "content-type": "text/plain" } });
  }
  if (!deps.secret) return json({ error: "The sync server has no TICKET_SECRET set" }, 500);

  if (request.method === "POST" && parts.length === 3 && parts[2] === "ticket") {
    const repo = repoOf(parts[0], parts[1]);
    if (!repo) return json({ error: "Not a repository" }, 404);
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return json({ error: "A GitHub token is required" }, 401);
    const access = await checkWriteAccess(deps.githubApi, repo, token, deps.fetch);
    if (!access.ok) return json({ error: access.error }, access.status);
    const expiresAt = Math.floor(deps.now() / 1000) + deps.ticketSeconds;
    const ticket = await signTicket(deps.secret, { repo: repoKey(deps.githubHost, repo), exp: expiresAt });
    return json({ ticket, expiresAt });
  }

  if (request.method === "GET" && parts.length === 2) {
    const repo = repoOf(parts[0], parts[1]);
    if (!repo) return json({ error: "Not a repository" }, 404);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "This address is a WebSocket" }, 426);
    }
    const key = repoKey(deps.githubHost, repo);
    const claims = await verifyTicket(
      deps.secret,
      url.searchParams.get("ticket") ?? "",
      key,
      Math.floor(deps.now() / 1000),
    );
    if (!claims) return json({ error: "A current pass for this repository is required" }, 401);
    return deps.connect(key, request, claims.exp);
  }

  return json({ error: "Not found" }, 404);
}

// A sync server that keeps one sync server per data repository
// (cloudflare/sync-server, specs/datastore/automerge-store.feature.md): the
// Settings address holds `{repo}` where the repository's owner and name go,
// and the server lets in only who GitHub says can push to that repository.
// So before the bridge (netsync.ts) can dial it, the address is made this
// repository's own, the user's GitHub access is shown to the server once,
// and the server answers with a short-lived pass that goes on the address.
//
// The GitHub token is the user's: it is sent only to an address the user
// typed with `{repo}` in it, only over an encrypted connection (or to this
// machine), and only after the server said it checks against the GitHub the
// repository is on.

import { getAuth } from "../auth";
import { sameHost } from "../github";
import { issuesToken, repoOfFolder } from "../issues";
import type { GitHubRepo } from "../repo";

/** Where the repository's `<owner>/<name>` goes in a Settings address. */
const REPO_PLACEHOLDER = "{repo}";

/** Whether a Settings address names a server with one sync server per repository. */
export function isPerRepoSyncUrl(url: string): boolean {
  return url.includes(REPO_PLACEHOLDER);
}

export interface SyncAddress {
  /** What the bridge dials. Holds the pass: never log it, see {@link withoutPass}. */
  url: string;
  /** When the pass on it runs out, in ms since the epoch; null when it has none. */
  expiresAt: number | null;
}

/** Why a repository's sync server could not be reached; the message is for the log. */
export class SyncAccessError extends Error {
  /**
   * True when asking again cannot help until something changes — no write
   * access, no sign-in, the wrong GitHub — rather than a server that did not
   * answer.
   */
  constructor(
    message: string,
    readonly final: boolean,
  ) {
    super(message);
  }
}

export interface SyncAddressDeps {
  repoOf(dataDir: string): Promise<GitHubRepo | null>;
  tokenFor(host: string): Promise<string | null>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const defaultDeps: SyncAddressDeps = {
  repoOf: async (dataDir) => repoOfFolder(dataDir, (await getAuth())?.host),
  tokenFor: (host) => issuesToken(host),
  fetch: (url, init) => fetch(url, init),
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An address as it may be logged: without the pass. */
export function withoutPass(url: string): string {
  return url.replace(/\?.*$/, "");
}

/**
 * The address the bridge dials for `dataDir`. An address without `{repo}` is
 * a plain sync server (wss://sync.automerge.org): dialled as it is, and no
 * GitHub access goes anywhere.
 */
export async function resolveSyncAddress(
  template: string,
  dataDir: string,
  deps: SyncAddressDeps = defaultDeps,
): Promise<SyncAddress> {
  if (!isPerRepoSyncUrl(template)) return { url: template, expiresAt: null };

  const repo = await deps.repoOf(dataDir);
  if (!repo) {
    throw new SyncAccessError("the data folder has no GitHub repository as its origin, so it has no sync server", true);
  }
  let socket: URL;
  try {
    socket = new URL(template.split(REPO_PLACEHOLDER).join(`${repo.owner}/${repo.name}`));
  } catch {
    throw new SyncAccessError("the sync server address is not a url", true);
  }
  if (socket.protocol !== "wss:" && !(socket.protocol === "ws:" && LOOPBACK.has(socket.hostname))) {
    throw new SyncAccessError(
      "GitHub access is not sent over an unencrypted connection: the sync server address must start with wss://",
      true,
    );
  }
  socket.search = "";
  socket.hash = "";
  const web = new URL(socket.href);
  web.protocol = socket.protocol === "wss:" ? "https:" : "http:";

  // Which GitHub the server asks: a token for another one is not sent to it.
  const about = await ask(deps, `${web.origin}/.well-known/specdriven-sync`, {});
  const serverHost = (about as { githubHost?: unknown } | null)?.githubHost;
  if (typeof serverHost !== "string") {
    throw new SyncAccessError("the address does not answer as a SpecDriven sync server", false);
  }
  const sameGitHub = sameHost(undefined, repo.host) ? sameHost(undefined, serverHost) : sameHost(repo.host, serverHost);
  if (!sameGitHub) {
    throw new SyncAccessError(
      `the sync server checks access on ${serverHost}, and the data repository is on ${repo.host}`,
      true,
    );
  }
  const token = await deps.tokenFor(repo.host);
  if (!token) {
    throw new SyncAccessError(`sign in to ${repo.host} to use the repository's sync server`, true);
  }
  const pass = (await ask(deps, `${web.href.replace(/\/+$/, "")}/ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })) as { ticket?: unknown; expiresAt?: unknown } | null;
  if (typeof pass?.ticket !== "string" || typeof pass.expiresAt !== "number") {
    throw new SyncAccessError("the sync server's answer held no pass", false);
  }
  socket.searchParams.set("ticket", pass.ticket);
  return { url: socket.href, expiresAt: pass.expiresAt * 1000 };
}

/** One request to the sync server; its own words when it says no. */
async function ask(deps: SyncAddressDeps, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, redirect: "error" });
  } catch {
    throw new SyncAccessError(`the sync server at ${new URL(url).host} could not be reached`, false);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: told apart by the status below.
  }
  if (res.ok) return body;
  const said = (body as { error?: unknown } | null)?.error;
  throw new SyncAccessError(
    typeof said === "string" ? `the sync server said: ${said}` : `the sync server answered ${res.status}`,
    res.status === 401 || res.status === 403,
  );
}

/** A pass is renewed once this share of its life is over. */
const RENEW_AT = 0.8;
/** Never sooner than this, so a server handing out very short passes is not hammered. */
const MIN_RENEW_MS = 10_000;
/** How long before asking again after the server could not be reached. */
const RETRY_MS = 60_000;

/**
 * How long to wait before asking a server that turned the app away once
 * more, or null when asking again by itself cannot help: it said no (no
 * write access, no sign-in, another GitHub), and only a change the user
 * makes will get a different answer. A server that did not answer, or
 * anything unforeseen, is asked again after a minute.
 */
export function retryDelayMs(error: unknown): number | null {
  return error instanceof SyncAccessError && error.final ? null : RETRY_MS;
}

/** How long from `now` until a pass that runs out at `expiresAt` should be renewed. */
export function renewDelayMs(expiresAt: number, now: number): number {
  return Math.max(MIN_RENEW_MS, Math.floor((expiresAt - now) * RENEW_AT));
}

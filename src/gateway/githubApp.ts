// The hosted service's own GitHub App (docs/hosted-tenant-isolation.md
// "Step 3", specs/app/hosted-app.feature.md "A worker gets a GitHub token
// for one repository, for an hour"). It replaces the personal access token
// a person used to paste: a token that lasted months, often reached more
// than one repository, and sat in their worker's environment.
//
// The gateway holds the app's private key and does three things with it:
//
//   - once, when a person connects GitHub on the account page, it learns
//     which GitHub account is theirs. The token GitHub gives for that is
//     used for one question and then revoked; nothing of it is kept;
//   - when a worker's git needs a repository, it asks GitHub whether the app
//     is installed there and what that person may do there, and then for a
//     token that lasts an hour and reaches that repository alone, to read it
//     or to write it as the person may;
//   - when the worker stops, it revokes the tokens that worker was given.
//
// What a person may reach is asked of GitHub every time a token is made,
// never remembered: access taken away there is gone here within the hour.
//
// No GitHub call is made as root or by a worker: this is the gateway's.

import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { githubApiBase, githubWebBase } from "../server/github";

type Env = Record<string, string | undefined>;

export const APP_CLIENT_ID_ENV = "SPECDRIVEN_GITHUB_APP_CLIENT_ID";
export const APP_CLIENT_SECRET_ENV = "SPECDRIVEN_GITHUB_APP_CLIENT_SECRET";
export const APP_PRIVATE_KEY_ENV = "SPECDRIVEN_GITHUB_APP_PRIVATE_KEY";

export interface GithubAppConfig {
  clientId: string;
  clientSecret: string;
  privateKey: KeyObject;
}

/** The key as GitHub hands it out (a PEM file), with its line ends written as `\n`, or all of it in base64. */
export function parsePrivateKey(text: string): KeyObject {
  let pem = text.trim();
  if (!pem.includes("-----BEGIN")) pem = Buffer.from(pem, "base64").toString("utf8");
  pem = pem.replace(/\\n/g, "\n");
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(`${APP_PRIVATE_KEY_ENV} is not a private key: paste the .pem file GitHub gave for the app`);
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error(`${APP_PRIVATE_KEY_ENV} is not an RSA key`);
  return key;
}

/**
 * The app's settings; null when none of the three is set, and people paste
 * a personal access token as before. Some but not all is a mistake, and
 * stops the start rather than quietly falling back to the weaker way.
 */
export function readGithubAppConfig(env: Env = process.env): GithubAppConfig | null {
  const values = [APP_CLIENT_ID_ENV, APP_CLIENT_SECRET_ENV, APP_PRIVATE_KEY_ENV].map((name) => [name, env[name]?.trim() ?? ""] as const);
  const missing = values.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length === values.length) return null;
  if (missing.length) throw new Error(`The GitHub App needs all three of its variables; missing: ${missing.join(", ")}`);
  return { clientId: values[0]![1], clientSecret: values[1]![1], privateKey: parsePrivateKey(values[2]![1]) };
}

/** The GitHub account a person proved is theirs. */
export interface GithubIdentity {
  id: number;
  login: string;
  name: string | null;
  /** Their public address, or GitHub's stand-in for one who keeps it private. */
  email: string;
}

/** A token for one repository. */
export interface RepoToken {
  token: string;
  /** When GitHub stops accepting it, in milliseconds. */
  expiresAt: number;
  /** Whether it can push; a person who can only read gets one that can only read. */
  write: boolean;
}

export type RefusalReason = "not-connected" | "not-installed" | "no-access" | "too-many" | "unavailable";

/** Why no token was made; the message is one the person can act on. */
export class GithubRefusal extends Error {
  constructor(
    public reason: RefusalReason,
    message: string,
  ) {
    super(message);
  }
}

/** `owner/name` as GitHub spells a repository, from that or from a url's path; null for anything else. */
export function repoName(text: unknown): string | null {
  if (typeof text !== "string" || text.length > 300) return null;
  const path = text.trim().replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = path.split("/");
  if (parts.length !== 2) return null;
  // GitHub's own alphabet for both halves; `.` and `..` would name another path.
  if (!parts.every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part) && part !== "." && part !== "..")) return null;
  return `${parts[0]}/${parts[1]}`;
}

const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "SpecDriven",
};

/** No GitHub call waits longer: a worker's git is waiting on it. */
const CALL_TIMEOUT_MS = 15_000;

export interface GithubAppOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** https://api.github.com and https://github.com, or a stand-in's (src/server/github.ts). */
  apiBase?: string;
  webBase?: string;
}

export class GithubApp {
  private fetch: typeof fetch;
  private now: () => number;
  private api: string;
  private web: string;
  private page: Promise<string> | null = null;

  constructor(
    private config: GithubAppConfig,
    opts: GithubAppOptions = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.api = (opts.apiBase ?? githubApiBase()).replace(/\/+$/, "");
    this.web = (opts.webBase ?? githubWebBase()).replace(/\/+$/, "");
  }

  /**
   * The app's own word, signed with its private key: what GitHub asks for
   * before it makes a token. GitHub accepts one for ten minutes at most;
   * this one says nine, and a minute back for a clock that runs ahead.
   */
  jwt(): string {
    const seconds = Math.floor(this.now() / 1000);
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: seconds - 60, exp: seconds + 9 * 60, iss: this.config.clientId })}`;
    return `${body}.${sign("sha256", Buffer.from(body), this.config.privateKey).toString("base64url")}`;
  }

  private call(path: string, bearer: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    return this.fetch(`${this.api}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...API_HEADERS,
        Authorization: `Bearer ${bearer}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // A repository that was renamed or moved answers with a redirect to
      // wherever it is now: that is another repository than the one asked for.
      redirect: "manual",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  }

  /** Where a person is sent to say which GitHub account is theirs. */
  authorizeUrl(state: string, redirectUri: string): string {
    const query = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: redirectUri, state });
    return `${this.web}/login/oauth/authorize?${query}`;
  }

  /** The app's page on GitHub, where a person installs it on a repository. */
  installUrl(): Promise<string> {
    this.page ??= (async () => {
      const res = await this.call("/app", this.jwt());
      const app = res.ok ? ((await res.json()) as { html_url?: unknown }) : null;
      if (typeof app?.html_url !== "string") throw new Error(`GitHub did not describe the app (HTTP ${res.status})`);
      return `${app.html_url.replace(/\/+$/, "")}/installations/new`;
    })();
    // Asked again next time when it failed.
    this.page.catch(() => (this.page = null));
    return this.page;
  }

  /**
   * Whose GitHub account a sign-in's code stands for. The token the code
   * buys answers that one question and is then revoked: nothing that lasts
   * is left of a person's sign-in, here or at GitHub.
   */
  async identify(code: string, redirectUri: string): Promise<GithubIdentity> {
    const res = await this.fetch(`${this.web}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "SpecDriven" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const data = (res.ok ? await res.json().catch(() => ({})) : {}) as { access_token?: unknown; error?: unknown };
    if (typeof data.access_token !== "string" || !data.access_token) {
      throw new Error(`GitHub did not accept the sign-in: ${typeof data.error === "string" ? data.error : `HTTP ${res.status}`}`);
    }
    const token = data.access_token;
    try {
      const who = await this.call("/user", token);
      if (!who.ok) throw new Error(`GitHub did not say whose sign-in it was (HTTP ${who.status})`);
      const user = (await who.json()) as { id?: unknown; login?: unknown; name?: unknown; email?: unknown };
      if (typeof user.id !== "number" || typeof user.login !== "string" || !user.login) {
        throw new Error("GitHub did not say whose sign-in it was");
      }
      return {
        id: user.id,
        login: user.login,
        name: typeof user.name === "string" && user.name ? user.name : null,
        email: typeof user.email === "string" && user.email ? user.email : `${user.id}+${user.login}@users.noreply.github.com`,
      };
    } finally {
      await this.revokeSignIn(token).catch((e: Error) => console.error(`revoking a GitHub sign-in failed: ${e.message}`));
    }
  }

  /** End the token a sign-in bought. Only that token: the person's other sign-ins with the app stand. */
  private async revokeSignIn(token: string): Promise<void> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const res = await this.fetch(`${this.api}/applications/${encodeURIComponent(this.config.clientId)}/token`, {
      method: "DELETE",
      headers: { ...API_HEADERS, Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  /**
   * An hour's token from one installation, for one repository — by its name,
   * or by its id once that is known — and these rights and no more. GitHub
   * says back which repository the token is for.
   */
  private async mint(
    installation: number,
    repo: string,
    which: { name: string } | { id: number },
    permissions: Record<string, string>,
  ): Promise<{ token: string; expiresAt: number; repoId: number | null }> {
    const res = await this.call(`/app/installations/${installation}/access_tokens`, this.jwt(), {
      method: "POST",
      body: { ...("id" in which ? { repository_ids: [which.id] } : { repositories: [which.name] }), permissions },
    });
    const made = res.ok
      ? ((await res.json()) as { token?: unknown; expires_at?: unknown; repositories?: { id?: unknown; full_name?: unknown }[] })
      : null;
    const expiresAt = typeof made?.expires_at === "string" ? Date.parse(made.expires_at) : NaN;
    if (typeof made?.token !== "string" || !made.token || !Number.isFinite(expiresAt)) {
      throw new GithubRefusal("unavailable", `GitHub made no token for ${repo} (HTTP ${res.status}): check what the app may do on it`);
    }
    // A token for any repository but the one asked for is not handed on.
    const covered = Array.isArray(made.repositories) ? made.repositories : null;
    const one = covered?.length === 1 ? covered[0]! : null;
    if (covered && (typeof one?.full_name !== "string" || one.full_name.toLowerCase() !== repo.toLowerCase())) {
      void this.revoke(made.token);
      throw new GithubRefusal("unavailable", `GitHub made a token for another repository than ${repo}`);
    }
    return { token: made.token, expiresAt, repoId: typeof one?.id === "number" ? one.id : null };
  }

  /**
   * A token for one repository, for the person whose GitHub account this
   * is: to write it if they may write it there, to read it if they may only
   * read, and none at all otherwise. Refused when the app is not installed
   * on the repository or the person has no access to it — in the same
   * words either way, so that asking tells nobody which private
   * repositories exist.
   */
  async repositoryToken(who: Pick<GithubIdentity, "id" | "login">, repo: string): Promise<RepoToken> {
    if (repoName(repo) !== repo) throw new GithubRefusal("no-access", "That is not a GitHub repository");
    const noWay = (reason: RefusalReason) =>
      new GithubRefusal(
        reason,
        `SpecDriven cannot reach ${repo}: the SpecDriven GitHub App must be installed on it, and @${who.login} must have access to it on GitHub`,
      );
    try {
      const found = await this.call(`/repos/${repo}/installation`, this.jwt());
      // Not there, or there under another name now.
      if (found.status === 404 || (found.status >= 300 && found.status < 400)) throw noWay("not-installed");
      const installation = found.ok ? ((await found.json()) as { id?: unknown }).id : null;
      if (typeof installation !== "number") throw new GithubRefusal("unavailable", `GitHub did not answer for ${repo} (HTTP ${found.status})`);

      // What the person may do there, asked with a token that can do nothing
      // but ask. The id decides: a login can pass to somebody else.
      const look = await this.mint(installation, repo, { name: repo.split("/")[1]! }, { metadata: "read" });
      let access: unknown = "none";
      try {
        const res = await this.call(`/repos/${repo}/collaborators/${encodeURIComponent(who.login)}/permission`, look.token);
        if (res.ok) {
          const level = (await res.json()) as { permission?: unknown; user?: { id?: unknown } | null };
          if (level.user?.id === who.id) access = level.permission;
        } else if (res.status !== 404 && !(res.status >= 300 && res.status < 400)) {
          throw new GithubRefusal("unavailable", `GitHub did not say what @${who.login} may do on ${repo} (HTTP ${res.status})`);
        }
      } finally {
        void this.revoke(look.token);
      }
      if (access !== "admin" && access !== "write" && access !== "read") throw noWay("no-access");
      const write = access !== "read";
      // By the id GitHub gave for the name, where it gave one: the same
      // repository as the one just asked about, whatever is renamed meanwhile.
      const which = look.repoId !== null ? { id: look.repoId } : { name: repo.split("/")[1]! };
      const made = await this.mint(installation, repo, which, { contents: write ? "write" : "read", metadata: "read" });
      return { token: made.token, expiresAt: made.expiresAt, write };
    } catch (e) {
      if (e instanceof GithubRefusal) throw e;
      throw new GithubRefusal("unavailable", `GitHub could not be reached for ${repo}: ${(e as Error).message}`);
    }
  }

  /**
   * End a repository token before its hour is up. Never fails — the hour
   * ends it anyway — but says so when GitHub did not take it.
   */
  async revoke(token: string): Promise<void> {
    try {
      const res = await this.call("/installation/token", token, { method: "DELETE" });
      await res.body?.cancel();
      // 401: gone already, by an earlier call or by its hour.
      if (!res.ok && res.status !== 401) console.error(`GitHub did not revoke a token (HTTP ${res.status}); it ends with its hour`);
    } catch (e) {
      console.error(`a token could not be revoked (${(e as Error).message}); it ends with its hour`);
    }
  }
}

// The proposals service's HTTP surface (specs/app/spec-proposals.feature.md).
// In proposals mode src/index.ts hands every /api request here instead of the
// app's route table, and this answers only its own allowlist:
//
//   GET  /api/proposals/session                   who is signed in, their quota
//   GET  /api/proposals/auth/start                → GitHub's authorize page
//   GET  /api/proposals/auth/callback             ← GitHub, then back to /
//   POST /api/proposals/logout
//   GET  /api/proposals/features                  the spec tree, read-only
//   GET  /api/proposals/features/:file            one feature file as committed
//   POST /api/proposals/features                  propose a new feature
//   POST /api/proposals/features/:file/scenarios  propose a scenario on one
//
// Every other /api route — saving, publishing, deleting, settings, sign-in to
// the app itself, agents, plugins — answers 403 PROPOSALS_REFUSAL, so nothing
// the full app can do is reachable from here. Reads serve the feature files
// alone: what the Automerge documents keep beside them (drafts) stays out.
//
// Sign-in is GitHub's browser flow with PKCE. The state nonce rides in a
// short-lived HttpOnly cookie as well as the authorize url, so a callback
// only completes in the browser that started it (no login CSRF), and the
// PKCE verifier waits server-side under the nonce's hash. The visitor's
// GitHub token is used once, to read who they are, and never stored.

import type { Database } from "bun:sqlite";
import { authorizeUrl, exchangeCode, fetchIdentity, newWebFlowSecrets } from "../auth";
import { listFeatures, listFolders, readFeature } from "../features";
import { githubApiBase } from "../github";
import { bodyOf, json } from "../http";
import { PROPOSALS_REFUSAL, type ProposalsConfig } from "../proposalsMode";
import { sourceUrl } from "../sourceUrl";
import { getLogger } from "../telemetry";
import { hashToken } from "../../gateway/crypto";
import { HOUR_MS, MINUTE_MS, RateLimiter } from "../../gateway/rateLimit";
import { clearedCookie, readSessionToken, sessionCookie, Sessions, type CookieOptions } from "../../gateway/sessions";
import { getProposer, setContributor, upsertProposer, type ProposerRow } from "./db";
import { ProposalError, type ProposalInput, type ProposalService } from "./service";

const log = getLogger("proposals");

const FLOW_TTL_MS = 10 * MINUTE_MS;
/** How long a contributor check stands before it is asked again. */
export const CONTRIBUTOR_TTL_MS = HOUR_MS;

export interface ProposalsApiOptions {
  db: Database;
  config: ProposalsConfig;
  service: ProposalService;
  /** The spec repo's clone. */
  dataDir: () => Promise<string>;
  now?: () => number;
}

export interface ProposalsApi {
  /** The answer to an /api request; null for anything else (the page routes). */
  handle(req: Request): Promise<Response | null>;
  /** Whether an account can write to the spec repo, from the cache or GitHub. */
  isContributor(user: ProposerRow): Promise<boolean>;
  sessions: Sessions;
  limiter: RateLimiter;
}

function flowCookieName(opts: CookieOptions): string {
  return opts.secure ? "__Host-sd_oauth" : "sd_oauth";
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

function flowCookie(value: string, opts: CookieOptions, maxAgeMs: number): string {
  const parts = [`${flowCookieName(opts)}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** The client's address as the platform's proxy reports it, for rate limits. */
function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

/** The account's noreply address: commits attribute to it without exposing a real email. */
export function noreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

export function createProposalsApi(opts: ProposalsApiOptions): ProposalsApi {
  const now = opts.now ?? Date.now;
  const { db, config, service } = opts;
  const sessions = new Sessions(db, now);
  const limiter = new RateLimiter(db, now);
  const cookieOpts: CookieOptions = { secure: config.publicUrl.startsWith("https://") };
  const redirectUri = `${config.publicUrl}/api/proposals/auth/callback`;

  function signedIn(req: Request): ProposerRow | null {
    const session = sessions.lookup(readSessionToken(req, cookieOpts));
    return session ? getProposer(db, session.userId) : null;
  }

  async function isContributor(user: ProposerRow): Promise<boolean> {
    if (user.contributorCheckedAt !== null && now() - user.contributorCheckedAt < CONTRIBUTOR_TTL_MS) {
      return user.contributor;
    }
    let contributor = false;
    try {
      const res = await fetch(
        `${githubApiBase()}/repos/${config.repo.owner}/${config.repo.name}/collaborators/${encodeURIComponent(user.login)}/permission`,
        { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${config.botToken}`, "User-Agent": "SpecDriven" } },
      );
      if (res.ok) {
        const body = (await res.json()) as { permission?: string; role_name?: string };
        contributor =
          ["admin", "write"].includes(body.permission ?? "") ||
          ["admin", "maintain", "write"].includes(body.role_name ?? "");
      } else if (res.status !== 404) {
        // Not cached: a GitHub hiccup must not settle the answer for an hour.
        log.warn(`contributor check for @${user.login} failed: HTTP ${res.status}`);
        return user.contributor;
      }
    } catch (e) {
      log.warn(`contributor check for @${user.login} failed: ${(e as Error).message}`);
      return user.contributor;
    }
    setContributor(db, user.id, contributor, now());
    return contributor;
  }

  async function session(req: Request): Promise<Response> {
    const user = signedIn(req);
    const base = {
      repo: { owner: config.repo.owner, name: config.repo.name, url: config.repo.url },
      sourceUrl: sourceUrl(),
      perDay: config.perDay,
    };
    if (!user) return json({ ...base, signedIn: false });
    const contributor = await isContributor(user);
    return json({
      ...base,
      signedIn: true,
      user: { login: user.login, name: user.name },
      contributor,
      banned: user.bannedAt !== null,
      quota: service.quota(user, contributor),
    });
  }

  function authStart(req: Request): Response {
    if (!limiter.hit({ key: `oauth:ip:${clientIp(req)}`, max: 20, windowMs: HOUR_MS })) {
      return json({ error: "Too many sign-in attempts — try again later" }, 429);
    }
    const { state, verifier } = newWebFlowSecrets();
    db.query("DELETE FROM oauth_flows WHERE expires_at <= ?").run(now());
    db.query("INSERT INTO oauth_flows (state_hash, verifier, expires_at) VALUES (?, ?, ?)").run(
      hashToken(state),
      verifier,
      now() + FLOW_TTL_MS,
    );
    return redirect(authorizeUrl({ redirectUri, state, verifier }), [flowCookie(state, cookieOpts, FLOW_TTL_MS)]);
  }

  async function authCallback(req: Request, url: URL): Promise<Response> {
    const back = (problem?: string) =>
      redirect(problem ? `/?signin=${encodeURIComponent(problem)}` : "/", [flowCookie("", cookieOpts, 0)]);
    const state = url.searchParams.get("state") ?? "";
    // Only the browser that started this sign-in carries its nonce.
    if (!state || readCookie(req, flowCookieName(cookieOpts)) !== state) return back("expired");
    const row = db
      .query("DELETE FROM oauth_flows WHERE state_hash = ? RETURNING verifier, expires_at AS expiresAt")
      .get(hashToken(state)) as { verifier: string; expiresAt: number } | null;
    if (!row || row.expiresAt <= now()) return back("expired");
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.get("error")) return back("denied");
    try {
      const token = await exchangeCode({ code, redirectUri, verifier: row.verifier });
      const identity = await fetchIdentity(token);
      if (!identity.id) throw new Error("GitHub reported no account id");
      const id = String(identity.id);
      upsertProposer(db, { id, email: noreplyEmail(identity.id, identity.login), login: identity.login, name: identity.name }, now());
      const sessionToken = sessions.create(id, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
      return redirect("/", [flowCookie("", cookieOpts, 0), sessionCookie(sessionToken, cookieOpts)]);
    } catch (e) {
      log.warn(`sign-in failed: ${(e as Error).message}`);
      return back("failed");
    }
  }

  function logout(req: Request): Response {
    sessions.revoke(readSessionToken(req, cookieOpts));
    const res = json({ ok: true });
    res.headers.append("Set-Cookie", clearedCookie(cookieOpts));
    return res;
  }

  async function features(): Promise<Response> {
    const dir = await opts.dataDir();
    return json({ features: await listFeatures(dir), folders: await listFolders(dir) });
  }

  async function feature(file: string): Promise<Response> {
    const dir = await opts.dataDir();
    let content: string | null = null;
    try {
      content = await readFeature(dir, file);
    } catch {
      // not a feature path at all
    }
    return content === null ? json({ error: "Feature not found" }, 404) : json({ fileName: file, content });
  }

  async function propose(req: Request, input: (body: Record<string, unknown>) => ProposalInput): Promise<Response> {
    const user = signedIn(req);
    if (!user) return json({ error: "Sign in with GitHub to propose specs" }, 401);
    let body: Record<string, unknown>;
    try {
      body = await bodyOf(req);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    try {
      const result = await service.propose(user, input(body));
      const contributor = await isContributor(user);
      return json({ ...result, quota: service.quota(user, contributor) }, 201);
    } catch (e) {
      if (e instanceof ProposalError) return json({ error: e.message }, e.status);
      log.error(`proposal by @${user.login} failed: ${(e as Error).message}`);
      return json({ error: "The proposal could not be saved — try again in a minute" }, 500);
    }
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith("/api/")) return null;
    const m = req.method;
    try {
      if (m === "GET" && path === "/api/proposals/session") return await session(req);
      if (m === "GET" && path === "/api/proposals/auth/start") return authStart(req);
      if (m === "GET" && path === "/api/proposals/auth/callback") return await authCallback(req, url);
      if (m === "POST" && path === "/api/proposals/logout") return logout(req);
      if (m === "GET" && path === "/api/proposals/features") return await features();
      if (m === "POST" && path === "/api/proposals/features") {
        return await propose(req, (b) => ({
          kind: "feature",
          folder: b.folder as string,
          name: b.name as string,
          description: (b.description as string | undefined) ?? "",
          scenario: (b.scenario ?? {}) as { name: string; body: string },
        }));
      }
      const scenarios = path.match(/^\/api\/proposals\/features\/([^/]+)\/scenarios$/);
      if (m === "POST" && scenarios) {
        const file = decodeURIComponent(scenarios[1]!);
        return await propose(req, (b) => ({ kind: "scenario", file, name: b.name as string, body: b.body as string }));
      }
      const one = path.match(/^\/api\/proposals\/features\/([^/]+)$/);
      if (m === "GET" && one) return await feature(decodeURIComponent(one[1]!));
    } catch (e) {
      log.error(`${m} ${path} failed: ${(e as Error).message}`);
      return json({ error: "Something went wrong — try again in a minute" }, 500);
    }
    return json({ error: PROPOSALS_REFUSAL }, 403);
  }

  return { handle, isContributor, sessions, limiter };
}

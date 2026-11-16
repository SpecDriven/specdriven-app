// The hosted gateway's request handling (docs/deployment-railway.md): its
// own pages and /auth/* API, and for a signed-in user everything else,
// forwarded to that user's worker. Kept apart from index.ts, which reads the
// configuration and listens, so tests can drive it with their own pieces.
//
// With an account url as well as a public one, the two halves answer on two
// hosts (docs/hosted-tenant-isolation.md "Step 2",
// specs/app/hosted-app.feature.md "The account pages have a host of their
// own"):
//
//   the account host   sign-in, the account and admin pages, /auth/*. Its
//                      session cookie is the one that can change secrets
//                      and roles.
//   the app's host     the app's pages and each person's worker. Its
//                      cookie reaches that worker and nothing else.
//
// A worker runs on a repository its person, or a teammate of theirs,
// controls, and what it answers is shown on the app's host. Script it gets
// a browser to run there finds no cookie the account host accepts, and a
// write it sends to the account host comes from another origin, which is
// refused. A signed-in browser gets from one host to the other with a code
// that works once (sessions.ts).

import type { Database } from "bun:sqlite";
import { fetchIdentity } from "../server/auth";
import type { TokenRecord } from "../server/tokenStore";
import { rejectRequest } from "../server/requestGuard";
import { Accounts, normalizeEmail } from "./accounts";
import { Admin, normalizeAllowedEntry, type Role } from "./admin";
import { appCsp, type AppCspMode } from "./appCsp";
import type { AppShell } from "./appShell";
import { ASSET_PREFIX, type GatewayAssets, type PageName } from "./assets";
import { hashToken, randomToken } from "./crypto";
import type { GithubIdentity } from "./githubApp";
import type { GithubLinks } from "./githubLinks";
import type { Mailer } from "./mail";
import { proxyToWorker } from "./proxy";
import { HOUR_MS, MINUTE_MS, RateLimiter, type Limit } from "./rateLimit";
import { GITHUB_SECRET, MAX_SECRET_LENGTH, type SecretStore } from "./secrets";
import { safeNextPath } from "./pages/next";
import {
  APP_COOKIE,
  clearedCookie,
  GITHUB_STATE_COOKIE,
  HANDOVER_COOKIE,
  HANDOVER_STATE_MS,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  Sessions,
  type CookieOptions,
  type SessionUser,
} from "./sessions";
import { WorkerUnavailableError, type WorkerAddress } from "./workers";

/** The slice of the worker pool the handler uses (workers.ts). */
export interface Workers {
  workerFor(userId: string): Promise<WorkerAddress>;
  touch(userId: string): void;
  restart(userId: string): Promise<void>;
  /** Stop the worker for good and delete the person's folder: their account is being deleted. */
  remove(userId: string, uid: number | null): Promise<void>;
}

export interface GatewayDeps {
  db: Database;
  secrets: SecretStore;
  mailer: Mailer;
  workers: Workers;
  assets: GatewayAssets;
  /** The app's frontend, served here so the workers need not bundle it (appShell.ts). */
  appShell: AppShell;
  production: boolean;
  /** e.g. https://specs.example.com; null in development (links use the request's origin). */
  publicUrl: string | null;
  /**
   * e.g. https://account.specs.example.com: the account pages' own host.
   * Absent, they share the app's.
   */
  accountUrl?: string | null;
  /** The policy on the app's own pages (appCsp.ts): enforced unless said otherwise. */
  appCsp?: AppCspMode;
  /** Who a GitHub token belongs to (src/server/auth.ts); replaced in tests. */
  githubIdentity?: (token: string) => Promise<TokenRecord>;
  /**
   * The service's own GitHub App (githubApp.ts), where it has one: a person
   * connects their GitHub account on the account page, and no token of
   * theirs is pasted or stored (docs/hosted-tenant-isolation.md "Step 3").
   */
  github?: GithubConnect | null;
  now?: () => number;
}

/** What the account page needs of the GitHub App and of who has connected (githubApp.ts, githubLinks.ts). */
export interface GithubConnect {
  app: {
    authorizeUrl(state: string, redirectUri: string): string;
    identify(code: string, redirectUri: string): Promise<GithubIdentity>;
    installUrl(): Promise<string>;
  };
  links: Pick<GithubLinks, "get" | "set" | "delete" | "ownerOf">;
}

/** How long a browser may take at GitHub before its way back is forgotten. */
const GITHUB_STATE_MS = 10 * MINUTE_MS;

export interface Gateway {
  fetch(req: Request, server?: { requestIP(req: Request): { address: string } | null }): Promise<Response>;
  sessions: Sessions;
  accounts: Accounts;
  admin: Admin;
}

/** A signed-in user and their role (admin.ts). */
type User = SessionUser & { role: Role };

type Ctx = { req: Request; url: URL; ip: string; user: User | null; token: string | null };

/** What the app's host answers for itself, beside the app's pages and the worker's API. */
const SESSION_PREFIX = "/_session/";

const PAGE_ROUTES: Record<string, PageName> = {
  "/login": "login",
  "/signup": "signup",
  "/forgot": "forgot",
  "/set-password": "set-password",
  "/account": "account",
  "/admin": "admin",
};

/** Pages for signing in, which a signed-in browser skips. */
const SIGN_IN_PAGES = new Set<PageName>(["login", "signup", "forgot"]);

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

const GENERIC_SENT = { ok: true, message: "Check your email" };
const TOO_MANY = { error: "Too many attempts — wait a while and try again" };

export function createGateway(deps: GatewayDeps): Gateway {
  const now = deps.now ?? Date.now;
  const cookieOpts: CookieOptions = { secure: deps.production };
  const sessions = new Sessions(deps.db, now);
  const limiter = new RateLimiter(deps.db, now);
  const githubIdentity = deps.githubIdentity ?? fetchIdentity;
  // Development without PUBLIC_URL: links point wherever the request came in.
  let baseUrl = deps.publicUrl ?? "http://localhost:3000";
  // Two hosts when both urls are given; the emailed links then lead to the
  // account host, where the pages they open are.
  const hosts =
    deps.publicUrl && deps.accountUrl
      ? { app: deps.publicUrl, account: deps.accountUrl, appHost: new URL(deps.publicUrl).host, accountHost: new URL(deps.accountUrl).host }
      : null;
  if (hosts) baseUrl = hosts.account;
  const accounts = new Accounts(deps.db, sessions, deps.mailer, { baseUrl: () => baseUrl, now });
  const admin = new Admin(deps.db, deps.mailer, { baseUrl: () => baseUrl, now });
  const allowedHosts = deps.publicUrl ? [new URL(deps.publicUrl).host] : ["*"];
  const shellCsp = appCsp(deps.appCsp ?? "enforce", deps.appShell.inlineScripts ?? []);

  // The secret a browser keeps through a hand-over is signed with a key of
  // this process's own. A cookie of that name which script on the app's
  // host managed to set — the real one is hidden from it, but may have
  // expired — is not one the gateway made, and is never used.
  const stateKey = randomToken();
  const signedState = (nonce: string) => `${nonce}.${hashToken(`${stateKey}|${nonce}`).slice(0, 32)}`;
  const ownState = (state: string | null): state is string => {
    const [nonce, , extra] = (state ?? "").split(".");
    return Boolean(nonce) && extra === undefined && /^[A-Za-z0-9_-]{32,64}$/.test(nonce!) && signedState(nonce!) === state;
  };

  /** `shell`: the app's own page or one of its bundled files, which carry its policy. */
  function secure(res: Response, kind: "page" | "api" | "app" | "shell"): Response {
    const h = res.headers;
    h.set("X-Content-Type-Options", "nosniff");
    if (deps.production) h.set("Strict-Transport-Security", "max-age=31536000");
    if (kind === "app" || kind === "shell") {
      if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "SAMEORIGIN");
      if (!h.has("Referrer-Policy")) h.set("Referrer-Policy", "same-origin");
      if (kind === "shell" && shellCsp) h.set(shellCsp.header, shellCsp.value);
      return res;
    }
    h.set("X-Frame-Options", "DENY");
    h.set("Referrer-Policy", "no-referrer");
    h.set("Cache-Control", "no-store");
    // No other origin embeds or reads what the gateway itself answers.
    h.set("Cross-Origin-Resource-Policy", "same-origin");
    if (kind === "page") h.set("Content-Security-Policy", PAGE_CSP);
    return res;
  }

  const redirect = (location: string, headers?: Record<string, string>) =>
    secure(new Response(null, { status: 302, headers: { Location: location, ...headers } }), "api");

  const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
    secure(Response.json(data, { status, headers }), "api");

  function signedIn(ctx: Ctx, userId: string, data: unknown = { ok: true }): Response {
    const token = sessions.create(userId, { ip: ctx.ip, userAgent: ctx.req.headers.get("user-agent") });
    return json(data, 200, { "Set-Cookie": sessionCookie(token, cookieOpts) });
  }

  async function body(req: Request): Promise<Record<string, unknown>> {
    try {
      const data = await req.json();
      return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Run mail-sending work without making the answer wait on it (accounts.ts). */
  function background(work: Promise<void>, what: string): void {
    work.catch((e) => console.error(`${what} failed: ${(e as Error).message}`));
  }

  async function me({ userId, email, role }: User) {
    const all = await deps.secrets.list(userId);
    const github = all.find((s) => s.name === GITHUB_SECRET);
    const link = deps.github?.links.get(userId) ?? null;
    return {
      email,
      role,
      github: github ? { login: github.meta.login ?? null, hint: github.hint, updatedAt: github.updatedAt } : null,
      // Present where GitHub goes through the service's app: the account
      // the person connected, and where the app is installed on a repository.
      githubApp: deps.github
        ? {
            account: link ? { login: link.login, linkedAt: link.linkedAt } : null,
            installUrl: await deps.github.app.installUrl().catch(() => null),
          }
        : null,
    };
  }

  const limits = {
    login: (ip: string, email: string): Limit[] => [
      { key: `login:ip:${ip}`, max: 30, windowMs: 15 * MINUTE_MS },
      { key: `login:email:${email}`, max: 10, windowMs: 15 * MINUTE_MS },
    ],
    signup: (ip: string, email: string): Limit[] => [
      { key: `signup:ip:${ip}`, max: 10, windowMs: HOUR_MS },
      { key: `signup:email:${email}`, max: 3, windowMs: HOUR_MS },
    ],
    forgot: (ip: string, email: string): Limit[] => [
      { key: `forgot:ip:${ip}`, max: 20, windowMs: HOUR_MS },
      { key: `forgot:email:${email}`, max: 5, windowMs: HOUR_MS },
    ],
    setPassword: (ip: string): Limit[] => [{ key: `setpw:ip:${ip}`, max: 20, windowMs: HOUR_MS }],
    user: (what: string, userId: string, max: number): Limit[] => [
      { key: `${what}:user:${userId}`, max, windowMs: HOUR_MS },
    ],
  };

  /** The /auth/* API; null when the path is none of it. */
  async function authApi(ctx: Ctx): Promise<Response | null> {
    const { req, url, ip, user } = ctx;
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "POST /auth/login": {
        const data = await body(req);
        const email = normalizeEmail(data.email);
        if (!email) return json({ error: "Enter your email and password" }, 400);
        if (!limiter.hit(...limits.login(ip, email))) return json(TOO_MANY, 429);
        const userId = await accounts.login(email, data.password);
        if (!userId) return json({ error: "Wrong email or password" }, 401);
        limiter.reset(`login:email:${email}`);
        return signedIn(ctx, userId);
      }
      case "POST /auth/logout": {
        sessions.revoke(ctx.token);
        return json({ ok: true }, 200, { "Set-Cookie": clearedCookie(cookieOpts) });
      }
      case "POST /auth/signup": {
        const email = normalizeEmail((await body(req)).email);
        if (!email) return json({ error: "Enter a valid email address" }, 400);
        if (!limiter.hit(...limits.signup(ip, email))) return json(TOO_MANY, 429);
        background(accounts.signup(email), "sign-up email");
        return json(GENERIC_SENT);
      }
      case "POST /auth/forgot": {
        const email = normalizeEmail((await body(req)).email);
        if (!email) return json({ error: "Enter a valid email address" }, 400);
        if (!limiter.hit(...limits.forgot(ip, email))) return json(TOO_MANY, 429);
        background(accounts.forgot(email), "reset email");
        return json(GENERIC_SENT);
      }
      case "POST /auth/set-password": {
        if (!limiter.hit(...limits.setPassword(ip))) return json(TOO_MANY, 429);
        const data = await body(req);
        const result = await accounts.setPassword(data.token, data.password);
        if ("error" in result) return json({ error: result.error }, 400);
        // Every older session ended with the change; a reset restarts the
        // worker too, in case someone else had it running.
        await deps.workers.restart(result.userId);
        return signedIn(ctx, result.userId);
      }
    }
    if (!url.pathname.startsWith("/auth/")) return null;
    if (route === "GET /auth/handover" && hosts) return handOver(ctx);
    // The way back from GitHub is a page load, not a call: a browser that is
    // not signed in is sent to sign in.
    if (deps.github && route === "GET /auth/github/callback") {
      if (!user) return redirect("/login?next=%2Faccount");
      return githubCallback(ctx, user, deps.github);
    }
    if (!user) return json({ error: "Sign in first" }, 401);
    // Setting out is a write: it must come from the account page itself
    // (the Origin check above), never from a link or a page somewhere else
    // that a signed-in browser was sent to.
    if (deps.github && route === "POST /auth/github/connect") return githubConnect(ctx, user, deps.github);

    if (route === "GET /auth/me") return json(await me(user));

    if (route === "POST /auth/change-password") {
      if (!limiter.hit(...limits.user("chpw", user.userId, 10))) return json(TOO_MANY, 429);
      const data = await body(req);
      const result = await accounts.changePassword(user.userId, data.current, data.password);
      if ("error" in result) return json({ error: result.error }, 400);
      return signedIn(ctx, user.userId);
    }

    if (url.pathname === "/auth/admin" || url.pathname.startsWith("/auth/admin/")) {
      if (user.role !== "admin") return json({ error: "Only admins can do this" }, 403);
      return adminApi(req, url, user);
    }

    if (deps.github && route === "DELETE /auth/github/link") {
      if (!limiter.hit(...limits.user("secrets", user.userId, 60))) return json(TOO_MANY, 429);
      deps.github.links.delete(user.userId);
      // Its worker stops, and the tokens it was given end with it (workers.ts).
      await deps.workers.restart(user.userId);
      return json({ ok: true });
    }

    if (url.pathname === "/auth/secrets/github") {
      if (req.method === "PUT" && deps.github) {
        return json({ error: "This service reaches GitHub through its app — connect GitHub instead of pasting a token" }, 400);
      }
      if (req.method === "PUT") {
        if (!limiter.hit(...limits.user("secrets", user.userId, 60))) return json(TOO_MANY, 429);
        const token = (await body(req)).token;
        if (typeof token !== "string" || !token.trim() || token.length > MAX_SECRET_LENGTH) {
          return json({ error: "Paste a GitHub token" }, 400);
        }
        let identity: TokenRecord;
        try {
          identity = await githubIdentity(token.trim());
        } catch {
          return json({ error: "GitHub did not accept this token — check it and its expiry" }, 400);
        }
        const { login, name, email, id } = identity;
        await deps.secrets.put(user.userId, GITHUB_SECRET, "github", token.trim(), { login, name, email, id });
        await deps.workers.restart(user.userId);
        return json({ ok: true, login });
      }
      if (req.method === "DELETE") {
        // Each of these stops the person's worker: not without end.
        if (!limiter.hit(...limits.user("secrets", user.userId, 60))) return json(TOO_MANY, 429);
        deps.secrets.delete(user.userId, GITHUB_SECRET);
        await deps.workers.restart(user.userId);
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  }

  // The secret a browser carries to GitHub and back is signed for the
  // account that started: a code GitHub made for someone else's sign-in, sent
  // to this browser, comes with no state this browser was given.
  const githubState = (nonce: string, userId: string) =>
    `${nonce}.${hashToken(`${stateKey}|github|${userId}|${nonce}`).slice(0, 32)}`;
  const githubCallbackUrl = () => `${baseUrl}/auth/github/callback`;

  /**
   * Where to go at GitHub to say which account there is this person's, and
   * the secret this browser must bring back with GitHub's answer.
   */
  function githubConnect(ctx: Ctx, user: User, github: GithubConnect): Response {
    if (!limiter.hit(...limits.user("github", user.userId, 30))) return json(TOO_MANY, 429);
    const state = githubState(randomToken(), user.userId);
    return json({ url: github.app.authorizeUrl(state, githubCallbackUrl()) }, 200, {
      "Set-Cookie": sessionCookie(state, cookieOpts, GITHUB_STATE_MS, GITHUB_STATE_COOKIE),
    });
  }

  /**
   * Back from GitHub with a code that stands for the account the person
   * chose there. It is kept as who they are on GitHub (githubApp.ts), the
   * token they pasted before is deleted, and their worker starts again
   * without one. Every way this ends is the account page, which says how.
   */
  async function githubCallback(ctx: Ctx, user: User, github: GithubConnect): Promise<Response> {
    const { req, url } = ctx;
    const back = (problem?: string) =>
      redirect(`/account${problem ? `?github=${problem}` : ""}`, { "Set-Cookie": clearedCookie(cookieOpts, GITHUB_STATE_COOKIE) });
    const state = url.searchParams.get("state");
    // GitHub also comes here after the app was installed on a repository,
    // with no state of ours: nothing to do but show the account page.
    if (!state && url.searchParams.has("setup_action")) return redirect("/account");
    const kept = readCookie(req, cookieOpts, GITHUB_STATE_COOKIE);
    const nonce = state?.split(".")[0] ?? "";
    if (!state || state !== kept || githubState(nonce, user.userId) !== state) return back("state");
    if (url.searchParams.has("error")) return back("cancelled");
    const code = url.searchParams.get("code");
    if (!code || code.length > 512) return back("state");
    let who: GithubIdentity;
    try {
      who = await github.app.identify(code, githubCallbackUrl());
    } catch (e) {
      console.error(`connecting GitHub for ${user.userId} failed: ${(e as Error).message}`);
      return back("failed");
    }
    // One GitHub account, one person here. Someone signed in to the wrong
    // account — sent there by another person's link — would otherwise hand
    // that account their own repositories.
    const owner = github.links.ownerOf(who.id);
    if (owner !== null && owner !== user.userId) return back("taken");
    github.links.set(user.userId, who);
    deps.secrets.delete(user.userId, GITHUB_SECRET);
    await deps.workers.restart(user.userId);
    return back();
  }

  /** The admin page's API (admin.ts), for a user the caller found to be an admin. */
  async function adminApi(req: Request, url: URL, user: User): Promise<Response> {
    if (req.method === "GET" && url.pathname === "/auth/admin") {
      return json({ you: user.userId, allowed: admin.allowed(), users: admin.users() });
    }
    if (!limiter.hit(...limits.user("admin", user.userId, 120))) return json(TOO_MANY, 429);

    if (req.method === "POST" && url.pathname === "/auth/admin/allowed") {
      const data = await body(req);
      const entry = normalizeAllowedEntry(data.email);
      if (!entry) return json({ error: "Enter an email address, or @ and a domain" }, 400);
      admin.allow(user.userId, entry);
      if (data.invite === true && !entry.startsWith("@")) {
        background(admin.invite(user.userId, entry), "invite email");
      }
      return json({ ok: true });
    }

    const allowedMatch = url.pathname.match(/^\/auth\/admin\/allowed\/([^/]+)$/);
    if (allowedMatch && req.method === "DELETE") {
      const entry = normalizeAllowedEntry(decodeURIComponent(allowedMatch[1]!));
      if (!entry || !admin.disallow(entry)) return json({ error: "That is not on the list" }, 404);
      return json({ ok: true });
    }

    const roleMatch = url.pathname.match(/^\/auth\/admin\/users\/([^/]+)\/role$/);
    if (roleMatch && req.method === "PUT") {
      const role = (await body(req)).role;
      if (role !== "admin" && role !== "user") return json({ error: "The role is admin or user" }, 400);
      const result = admin.setRole(decodeURIComponent(roleMatch[1]!), role);
      if ("error" in result) return json({ error: result.error }, 400);
      return json({ ok: true });
    }

    // Delete an account: sign it out first, so nothing starts its worker
    // again, then stop the worker and delete the folder; the row goes last,
    // and only once the folder is gone, as its uid goes to the next account.
    const userMatch = url.pathname.match(/^\/auth\/admin\/users\/([^/]+)$/);
    if (userMatch && req.method === "DELETE") {
      const id = decodeURIComponent(userMatch[1]!);
      const check = admin.canDelete(user.userId, id);
      if ("error" in check) return json({ error: check.error }, check.error === "There is no such account" ? 404 : 400);
      sessions.revokeAll(id);
      try {
        await deps.workers.remove(id, check.uid);
      } catch (e) {
        console.error(`deleting the folder of ${id} failed: ${(e as Error).message}`);
        return json({ error: "Their files could not be deleted, so the account is kept, signed out. Try again." }, 500);
      }
      if (!admin.deleteUser(id)) return json({ error: "There is no such account" }, 404);
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }

  function clientIp(req: Request, server?: Parameters<Gateway["fetch"]>[1]): string {
    // Railway's edge appends the address it saw; the rightmost entry is the
    // one a client cannot forge.
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const last = forwarded.split(",").pop()?.trim();
      if (last) return last;
    }
    return server?.requestIP(req)?.address ?? "unknown";
  }

  /** The path asked for, as a `?next=` value; nothing for the app's front page. */
  function nextOf(url: URL): string {
    return url.pathname === "/" ? "" : `?next=${encodeURIComponent(url.pathname + url.search)}`;
  }

  /**
   * The account host's half of a hand-over: a signed-in browser is sent
   * back to the app's host with a code that works once; any other signs in
   * first and comes back here.
   */
  function handOver(ctx: Ctx): Response {
    const state = ctx.url.searchParams.get("state");
    if (!ownState(state)) return json({ error: "This link is incomplete" }, 400);
    const code = sessions.issueHandover(ctx.token, state);
    if (!code) return redirect(`/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
    const next = safeNextPath(ctx.url.searchParams.get("next"), hosts!.app);
    return redirect(`${hosts!.app}${SESSION_PREFIX}handover?code=${code}&next=${encodeURIComponent(next)}`);
  }

  /**
   * The app host's half: the code and the secret in this browser's cookie
   * make an app session. The cookie stays for its few minutes, so every tab
   * that was sent off together comes back signed in.
   */
  function takeOver(ctx: Ctx): Response {
    const next = safeNextPath(ctx.url.searchParams.get("next"), hosts!.app);
    const state = readCookie(ctx.req, cookieOpts, HANDOVER_COOKIE);
    const token = sessions.redeemHandover(ctx.url.searchParams.get("code"), ownState(state) ? state : null, {
      ip: ctx.ip,
      userAgent: ctx.req.headers.get("user-agent"),
    });
    if (!token) {
      // No way on from here by itself: a browser that keeps no cookie would
      // go round for ever.
      const page = `<!doctype html><meta charset="utf-8"><title>SpecDriven</title><p>Signing in did not finish. <a href="/">Try again</a>.</p>`;
      return secure(new Response(page, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }), "page");
    }
    return redirect(next, { "Set-Cookie": sessionCookie(token, cookieOpts, undefined, APP_COOKIE) });
  }

  /** The gateway's own pages and the /auth/* API; null when the path is neither. */
  async function ownPages(ctx: Ctx): Promise<Response | null> {
    const { req, url, user } = ctx;
    if (req.method === "GET" && url.pathname.startsWith(ASSET_PREFIX)) {
      const asset = deps.assets.file(url.pathname);
      if (!asset) return secure(new Response("Not Found", { status: 404 }), "api");
      return secure(
        new Response(asset.body, {
          headers: { "Content-Type": asset.type, "Cache-Control": "public, max-age=31536000, immutable" },
        }),
        "app",
      );
    }
    const page = PAGE_ROUTES[url.pathname];
    if (page && req.method === "GET") {
      // Signed in already: the sign-in pages lead on to the app.
      if (user && SIGN_IN_PAGES.has(page)) return redirect("/");
      // The admin page is for admins only (admin.ts).
      if (page === "admin" && user?.role !== "admin") {
        if (!user) return redirect("/login?next=%2Fadmin");
        const refused = new Response("Only admins can open this page.", {
          status: 403,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
        return secure(refused, "page");
      }
      const asset = deps.assets.page(page);
      return secure(new Response(asset.body, { headers: { "Content-Type": asset.type } }), "page");
    }
    return authApi(ctx);
  }

  /** What the app's host answers about the session itself: who is signed in, and signing out. */
  function sessionApi(ctx: Ctx): Response | null {
    const route = `${ctx.req.method} ${ctx.url.pathname}`;
    if (!ctx.url.pathname.startsWith(SESSION_PREFIX)) return null;
    // The email and the role, and nothing else of the account: this is the
    // host a worker's answers are shown on.
    if (route === `GET ${SESSION_PREFIX}me`) {
      return ctx.user ? json({ email: ctx.user.email, role: ctx.user.role }) : json({ error: "Sign in first" }, 401);
    }
    if (route === `POST ${SESSION_PREFIX}logout`) {
      if (hosts) sessions.revokeWithSignIn(ctx.token);
      else sessions.revoke(ctx.token);
      return json({ ok: true }, 200, { "Set-Cookie": clearedCookie(cookieOpts, hosts ? APP_COOKIE : SESSION_COOKIE) });
    }
    return json({ error: "Not found" }, 404);
  }

  /** The app for a signed-in user: its pages from the gateway, the rest from their worker. */
  async function app(ctx: Ctx, user: User): Promise<Response> {
    const { req, url } = ctx;
    const shell = await deps.appShell.serve(req, url);
    if (shell) return secure(shell, "shell");
    try {
      const worker = await deps.workers.workerFor(user.userId);
      const res = await proxyToWorker(req, worker, cookieOpts);
      deps.workers.touch(user.userId);
      return secure(res, "app");
    } catch (e) {
      if (e instanceof WorkerUnavailableError) return json({ error: e.message }, 503);
      if ((e as Error).name === "AbortError") return new Response(null, { status: 499 });
      console.error(`proxy for ${user.userId} failed: ${(e as Error).message}`);
      return json({ error: "Your workspace did not answer — try again" }, 502);
    }
  }

  const wantsPage = (req: Request) => req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");

  function userOf(req: Request, cookie: string, kind: "account" | "app"): { user: User | null; token: string | null } {
    const token = readCookie(req, cookieOpts, cookie);
    const session = sessions.lookup(token, kind);
    return { token, user: session ? { ...session, role: admin.roleOf(session.userId) } : null };
  }

  async function handle(req: Request, server?: Parameters<Gateway["fetch"]>[1]): Promise<Response> {
    const url = new URL(req.url);
    // The platform's health check comes from its own host name.
    if (url.pathname === "/healthz") return new Response("ok");
    // Browsers ask for it on every page, the sign-in pages included.
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (!deps.publicUrl) baseUrl = url.origin;

    // Which half this request is for. A write must come from the page's own
    // origin (below), so nothing shown on the app's host can write to the
    // account host.
    const host = (req.headers.get("host") ?? "").toLowerCase();
    const side = !hosts ? "both" : host === hosts.accountHost ? "account" : "app";

    // Host, Origin and body type, the app's own trust boundary
    // (src/server/requestGuard.ts), checked here for everything.
    const refused = rejectRequest(req, side === "account" ? [hosts!.accountHost] : allowedHosts);
    if (refused) {
      // Another name for this service, such as its *.up.railway.app domain
      // once PUBLIC_URL names a custom one: a page load moves to the same
      // path on PUBLIC_URL. A GET or HEAD is refused only for its Host.
      if (deps.publicUrl && (req.method === "GET" || req.method === "HEAD")) {
        const location = `${deps.publicUrl}${url.pathname}${url.search}`;
        return secure(new Response(null, { status: 301, headers: { Location: location } }), "api");
      }
      return secure(refused, "api");
    }
    const ip = clientIp(req, server);

    if (side === "account") {
      const ctx: Ctx = { req, url, ip, ...userOf(req, SESSION_COOKIE, "account") };
      const own = await ownPages(ctx);
      if (own) return own;
      // Everything else lives on the app's host.
      if (req.method === "GET" || req.method === "HEAD") return redirect(`${hosts!.app}${url.pathname}${url.search}`);
      return json({ error: "Not found" }, 404);
    }

    if (side === "app") {
      // The account pages, and links to them from before they moved: the
      // browser keeps a link's #token across the redirect.
      if (PAGE_ROUTES[url.pathname] && (req.method === "GET" || req.method === "HEAD")) {
        return redirect(`${hosts!.account}${url.pathname}${url.search}`);
      }
      // Nothing of the account is served here, to any session.
      if (url.pathname.startsWith("/auth/") || url.pathname.startsWith(ASSET_PREFIX)) return json({ error: "Not found" }, 404);
      if (req.method === "GET" && url.pathname === `${SESSION_PREFIX}handover`) {
        return takeOver({ req, url, ip, user: null, token: null });
      }
      const ctx: Ctx = { req, url, ip, ...userOf(req, APP_COOKIE, "app") };
      const session = sessionApi(ctx);
      if (session) return session;
      if (ctx.user) return app(ctx, ctx.user);
      if (!wantsPage(req)) return json({ error: "Sign in first" }, 401);
      // Off to the account host for a code, with a secret left in this
      // browser that the code will only work together with.
      const kept = readCookie(req, cookieOpts, HANDOVER_COOKIE);
      const state = ownState(kept) ? kept : signedState(randomToken());
      const next = nextOf(url).replace("?", "&");
      return redirect(`${hosts!.account}/auth/handover?state=${state}${next}`, {
        "Set-Cookie": sessionCookie(state, cookieOpts, HANDOVER_STATE_MS, HANDOVER_COOKIE),
      });
    }

    // One host for both halves.
    const ctx: Ctx = { req, url, ip, ...userOf(req, SESSION_COOKIE, "account") };
    const own = await ownPages(ctx);
    if (own) return own;
    const session = sessionApi(ctx);
    if (session) return session;
    if (ctx.user) return app(ctx, ctx.user);
    if (wantsPage(req)) return redirect(`/login${nextOf(url)}`);
    return json({ error: "Sign in first" }, 401);
  }

  return { fetch: handle, sessions, accounts, admin };
}

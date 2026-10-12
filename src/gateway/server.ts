// The hosted gateway's request handling (docs/deployment-railway.md): its
// own pages and /auth/* API, and for a signed-in user everything else,
// forwarded to that user's worker. Kept apart from index.ts, which reads the
// configuration and listens, so tests can drive it with their own pieces.

import type { Database } from "bun:sqlite";
import { fetchIdentity } from "../server/auth";
import type { TokenRecord } from "../server/tokenStore";
import { rejectRequest } from "../server/requestGuard";
import { Accounts, normalizeEmail } from "./accounts";
import { Admin, normalizeAllowedEntry, type Role } from "./admin";
import type { AppShell } from "./appShell";
import { ASSET_PREFIX, type GatewayAssets, type PageName } from "./assets";
import type { Mailer } from "./mail";
import { proxyToWorker } from "./proxy";
import { HOUR_MS, MINUTE_MS, RateLimiter, type Limit } from "./rateLimit";
import {
  agentKeyNameProblem,
  GITHUB_SECRET,
  MAX_AGENT_KEYS,
  MAX_SECRET_LENGTH,
  type SecretStore,
} from "./secrets";
import {
  clearedCookie,
  readSessionToken,
  sessionCookie,
  Sessions,
  type CookieOptions,
  type SessionUser,
} from "./sessions";
import { WorkerUnavailableError } from "./workers";

/** The slice of the worker pool the handler uses (workers.ts). */
export interface Workers {
  socketFor(userId: string): Promise<string>;
  touch(userId: string): void;
  restart(userId: string): Promise<void>;
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
  /** Who a GitHub token belongs to (src/server/auth.ts); replaced in tests. */
  githubIdentity?: (token: string) => Promise<TokenRecord>;
  now?: () => number;
}

export interface Gateway {
  fetch(req: Request, server?: { requestIP(req: Request): { address: string } | null }): Promise<Response>;
  sessions: Sessions;
  accounts: Accounts;
  admin: Admin;
}

/** A signed-in user and their role (admin.ts). */
type User = SessionUser & { role: Role };

type Ctx = { req: Request; url: URL; ip: string; user: User | null; token: string | null };

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
  const accounts = new Accounts(deps.db, sessions, deps.mailer, { baseUrl: () => baseUrl, now });
  const admin = new Admin(deps.db, deps.mailer, { baseUrl: () => baseUrl, now });
  const allowedHosts = deps.publicUrl ? [new URL(deps.publicUrl).host] : ["*"];

  function secure(res: Response, kind: "page" | "api" | "app"): Response {
    const h = res.headers;
    h.set("X-Content-Type-Options", "nosniff");
    if (deps.production) h.set("Strict-Transport-Security", "max-age=31536000");
    if (kind === "app") {
      if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "SAMEORIGIN");
      if (!h.has("Referrer-Policy")) h.set("Referrer-Policy", "same-origin");
      return res;
    }
    h.set("X-Frame-Options", "DENY");
    h.set("Referrer-Policy", "no-referrer");
    h.set("Cache-Control", "no-store");
    if (kind === "page") h.set("Content-Security-Policy", PAGE_CSP);
    return res;
  }

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
    return {
      email,
      role,
      github: github ? { login: github.meta.login ?? null, hint: github.hint, updatedAt: github.updatedAt } : null,
      agentKeys: all
        .filter((s) => s.kind === "agent_key")
        .map((s) => ({ name: s.name, hint: s.hint, updatedAt: s.updatedAt })),
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
    if (!user) return json({ error: "Sign in first" }, 401);

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

    if (url.pathname === "/auth/secrets/github") {
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
        deps.secrets.delete(user.userId, GITHUB_SECRET);
        await deps.workers.restart(user.userId);
        return json({ ok: true });
      }
    }

    const keyMatch = url.pathname.match(/^\/auth\/secrets\/agent-keys\/([^/]+)$/);
    if (keyMatch) {
      const name = decodeURIComponent(keyMatch[1]!);
      const problem = agentKeyNameProblem(name);
      if (problem) return json({ error: problem }, 400);
      if (req.method === "PUT") {
        if (!limiter.hit(...limits.user("secrets", user.userId, 60))) return json(TOO_MANY, 429);
        const value = (await body(req)).value;
        if (typeof value !== "string" || !value.trim() || value.length > MAX_SECRET_LENGTH) {
          return json({ error: "Paste the key" }, 400);
        }
        const exists = (await deps.secrets.list(user.userId)).some((s) => s.name === name);
        if (!exists && deps.secrets.agentKeyCount(user.userId) >= MAX_AGENT_KEYS) {
          return json({ error: `At most ${MAX_AGENT_KEYS} keys` }, 400);
        }
        await deps.secrets.put(user.userId, name, "agent_key", value.trim());
        await deps.workers.restart(user.userId);
        return json({ ok: true });
      }
      if (req.method === "DELETE") {
        deps.secrets.delete(user.userId, name);
        await deps.workers.restart(user.userId);
        return json({ ok: true });
      }
    }
    return json({ error: "Not found" }, 404);
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

  async function handle(req: Request, server?: Parameters<Gateway["fetch"]>[1]): Promise<Response> {
    const url = new URL(req.url);
    // The platform's health check comes from its own host name.
    if (url.pathname === "/healthz") return new Response("ok");
    // Browsers ask for it on every page, the sign-in pages included.
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (!deps.publicUrl) baseUrl = url.origin;

    // Host, Origin and body type, the app's own trust boundary
    // (src/server/requestGuard.ts), checked here for everything.
    const refused = rejectRequest(req, allowedHosts);
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

    const token = readSessionToken(req, cookieOpts);
    const session = sessions.lookup(token);
    const user = session ? { ...session, role: admin.roleOf(session.userId) } : null;
    const ctx: Ctx = { req, url, ip: clientIp(req, server), user, token };

    const page = PAGE_ROUTES[url.pathname];
    if (page && req.method === "GET") {
      // Signed in already: the sign-in pages lead on to the app.
      if (user && SIGN_IN_PAGES.has(page)) {
        return secure(new Response(null, { status: 302, headers: { Location: "/" } }), "api");
      }
      // The admin page is for admins only (admin.ts).
      if (page === "admin" && user?.role !== "admin") {
        if (!user) {
          return secure(new Response(null, { status: 302, headers: { Location: "/login?next=%2Fadmin" } }), "api");
        }
        const refused = new Response("Only admins can open this page.", {
          status: 403,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
        return secure(refused, "page");
      }
      const asset = deps.assets.page(page);
      return secure(new Response(asset.body, { headers: { "Content-Type": asset.type } }), "page");
    }

    const auth = await authApi(ctx);
    if (auth) return auth;

    if (!user) {
      const wantsPage = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
      if (wantsPage) {
        const next = url.pathname === "/" ? "" : `?next=${encodeURIComponent(url.pathname + url.search)}`;
        return secure(new Response(null, { status: 302, headers: { Location: `/login${next}` } }), "api");
      }
      return json({ error: "Sign in first" }, 401);
    }

    const shell = await deps.appShell.serve(req, url);
    if (shell) return secure(shell, "app");

    try {
      const socket = await deps.workers.socketFor(user.userId);
      const res = await proxyToWorker(req, socket, cookieOpts);
      deps.workers.touch(user.userId);
      return secure(res, "app");
    } catch (e) {
      if (e instanceof WorkerUnavailableError) return json({ error: e.message }, 503);
      if ((e as Error).name === "AbortError") return new Response(null, { status: 499 });
      console.error(`proxy for ${user.userId} failed: ${(e as Error).message}`);
      return json({ error: "Your workspace did not answer — try again" }, 502);
    }
  }

  return { fetch: handle, sessions, accounts, admin };
}

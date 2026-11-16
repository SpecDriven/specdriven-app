// specs/app/hosted-app.feature.md "The account pages have a host of their
// own": with ACCOUNT_URL set the gateway answers on two hosts
// (src/gateway/server.ts). Sign-in, the account page, the admin page and
// /auth/* are on the account host; the app and each person's worker on the
// app's. A signed-in browser gets from one to the other with a code that
// works once (src/gateway/sessions.ts), and the app host's cookie reaches
// the worker and nothing else.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCsp, inlineScriptHashes, readAppCspMode } from "../src/gateway/appCsp";
import { isWorkerPath } from "../src/gateway/appShell";
import { buildAssets, type GatewayAssets } from "../src/gateway/assets";
import { readConfig } from "../src/gateway/config";
import { generateMasterKey, loadKeyring } from "../src/gateway/crypto";
import { exportSnapshot } from "../src/gateway/datastore";
import { openDatabase } from "../src/gateway/db";
import type { Mail } from "../src/gateway/mail";
import { SecretStore } from "../src/gateway/secrets";
import { createGateway, type Gateway } from "../src/gateway/server";
import {
  APP_COOKIE,
  clearedCookie,
  cookieName,
  cookiesWithout,
  HANDOVER_CODE_MS,
  HANDOVER_COOKIE,
  HANDOVER_STATE_MS,
  readCookie,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  sessionCookie,
} from "../src/gateway/sessions";

const APP = "https://specs.example.com";
const ACCOUNT = "https://account.specs.example.com";
const PASSWORD = "correct horse battery";
const DAY = 24 * 60 * 60 * 1000;
const SHELL = `<!doctype html><title>app</title><script>var t = 1;</script><script type="module" src="/_app/main.js"></script>`;

let dir: string;
let db: ReturnType<typeof openDatabase>;
let assets: GatewayAssets;
let gateway: Gateway;
let sent: Mail[];
let seen: Request[];
let clock: number;
let worker: ReturnType<typeof Bun.serve>;
let socket: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gwh-"));
  assets = await buildAssets(false);
  socket = join(dir, "worker.sock");
  // One stand-in worker: it says what reached it.
  worker = Bun.serve({
    unix: socket,
    fetch: (req) => {
      seen.push(req);
      return Response.json({ path: new URL(req.url).pathname, cookie: req.headers.get("cookie") });
    },
  });
});

afterAll(async () => {
  worker.stop(true);
  await rm(dir, { recursive: true, force: true });
});

async function makeGateway(over: Partial<Parameters<typeof createGateway>[0]> = {}): Promise<Gateway> {
  db = openDatabase(":memory:");
  db.query("INSERT INTO allowed_emails (email, created_at) VALUES ('@example.com', 0)").run();
  return createGateway({
    db,
    secrets: new SecretStore(db, await loadKeyring({ SPECDRIVEN_MASTER_KEY: generateMasterKey() })),
    mailer: { send: async (m) => void sent.push(m) },
    workers: { workerFor: async () => ({ socket, key: "k" }), touch: () => {}, restart: async () => {} },
    assets,
    appShell: {
      inlineScripts: inlineScriptHashes(SHELL),
      serve: async (req, url) => (req.method === "GET" && !isWorkerPath(url.pathname) ? new Response(SHELL) : null),
    },
    production: true,
    publicUrl: APP,
    accountUrl: ACCOUNT,
    now: () => clock,
    ...over,
  });
}

beforeEach(async () => {
  sent = [];
  seen = [];
  clock = Date.UTC(2026, 10, 15);
  gateway = await makeGateway();
});

/** A request to one of the two hosts, as a browser sends it. */
function call(origin: string, path: string, init: RequestInit & { cookie?: string; from?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(origin).host);
  if (init.body !== undefined || (init.method && init.method !== "GET")) headers.set("origin", init.from ?? origin);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return gateway.fetch(new Request(`${origin}${path}`, { ...init, headers }));
}

const page = (origin: string, path: string, cookie?: string) => call(origin, path, { cookie, headers: { accept: "text/html" } });
const post = (origin: string, path: string, data: unknown, cookie?: string, from?: string) =>
  call(origin, path, { method: "POST", body: JSON.stringify(data), cookie, from });

/** The cookie a response sets, as the browser would send it back. */
function cookieOf(res: Response, name: string): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!set) throw new Error(`no ${name} cookie in ${res.headers.getSetCookie().join(" | ")}`);
  return set.split(";")[0]!;
}

/** An account, signed in on the account host: its sign-in cookie. */
async function signUp(email: string): Promise<string> {
  await post(ACCOUNT, "/auth/signup", { email });
  await Bun.sleep(0);
  const token = sent.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
  const res = await post(ACCOUNT, "/auth/set-password", { token, password: PASSWORD });
  expect(res.status).toBe(200);
  return cookieOf(res, "__Host-sd_session");
}

/** Walk a signed-in browser from the app's host to the account host and back: its app cookie, and where it lands. */
async function handOver(signIn: string, path = "/features/billing?tab=2") {
  const away = await page(APP, path);
  const state = cookieOf(away, "__Host-sd_handover");
  const back = await page(ACCOUNT, new URL(away.headers.get("location")!).pathname + new URL(away.headers.get("location")!).search, signIn);
  const location = new URL(back.headers.get("location")!);
  const arrived = await page(APP, location.pathname + location.search, state);
  return { away, state, back, location, arrived };
}

test("signed out, the app's host sends a page to the account host to sign in, and refuses the API", async () => {
  const away = await page(APP, "/features/billing?tab=2");
  expect(away.status).toBe(302);
  const to = new URL(away.headers.get("location")!);
  expect(to.origin).toBe(ACCOUNT);
  expect(to.pathname).toBe("/auth/handover");
  expect(to.searchParams.get("next")).toBe("/features/billing?tab=2");
  // The secret this browser keeps for the way back: not readable by script.
  const cookie = away.headers.getSetCookie().find((c) => c.startsWith("__Host-sd_handover="))!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(to.searchParams.get("state")).toBe(cookie.split(";")[0]!.split("=")[1]!);

  // Not signed in on the account host either: sign in, then come back here.
  const signIn = await page(ACCOUNT, to.pathname + to.search);
  expect(signIn.status).toBe(302);
  const login = new URL(signIn.headers.get("location")!, ACCOUNT);
  expect(login.pathname).toBe("/login");
  expect(login.searchParams.get("next")).toBe(to.pathname + to.search);

  expect((await call(APP, "/api/state")).status).toBe(401);
  expect(seen).toEqual([]);
});

test("a signed-in browser is handed over with a code and lands on the page it asked for, with a cookie of the app host's own", async () => {
  const signIn = await signUp("a@example.com");
  const { back, location, arrived } = await handOver(signIn);
  expect(back.status).toBe(302);
  expect(location.origin).toBe(APP);
  expect(location.pathname).toBe("/_session/handover");
  expect(arrived.status).toBe(302);
  expect(arrived.headers.get("location")).toBe("/features/billing?tab=2");
  const appCookie = arrived.headers.getSetCookie().find((c) => c.startsWith("__Host-sd_app="))!;
  expect(appCookie).toContain("HttpOnly");
  expect(appCookie).toContain("SameSite=Lax");
  // Nothing on the way is kept by a browser or a proxy.
  for (const res of [back, arrived]) expect(res.headers.get("cache-control")).toBe("no-store");
  expect(arrived.headers.get("referrer-policy")).toBe("no-referrer");

  const app = cookieOf(arrived, "__Host-sd_app");
  expect((await page(APP, "/features/billing", app)).status).toBe(200);
  const api = await call(APP, "/api/state", { cookie: `${app}; theme=dark; __Host-sd_handover=x` });
  expect(api.status).toBe(200);
  // The worker is handed neither of the gateway's cookies.
  expect(((await api.json()) as { cookie: string }).cookie).toBe("theme=dark");
});

test("the app host's cookie reaches the worker and nothing else; the sign-in cookie means nothing on the app's host", async () => {
  const signIn = await signUp("a@example.com");
  const app = cookieOf((await handOver(signIn)).arrived, "__Host-sd_app");
  const appToken = app.split("=")[1]!;

  // On the app's host: who is signed in, and that is all of the account there is.
  const me = await call(APP, "/_session/me", { cookie: app });
  expect(await me.json()).toEqual({ email: "a@example.com", role: "user" });
  for (const path of ["/auth/me", "/auth/admin", "/auth/secrets/github", "/_gw/main.js"]) {
    expect((await call(APP, path, { cookie: app })).status).toBe(404);
  }
  expect((await post(APP, "/auth/secrets/agent-keys/anthropic", { value: "sk" }, app)).status).toBe(404);
  expect(seen.map((r) => new URL(r.url).pathname)).toEqual([]);

  // On the account host the app's token is no sign-in, under either cookie's name.
  for (const cookie of [app, `__Host-sd_session=${appToken}`]) {
    expect((await call(ACCOUNT, "/auth/me", { cookie })).status).toBe(401);
    expect((await post(ACCOUNT, "/auth/secrets/agent-keys/anthropic", { value: "sk" }, cookie)).status).toBe(401);
  }
  // And the sign-in's token is no app session.
  for (const cookie of [signIn, `__Host-sd_app=${signIn.split("=")[1]}`]) {
    expect((await call(APP, "/api/state", { cookie })).status).toBe(401);
    expect((await call(APP, "/_session/me", { cookie })).status).toBe(401);
  }
});

test("script shown on the app's host cannot write to the account host, with the person's cookies or without", async () => {
  const signIn = await signUp("boss@example.com");
  db.query("UPDATE users SET role = 'admin' WHERE email = 'boss@example.com'").run();
  // The browser sends the sign-in cookie along — the two hosts are one site —
  // and says where the request came from.
  const allow = await post(ACCOUNT, "/auth/admin/allowed", { email: "@evil.example" }, signIn, APP);
  expect(allow.status).toBe(403);
  const role = await call(ACCOUNT, "/auth/admin/users/x/role", { method: "PUT", body: JSON.stringify({ role: "admin" }), cookie: signIn, from: APP });
  expect(role.status).toBe(403);
  // A form post, which a browser sends without asking first, is refused for its body type as well.
  const form = await gateway.fetch(
    new Request(`${ACCOUNT}/auth/logout`, {
      method: "POST",
      body: "a=b",
      headers: { host: new URL(ACCOUNT).host, origin: APP, "content-type": "application/x-www-form-urlencoded", cookie: signIn },
    }),
  );
  expect(form.status).toBe(403);
  expect((await call(ACCOUNT, "/auth/me", { cookie: signIn })).status).toBe(200);
  // What the account host answers is not for another origin to embed or read.
  const me = await call(ACCOUNT, "/auth/me", { cookie: signIn });
  expect(me.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(me.headers.get("access-control-allow-origin")).toBeNull();
  // The same write from the account host's own page goes through.
  expect((await post(ACCOUNT, "/auth/admin/allowed", { email: "@partner.example" }, signIn)).status).toBe(200);
});

test("a hand-over code works once, only with the secret in the browser it was made for, and for a minute", async () => {
  const signIn = await signUp("a@example.com");
  const first = await handOver(signIn);
  expect(first.arrived.status).toBe(302);
  // Used: the same link again signs nobody in.
  const again = await page(APP, first.location.pathname + first.location.search, first.state);
  expect(again.status).toBe(400);
  expect(again.headers.getSetCookie()).toEqual([]);
  expect(await again.text()).toContain("Signing in did not finish");

  // A code made for one browser, fed to another: that browser has another secret, or none.
  const victim = cookieOf(await page(APP, "/"), "__Host-sd_handover");
  const attacker = await page(APP, "/");
  const made = await page(ACCOUNT, new URL(attacker.headers.get("location")!).pathname + new URL(attacker.headers.get("location")!).search, signIn);
  const link = new URL(made.headers.get("location")!);
  expect((await page(APP, link.pathname + link.search, victim)).status).toBe(400);
  expect((await page(APP, link.pathname + link.search)).status).toBe(400);
  // Tried with the wrong secret, the code is spent for the right one too.
  expect((await page(APP, link.pathname + link.search, cookieOf(attacker, "__Host-sd_handover"))).status).toBe(400);

  // Left for more than a minute, it is too old.
  const slow = await page(APP, "/");
  const slowBack = await page(ACCOUNT, new URL(slow.headers.get("location")!).pathname + new URL(slow.headers.get("location")!).search, signIn);
  clock += HANDOVER_CODE_MS + 1;
  const late = new URL(slowBack.headers.get("location")!);
  expect((await page(APP, late.pathname + late.search, cookieOf(slow, "__Host-sd_handover"))).status).toBe(400);
  // Codes are kept as hashes, like every other token.
  const fresh = await page(APP, "/");
  const freshBack = await page(ACCOUNT, new URL(fresh.headers.get("location")!).pathname + new URL(fresh.headers.get("location")!).search, signIn);
  const code = new URL(freshBack.headers.get("location")!).searchParams.get("code")!;
  const rows = db.query("SELECT code_hash, state_hash FROM handover_codes").all() as { code_hash: string; state_hash: string }[];
  expect(JSON.stringify(rows)).not.toContain(code);
});

// The real secret is hidden from script, but it lasts minutes: once it is
// gone, script on the app's host can set a cookie of that name itself.
test("a hand-over secret the gateway did not make is never used", async () => {
  const signIn = await signUp("a@example.com");
  const planted = "__Host-sd_handover=" + "p".repeat(43);
  // Starting a hand-over with it: a fresh secret takes its place.
  const away = await page(APP, "/", planted);
  const fresh = cookieOf(away, "__Host-sd_handover");
  expect(fresh).not.toBe(planted);
  expect(new URL(away.headers.get("location")!).searchParams.get("state")).toBe(fresh.split("=")[1]!);
  // Asking the account host for a code against it: none is made.
  expect((await page(ACCOUNT, `/auth/handover?state=${"p".repeat(43)}&next=/`, signIn)).status).toBe(400);
  // Nor against one that only looks signed.
  expect((await page(ACCOUNT, `/auth/handover?state=${"p".repeat(43)}.${"0".repeat(32)}&next=/`, signIn)).status).toBe(400);
  expect(db.query("SELECT COUNT(*) AS n FROM handover_codes").get()).toEqual({ n: 0 });
  // And a code made the right way is not redeemed against a planted cookie.
  const back = await page(ACCOUNT, new URL(away.headers.get("location")!).pathname + new URL(away.headers.get("location")!).search, signIn);
  const link = new URL(back.headers.get("location")!);
  expect((await page(APP, link.pathname + link.search, planted)).status).toBe(400);
});

test("several tabs sent off together all come back signed in", async () => {
  const signIn = await signUp("a@example.com");
  const one = await page(APP, "/features/a");
  const state = cookieOf(one, "__Host-sd_handover");
  // The second tab's request already carries the first one's secret, and keeps it.
  const two = await page(APP, "/features/b", state);
  expect(cookieOf(two, "__Host-sd_handover")).toBe(state);
  for (const [tab, path] of [[one, "/features/a"], [two, "/features/b"]] as const) {
    const to = new URL(tab.headers.get("location")!);
    const back = new URL((await page(ACCOUNT, to.pathname + to.search, signIn)).headers.get("location")!);
    const arrived = await page(APP, back.pathname + back.search, state);
    expect(arrived.status).toBe(302);
    expect(arrived.headers.get("location")).toBe(path);
  }
});

test("where to land after a hand-over is a path on the app's host, whatever the link says", async () => {
  const signIn = await signUp("a@example.com");
  for (const next of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
    const state = cookieOf(await page(APP, "/"), "__Host-sd_handover").split("=")[1]!;
    const back = await page(ACCOUNT, `/auth/handover?state=${state}&next=${encodeURIComponent(next)}`, signIn);
    const link = new URL(back.headers.get("location")!);
    expect(link.origin).toBe(APP);
    const arrived = await page(APP, link.pathname + link.search, `__Host-sd_handover=${state}`);
    expect(new URL(arrived.headers.get("location")!, APP).origin).toBe(APP);
  }
  // A link with no secret, or one that is not one, makes no code.
  expect((await page(ACCOUNT, "/auth/handover?next=/", signIn)).status).toBe(400);
  expect((await page(ACCOUNT, "/auth/handover?state=short", signIn)).status).toBe(400);
  expect(db.query("SELECT COUNT(*) AS n FROM handover_codes").get()).toEqual({ n: 0 });
});

test("each host serves its own half and points to the other for the rest", async () => {
  const signIn = await signUp("a@example.com");
  const app = cookieOf((await handOver(signIn)).arrived, "__Host-sd_app");
  // The account pages, and links to them from before they moved.
  for (const path of ["/login", "/signup?email=a%40example.com", "/forgot", "/set-password", "/account", "/admin"]) {
    for (const cookie of [undefined, app]) {
      const res = await page(APP, path, cookie);
      expect([path, res.status, res.headers.get("location")]).toEqual([path, 302, `${ACCOUNT}${path}`]);
    }
  }
  // The account host has the pages, and sends everything else to the app.
  expect((await page(ACCOUNT, "/account", signIn)).status).toBe(200);
  expect(await (await page(ACCOUNT, "/login")).text()).toContain("<form");
  const script = (await (await page(ACCOUNT, "/login")).text()).match(/src="(\/_gw\/[^"]+\.js)"/)![1]!;
  expect((await call(ACCOUNT, script)).status).toBe(200);
  for (const path of ["/", "/features/billing?tab=2", "/api/state", "/plugins/notes/client.js"]) {
    const res = await page(ACCOUNT, path, signIn);
    expect([path, res.status, res.headers.get("location")]).toEqual([path, 302, `${APP}${path}`]);
  }
  expect((await post(ACCOUNT, "/api/features", { name: "x" }, signIn)).status).toBe(404);
  expect(seen).toEqual([]);
  // Signed in already, the sign-in page leads on to the app.
  expect((await page(ACCOUNT, "/login", signIn)).headers.get("location")).toBe("/");
  // Any other name for the service still moves to the app's host.
  const railway = await gateway.fetch(new Request("https://x.up.railway.app/account", { headers: { host: "x.up.railway.app" } }));
  expect([railway.status, railway.headers.get("location")]).toEqual([301, `${APP}/account`]);
});

test("email links lead to the account host", async () => {
  await post(ACCOUNT, "/auth/signup", { email: "a@example.com" });
  await Bun.sleep(0);
  expect(sent.at(-1)!.text).toContain(`${ACCOUNT}/set-password#token=`);
  expect(sent.at(-1)!.text).not.toContain(`${APP}/`);
});

test("signing out on either host ends both sessions, and so does a changed password", async () => {
  // Signing out on the account host.
  let signIn = await signUp("a@example.com");
  let app = cookieOf((await handOver(signIn)).arrived, "__Host-sd_app");
  expect((await post(ACCOUNT, "/auth/logout", {}, signIn)).status).toBe(200);
  expect((await call(APP, "/api/state", { cookie: app })).status).toBe(401);

  // Signing out in the app.
  signIn = cookieOf(await post(ACCOUNT, "/auth/login", { email: "a@example.com", password: PASSWORD }), "__Host-sd_session");
  app = cookieOf((await handOver(signIn)).arrived, "__Host-sd_app");
  const out = await post(APP, "/_session/logout", {}, app);
  expect(out.status).toBe(200);
  expect(out.headers.getSetCookie().find((c) => c.startsWith("__Host-sd_app="))).toContain("Max-Age=0");
  expect((await call(APP, "/_session/me", { cookie: app })).status).toBe(401);
  expect((await call(ACCOUNT, "/auth/me", { cookie: signIn })).status).toBe(401);
  // Another site cannot sign the person out of the app.
  signIn = cookieOf(await post(ACCOUNT, "/auth/login", { email: "a@example.com", password: PASSWORD }), "__Host-sd_session");
  app = cookieOf((await handOver(signIn)).arrived, "__Host-sd_app");
  expect((await post(APP, "/_session/logout", {}, app, "https://evil.example")).status).toBe(403);
  expect((await call(APP, "/_session/me", { cookie: app })).status).toBe(200);

  // A changed password ends every session of both kinds; this browser is handed over again.
  const changed = await post(ACCOUNT, "/auth/change-password", { current: PASSWORD, password: "a different passphrase" }, signIn);
  expect(changed.status).toBe(200);
  expect((await call(APP, "/api/state", { cookie: app })).status).toBe(401);
  const again = await handOver(cookieOf(changed, "__Host-sd_session"));
  expect(again.arrived.status).toBe(302);
});

test("using the app keeps the sign-in alive, up to 30 days from signing in", async () => {
  const signIn = await signUp("a@example.com");
  const app = cookieOf((await handOver(signIn)).arrived, "__Host-sd_app");
  // Every day in the app, never on the account host: past the 14 idle days a sign-in lasts by itself.
  for (let day = 1; day <= 20; day++) {
    clock += DAY;
    expect((await call(APP, "/_session/me", { cookie: app })).status).toBe(200);
  }
  expect(20 * DAY).toBeGreaterThan(SESSION_IDLE_MS);
  expect((await call(ACCOUNT, "/auth/me", { cookie: signIn })).status).toBe(200);
  // Thirty days from sign-in, both end.
  clock += SESSION_MAX_MS - 20 * DAY;
  expect((await call(APP, "/_session/me", { cookie: app })).status).toBe(401);
  expect((await call(ACCOUNT, "/auth/me", { cookie: signIn })).status).toBe(401);

  // A sign-in left idle takes the app's session with it.
  const second = cookieOf(await post(ACCOUNT, "/auth/login", { email: "a@example.com", password: PASSWORD }), "__Host-sd_session");
  const secondApp = cookieOf((await handOver(second)).arrived, "__Host-sd_app");
  clock += SESSION_IDLE_MS + 1;
  expect((await call(APP, "/_session/me", { cookie: secondApp })).status).toBe(401);
});

test("only sign-ins go into the datastore, where an app session read back would count as one", async () => {
  const signIn = await signUp("a@example.com");
  await handOver(signIn);
  const kinds = db.query("SELECT kind, COUNT(*) AS n FROM sessions GROUP BY kind ORDER BY kind").all();
  expect(kinds).toEqual([{ kind: "account", n: 1 }, { kind: "app", n: 1 }]);
  const saved = JSON.parse(exportSnapshot(db)["sessions.json"]!) as unknown[];
  expect(saved).toHaveLength(1);
});

test("the app's pages carry a policy that runs only the app's own script", async () => {
  const signIn = await signUp("a@example.com");
  const app = cookieOf((await handOver(signIn)).arrived, "__Host-sd_app");
  const res = await page(APP, "/features/billing", app);
  const policy = res.headers.get("content-security-policy")!;
  const directive = (name: string) => policy.split("; ").find((d) => d.startsWith(`${name} `))!;
  // Its own files, WebAssembly, and the one inline script by its hash.
  const [hash] = inlineScriptHashes(SHELL);
  expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
  expect(inlineScriptHashes(SHELL)).toHaveLength(1);
  expect(directive("script-src")).toBe(`script-src 'self' 'wasm-unsafe-eval' ${hash}`);
  expect(directive("script-src")).not.toContain("unsafe-inline");
  expect(directive("script-src")).not.toContain("'unsafe-eval'");
  // Nothing is sent to, or framed by, another site.
  // … but for the diagram editor's fonts, from the one path they are on.
  expect(directive("connect-src")).toBe("connect-src 'self' https://esm.sh/@excalidraw/");
  expect(directive("font-src")).toBe("font-src 'self' data: https://esm.sh/@excalidraw/");
  expect(directive("form-action")).toBe("form-action 'self'");
  expect(directive("frame-ancestors")).toBe("frame-ancestors 'self'");
  expect(directive("object-src")).toBe("object-src 'none'");
  expect(directive("base-uri")).toBe("base-uri 'none'");
  expect(directive("default-src")).toBe("default-src 'self'");
  // What the worker answers keeps the policy the proxy gives it, not this one.
  const api = await call(APP, "/api/state", { cookie: app });
  expect(api.headers.get("content-security-policy")).toContain("sandbox");

  // Report-only says what would be blocked and blocks nothing; off sends none.
  expect(readAppCspMode({})).toBe("enforce");
  expect(readAppCspMode({ SPECDRIVEN_APP_CSP: " Report " })).toBe("report");
  expect(readAppCspMode({ SPECDRIVEN_APP_CSP: "off" })).toBe("off");
  expect(readAppCspMode({ SPECDRIVEN_APP_CSP: "nonsense" })).toBe("enforce");
  expect(appCsp("report", [])!.header).toBe("Content-Security-Policy-Report-Only");
  expect(appCsp("off", [])).toBeNull();
  gateway = await makeGateway({ appCsp: "off", accountUrl: null });
  const single = cookieOf(
    await (async () => {
      await gateway.fetch(new Request(`${APP}/auth/signup`, { method: "POST", body: JSON.stringify({ email: "b@example.com" }), headers: { host: "specs.example.com", origin: APP, "content-type": "application/json" } }));
      await Bun.sleep(0);
      const token = sent.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
      return post(APP, "/auth/set-password", { token, password: PASSWORD });
    })(),
    "__Host-sd_session",
  );
  expect((await page(APP, "/features/billing", single)).headers.get("content-security-policy")).toBeNull();
});

test("each of the gateway's three cookies belongs to one host, is hidden from script, and never reaches a worker", () => {
  const https = { secure: true };
  const names = [SESSION_COOKIE, APP_COOKIE, HANDOVER_COOKIE];
  expect(new Set(names).size).toBe(3);
  for (const name of names) {
    // __Host-: set by this host alone, for this host alone — the other host cannot plant one.
    expect(cookieName(https, name)).toBe(`__Host-${name}`);
    expect(cookieName({ secure: false }, name)).toBe(name);
    const set = sessionCookie("value", https, 60_000, name);
    expect(set).toStartWith(`__Host-${name}=value; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
    expect(set).toContain("Secure");
    expect(set).not.toContain("Domain");
    expect(clearedCookie(https, name)).toStartWith(`__Host-${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }
  const req = new Request(APP, { headers: { cookie: "theme=dark; __Host-sd_app=a; __Host-sd_session=s; __Host-sd_handover=h" } });
  expect(readCookie(req, https, APP_COOKIE)).toBe("a");
  expect(readCookie(req, https, SESSION_COOKIE)).toBe("s");
  expect(readCookie(req, https, HANDOVER_COOKIE)).toBe("h");
  // Over https only the prefixed name counts: one without it could come from anywhere.
  expect(readCookie(new Request(APP, { headers: { cookie: "sd_app=planted" } }), https, APP_COOKIE)).toBeNull();
  expect(cookiesWithout(req.headers.get("cookie"), https)).toBe("theme=dark");
  // The browser's half of a hand-over outlives the code by enough for every tab sent off together.
  expect(HANDOVER_STATE_MS).toBeGreaterThan(HANDOVER_CODE_MS);
  expect(HANDOVER_STATE_MS).toBeLessThanOrEqual(15 * 60_000);
});

test("an inline script is hashed as the browser reads it, however its tags are written", () => {
  const sha = (text: string) => `'sha256-${new Bun.CryptoHasher("sha256").update(text).digest("base64")}'`;
  const theme = 'var t = 1; if (a < b) { say("</scr" + "ipt>"); }';
  const second = 'let y = "&amp;";\n';
  const page = [
    "<!doctype html>",
    // An end tag with a space, which a browser accepts.
    `<script>${theme}</script >`,
    // Scripts loaded from a file, and an empty one, have nothing to hash.
    '<script src="/_app/main.js"></script>',
    "<script></script>",
    // Capitals, attributes and a line break in the end tag.
    `<SCRIPT type="module">${second}</SCRIPT\n>`,
    "<p>&lt;script&gt;not one&lt;/script&gt;</p>",
  ].join("\n");
  expect(inlineScriptHashes(page)).toEqual([sha(theme), sha(second)]);
  expect(inlineScriptHashes("<p>no script</p>")).toEqual([]);
  // The app's own page: its one inline script, the theme before first paint.
  expect(inlineScriptHashes(SHELL)).toEqual([sha("var t = 1;")]);
});

test("with one host, the app's own session answers are the sign-in's", async () => {
  gateway = await makeGateway({ accountUrl: null });
  await post(APP, "/auth/signup", { email: "a@example.com" });
  await Bun.sleep(0);
  const token = sent.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
  const cookie = cookieOf(await post(APP, "/auth/set-password", { token, password: PASSWORD }), "__Host-sd_session");
  expect(await (await call(APP, "/_session/me", { cookie })).json()).toEqual({ email: "a@example.com", role: "user" });
  expect((await call(APP, "/_session/me")).status).toBe(401);
  expect((await call(APP, "/_session/handover?code=x", { cookie })).status).toBe(404);
  expect((await call(APP, "/auth/handover?state=" + "s".repeat(43), { cookie })).status).toBe(404);
  const out = await post(APP, "/_session/logout", {}, cookie);
  expect(out.headers.get("set-cookie")).toContain("__Host-sd_session=;");
  expect((await call(APP, "/auth/me", { cookie })).status).toBe(401);
  expect(seen).toEqual([]);
});

test("the account url is an https url on another host than the app's, and needs the app's", () => {
  const base = { NODE_ENV: "production", PUBLIC_URL: APP, RESEND_API_KEY: "k", MAIL_FROM: "a@b.c", SPECDRIVEN_MASTER_KEY: "k" };
  expect(readConfig({ ...base, ACCOUNT_URL: `${ACCOUNT}/` }).accountUrl).toBe(ACCOUNT);
  expect(readConfig(base).accountUrl).toBeNull();
  expect(() => readConfig({ ...base, ACCOUNT_URL: APP })).toThrow("another host");
  expect(() => readConfig({ ...base, ACCOUNT_URL: "http://account.specs.example.com" })).toThrow("https://");
  expect(() => readConfig({ ACCOUNT_URL: ACCOUNT })).toThrow("needs PUBLIC_URL");
});

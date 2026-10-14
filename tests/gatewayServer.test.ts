// The hosted gateway over HTTP (src/gateway/server.ts): its pages and
// /auth/* API, the Host/Origin checks, and forwarding a signed-in user's
// requests to their own worker — here a stand-in server on a unix socket per
// user, so the test sees exactly what reaches it.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkerPath } from "../src/gateway/appShell";
import { buildAssets, type GatewayAssets } from "../src/gateway/assets";
import { generateMasterKey, loadKeyring } from "../src/gateway/crypto";
import { openDatabase } from "../src/gateway/db";
import type { Mail } from "../src/gateway/mail";
import { SecretStore } from "../src/gateway/secrets";
import { createGateway, type Gateway, type Workers } from "../src/gateway/server";

const ORIGIN = "https://specs.example.com";
const PASSWORD = "correct horse battery";

let dir: string;
let db: ReturnType<typeof openDatabase>;
let assets: GatewayAssets;
let gateway: Gateway;
let sent: Mail[];
let secrets: SecretStore;
/** What each stand-in worker saw, by user id. */
let seen: Map<string, Request[]>;
let restarts: string[];
const servers = new Map<string, ReturnType<typeof Bun.serve>>();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gw-"));
  assets = await buildAssets(false);
});

afterAll(async () => {
  for (const s of servers.values()) s.stop(true);
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in worker for one user: echoes what it got, or streams on /stream. */
function standIn(userId: string): string {
  const socket = join(dir, `${userId.slice(0, 8)}.sock`);
  if (!servers.has(userId)) {
    servers.set(
      userId,
      Bun.serve({
        unix: socket,
        fetch: async (req) => {
          const list = seen.get(userId) ?? [];
          list.push(req);
          seen.set(userId, list);
          if (new URL(req.url).pathname === "/api/stream") {
            let n = 0;
            return new Response(
              new ReadableStream({
                async pull(c) {
                  await Bun.sleep(20);
                  c.enqueue(new TextEncoder().encode(`event ${n}\n`));
                  if (++n === 3) c.close();
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            );
          }
          return Response.json({
            user: userId,
            path: new URL(req.url).pathname + new URL(req.url).search,
            host: req.headers.get("host"),
            cookie: req.headers.get("cookie"),
            body: req.method === "GET" ? null : await req.text(),
          });
        },
      }),
    );
  }
  return socket;
}

beforeEach(async () => {
  sent = [];
  seen = new Map();
  restarts = [];
  db = openDatabase(":memory:");
  // The admins' list (src/gateway/admin.ts) lets the whole test domain sign up.
  db.query("INSERT INTO allowed_emails (email, created_at) VALUES ('@example.com', 0)").run();
  secrets = new SecretStore(db, await loadKeyring({ SPECDRIVEN_MASTER_KEY: generateMasterKey() }));
  const workers: Workers = {
    socketFor: async (userId) => standIn(userId),
    touch: () => {},
    restart: async (userId) => void restarts.push(userId),
  };
  gateway = createGateway({
    db,
    secrets,
    mailer: { send: async (m) => void sent.push(m) },
    workers,
    assets,
    // The real shell is the app's whole frontend; a stand-in page will do.
    appShell: {
      serve: async (req, url) =>
        req.method === "GET" && !isWorkerPath(url.pathname) ? new Response("<!doctype html><title>app</title>") : null,
    },
    production: true,
    publicUrl: ORIGIN,
    githubIdentity: async (token) => {
      if (token !== "ghp_good_token") throw new Error("HTTP 401");
      return { token, login: "octo", name: "Octo Cat", email: "octo@example.com", id: 42 };
    },
  });
});

function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(ORIGIN).host);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("origin", ORIGIN);
  }
  if (init.cookie) headers.set("cookie", init.cookie);
  return gateway.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
}

const post = (path: string, data: unknown, cookie?: string, method = "POST") =>
  call(path, { method, body: JSON.stringify(data), cookie });

function cookieOf(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0]!;
}

async function signUp(email: string): Promise<string> {
  await post("/auth/signup", { email });
  await Bun.sleep(0);
  const token = sent.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
  const res = await post("/auth/set-password", { token, password: PASSWORD });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

test("the health check answers without a Host check or a session", async () => {
  const res = await gateway.fetch(new Request("http://healthcheck.railway.app/healthz"));
  expect(res.status).toBe(200);
});

test("a request for another host name is refused", async () => {
  const res = await gateway.fetch(
    new Request("https://evil.example/auth/login", {
      method: "POST",
      headers: { host: "evil.example", origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(403);
  const options = await gateway.fetch(
    new Request("https://evil.example/login", { method: "OPTIONS", headers: { host: "evil.example" } }),
  );
  expect(options.status).toBe(403);
});

test("a page load on another host name, such as the Railway domain, moves to PUBLIC_URL", async () => {
  const railway = "specdriven-app.up.railway.app";
  const res = await gateway.fetch(
    new Request(`https://${railway}/features/x?tab=scenarios`, { headers: { host: railway } }),
  );
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe(`${ORIGIN}/features/x?tab=scenarios`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const head = await gateway.fetch(new Request(`https://${railway}/login`, { method: "HEAD", headers: { host: railway } }));
  expect(head.status).toBe(301);
  expect(head.headers.get("location")).toBe(`${ORIGIN}/login`);
  // The path stays a path on PUBLIC_URL's host.
  const sneaky = await gateway.fetch(new Request(`https://${railway}//evil.example/`, { headers: { host: railway } }));
  expect(sneaky.headers.get("location")).toBe(`${ORIGIN}//evil.example/`);
  expect(new URL(sneaky.headers.get("location")!).host).toBe(new URL(ORIGIN).host);
  expect(seen.size).toBe(0);
});

test("signed out, the app redirects pages to sign-in and refuses the API", async () => {
  const page = await call("/features/x", { headers: { accept: "text/html" } });
  expect(page.status).toBe(302);
  expect(page.headers.get("location")).toBe("/login?next=%2Ffeatures%2Fx");
  const api = await call("/api/state");
  expect(api.status).toBe(401);
  expect(seen.size).toBe(0);
});

test("the sign-in pages carry a strict CSP and are never framed or cached", async () => {
  const res = await call("/login");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<form");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  const script = (await (await call("/signup")).text()).match(/src="(\/_gw\/[^"]+\.js)"/)![1]!;
  expect((await call(script)).status).toBe(200);
});

test("sign-up, set password, and the session reaches the user's worker without the gateway cookie", async () => {
  const cookie = await signUp("a@example.com");
  expect(cookie).toStartWith("__Host-sd_session=");
  const res = await call("/api/state?x=1", { cookie: `${cookie}; theme=dark` });
  expect(res.status).toBe(200);
  const echoed = (await res.json()) as { user: string; path: string; host: string; cookie: string };
  expect(echoed.path).toBe("/api/state?x=1");
  expect(echoed.host).toBe("specs.example.com");
  expect(echoed.cookie).toBe("theme=dark");
  expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
});

test("signed in, the app's pages come from the gateway and its API from the worker", async () => {
  const cookie = await signUp("a@example.com");
  const page = await call("/features/billing/quote", { cookie, headers: { accept: "text/html" } });
  expect(await page.text()).toContain("<title>app</title>");
  expect(seen.size).toBe(0);
  await call("/plugins/notes/client.js", { cookie });
  expect([...seen.values()][0]!.map((r) => new URL(r.url).pathname)).toEqual(["/plugins/notes/client.js"]);
});

test("two users reach two different workers", async () => {
  const a = await signUp("a@example.com");
  const b = await signUp("b@example.com");
  const userA = ((await (await call("/api/state", { cookie: a })).json()) as { user: string }).user;
  const userB = ((await (await call("/api/state", { cookie: b })).json()) as { user: string }).user;
  expect(userA).not.toBe(userB);
  expect(seen.get(userA)!.length).toBe(1);
  expect(seen.get(userB)!.length).toBe(1);
});

test("request bodies pass through and streamed answers stream", async () => {
  const cookie = await signUp("a@example.com");
  const res = await post("/api/features", { name: "x" }, cookie);
  expect(((await res.json()) as { body: string }).body).toBe('{"name":"x"}');
  const stream = await call("/api/stream", { cookie });
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  expect(await stream.text()).toBe("event 0\nevent 1\nevent 2\n");
});

test("a cross-site write is refused before it reaches the worker", async () => {
  const cookie = await signUp("a@example.com");
  const forged = await gateway.fetch(
    new Request(`${ORIGIN}/api/features`, {
      method: "POST",
      body: "{}",
      headers: { host: "specs.example.com", origin: "https://evil.example", "content-type": "application/json", cookie },
    }),
  );
  expect(forged.status).toBe(403);
  expect(seen.size).toBe(0);
});

test("login, logout and a wrong password", async () => {
  await signUp("a@example.com");
  expect((await post("/auth/login", { email: "a@example.com", password: "nope nope nope" })).status).toBe(401);
  const login = await post("/auth/login", { email: "A@example.com", password: PASSWORD });
  expect(login.status).toBe(200);
  const cookie = cookieOf(login);
  expect((await call("/auth/me", { cookie })).status).toBe(200);
  const logout = await post("/auth/logout", {}, cookie);
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await call("/auth/me", { cookie })).status).toBe(401);
});

test("repeated wrong passwords are rate limited", async () => {
  await signUp("a@example.com");
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    statuses.push((await post("/auth/login", { email: "a@example.com", password: `wrong-${i}-password` })).status);
  }
  expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
  expect(statuses[10]).toBe(429);
});

test("forgot answers the same for known and unknown addresses", async () => {
  await signUp("a@example.com");
  const known = await post("/auth/forgot", { email: "a@example.com" });
  const unknown = await post("/auth/forgot", { email: "nobody@example.com" });
  expect(known.status).toBe(unknown.status);
  expect(await known.json()).toEqual(await unknown.json());
});

test("a reset through the API ends the old session and restarts the worker", async () => {
  const old = await signUp("a@example.com");
  await post("/auth/forgot", { email: "a@example.com" });
  await Bun.sleep(0);
  const token = sent.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
  restarts = [];
  const res = await post("/auth/set-password", { token, password: "a brand new passphrase" });
  expect(res.status).toBe(200);
  expect((await call("/auth/me", { cookie: old })).status).toBe(401);
  expect((await call("/auth/me", { cookie: cookieOf(res) })).status).toBe(200);
  expect(restarts.length).toBe(1);
});

test("the GitHub token is checked with GitHub, stored sealed, shown by hint, and restarts the worker", async () => {
  const cookie = await signUp("a@example.com");
  expect((await post("/auth/secrets/github", { token: "ghp_bad" }, cookie, "PUT")).status).toBe(400);
  restarts = [];
  const ok = await post("/auth/secrets/github", { token: "ghp_good_token" }, cookie, "PUT");
  expect(await ok.json()).toEqual({ ok: true, login: "octo" });
  expect(restarts.length).toBe(1);
  const me = (await (await call("/auth/me", { cookie })).json()) as Record<string, unknown>;
  expect(me.github).toMatchObject({ login: "octo", hint: "oken" });
  expect(JSON.stringify(me)).not.toContain("ghp_good_token");
  const userId = restarts[0]!;
  expect((await secrets.values(userId)).github?.token).toBe("ghp_good_token");
  expect((await call("/auth/secrets/github", { method: "DELETE", cookie, headers: { origin: ORIGIN } })).status).toBe(200);
  expect((await secrets.values(userId)).github).toBeNull();
});

test("agent keys are saved, listed by hint and removed", async () => {
  const cookie = await signUp("a@example.com");
  expect((await post("/auth/secrets/agent-keys/Bad_Name", { value: "x" }, cookie, "PUT")).status).toBe(400);
  expect((await post("/auth/secrets/agent-keys/anthropic", { value: "sk-ant-abcd1234" }, cookie, "PUT")).status).toBe(200);
  expect((await post("/auth/secrets/agent-keys/openai", { value: "sk-oai-wxyz" }, cookie, "PUT")).status).toBe(200);
  const me = (await (await call("/auth/me", { cookie })).json()) as { agentKeys: { name: string; hint: string }[] };
  expect(me.agentKeys.map((k) => [k.name, k.hint])).toEqual([
    ["anthropic", "1234"],
    ["openai", "wxyz"],
  ]);
  const del = await call("/auth/secrets/agent-keys/openai", { method: "DELETE", cookie, headers: { origin: ORIGIN } });
  expect(del.status).toBe(200);
  const after = (await (await call("/auth/me", { cookie })).json()) as { agentKeys: unknown[] };
  expect(after.agentKeys.length).toBe(1);
});

test("one user's secrets are not another's", async () => {
  const a = await signUp("a@example.com");
  const b = await signUp("b@example.com");
  await post("/auth/secrets/agent-keys/anthropic", { value: "sk-ant-of-a" }, a, "PUT");
  const meB = (await (await call("/auth/me", { cookie: b })).json()) as { agentKeys: unknown[] };
  expect(meB.agentKeys).toEqual([]);
});

test("changing the password signs this browser in again and ends the others", async () => {
  const first = await signUp("a@example.com");
  const second = cookieOf(await post("/auth/login", { email: "a@example.com", password: PASSWORD }));
  const res = await post("/auth/change-password", { current: PASSWORD, password: "a different passphrase" }, first);
  expect(res.status).toBe(200);
  expect((await call("/auth/me", { cookie: second })).status).toBe(401);
  expect((await call("/auth/me", { cookie: cookieOf(res) })).status).toBe(200);
});

/** Signed in as a fresh account made an admin. */
async function signUpAdmin(email = "boss@example.com"): Promise<string> {
  const cookie = await signUp(email);
  db.query("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
  return cookie;
}

const del = (path: string, cookie: string) => call(path, { method: "DELETE", cookie, headers: { origin: ORIGIN } });

test("a new account is a user, with no admin API, no admin page and no invites to send", async () => {
  const cookie = await signUp("a@example.com");
  expect(((await (await call("/auth/me", { cookie })).json()) as { role: string }).role).toBe("user");
  expect((await call("/auth/admin", { cookie })).status).toBe(403);
  expect((await post("/auth/admin/allowed", { email: "x@else.example" }, cookie)).status).toBe(403);
  const page = await call("/admin", { cookie });
  expect(page.status).toBe(403);
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect((await post("/auth/invite", { email: "x@else.example" }, cookie)).status).toBe(404);
});

test("signed out, the admin page leads to sign-in and its API refuses", async () => {
  const page = await call("/admin");
  expect(page.status).toBe(302);
  expect(page.headers.get("location")).toBe("/login?next=%2Fadmin");
  expect((await call("/auth/admin")).status).toBe(401);
});

test("an admin opens the admin page and sees the allowed emails and the users", async () => {
  const cookie = await signUpAdmin();
  expect(((await (await call("/auth/me", { cookie })).json()) as { role: string }).role).toBe("admin");
  const page = await call("/admin", { cookie });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Allowed emails");
  const data = (await (await call("/auth/admin", { cookie })).json()) as {
    you: string;
    allowed: { email: string }[];
    users: { id: string; email: string; role: string; createdAt: number; hasPassword: boolean }[];
  };
  expect(data.allowed.map((a) => a.email)).toEqual(["@example.com"]);
  expect(data.users).toEqual([
    { id: data.you, email: "boss@example.com", role: "admin", createdAt: expect.any(Number), hasPassword: true },
  ]);
});

test("an admin allows an address, which is invited and can sign up, and takes it off again", async () => {
  const cookie = await signUpAdmin();
  expect((await post("/auth/admin/allowed", { email: "not an email" }, cookie)).status).toBe(400);
  sent = [];
  expect((await post("/auth/admin/allowed", { email: " Guest@Else.example ", invite: true }, cookie)).status).toBe(200);
  await Bun.sleep(0);
  expect(sent.map((m) => [m.to, m.subject])).toEqual([["guest@else.example", "You're invited to SpecDriven"]]);
  expect(sent[0]!.text).toContain("boss@example.com invited you");
  expect(sent[0]!.text).toContain(`${ORIGIN}/signup?email=guest%40else.example`);
  const list = (await (await call("/auth/admin", { cookie })).json()) as { allowed: unknown[] };
  expect(list.allowed).toContainEqual({
    email: "guest@else.example",
    addedBy: "boss@example.com",
    createdAt: expect.any(Number),
  });

  await signUp("guest@else.example");

  expect((await del("/auth/admin/allowed/guest%40else.example", cookie)).status).toBe(200);
  expect((await del("/auth/admin/allowed/guest%40else.example", cookie)).status).toBe(404);
  // Off the list: no new sign-up, but the account made stays.
  sent = [];
  await post("/auth/signup", { email: "other@else.example" });
  await Bun.sleep(0);
  expect(sent).toEqual([]);
  expect((await post("/auth/login", { email: "guest@else.example", password: PASSWORD })).status).toBe(200);
});

test("a domain on the list lets every address in it sign up, and is never emailed", async () => {
  const cookie = await signUpAdmin();
  sent = [];
  expect((await post("/auth/admin/allowed", { email: "@partner.example", invite: true }, cookie)).status).toBe(200);
  await Bun.sleep(0);
  expect(sent).toEqual([]);
  await signUp("anyone@partner.example");
});

test("an admin gives and takes the admin role, which applies at once, but never from the last admin", async () => {
  const boss = await signUpAdmin();
  const other = await signUp("b@example.com");
  const list = (await (await call("/auth/admin", { cookie: boss })).json()) as {
    you: string;
    users: { id: string; email: string }[];
  };
  const bossId = list.you;
  const otherId = list.users.find((u) => u.email === "b@example.com")!.id;

  const lastOne = await post(`/auth/admin/users/${bossId}/role`, { role: "user" }, boss, "PUT");
  expect(lastOne.status).toBe(400);
  expect(((await lastOne.json()) as { error: string }).error).toMatch(/someone else an admin first/);
  expect((await post(`/auth/admin/users/${otherId}/role`, { role: "owner" }, boss, "PUT")).status).toBe(400);
  expect((await post(`/auth/admin/users/nobody/role`, { role: "admin" }, boss, "PUT")).status).toBe(400);

  expect((await post(`/auth/admin/users/${otherId}/role`, { role: "admin" }, boss, "PUT")).status).toBe(200);
  // The other session needs no new sign-in to be an admin.
  expect((await call("/auth/admin", { cookie: other })).status).toBe(200);
  expect((await post(`/auth/admin/users/${bossId}/role`, { role: "user" }, other, "PUT")).status).toBe(200);
  expect((await call("/auth/admin", { cookie: boss })).status).toBe(403);
});


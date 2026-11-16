// Connecting GitHub on the account page (src/gateway/server.ts,
// docs/hosted-tenant-isolation.md "Step 3"): the way to GitHub and back,
// which only ends in a link when the same browser that set out comes back
// with the code GitHub made for it; what the link replaces; and taking it
// away again. GitHub itself is a stand-in that answers one code.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { buildAssets, type GatewayAssets } from "../src/gateway/assets";
import { generateMasterKey, loadKeyring } from "../src/gateway/crypto";
import { openDatabase } from "../src/gateway/db";
import { GithubLinks } from "../src/gateway/githubLinks";
import type { Mail } from "../src/gateway/mail";
import { SecretStore } from "../src/gateway/secrets";
import { createGateway, type Gateway } from "../src/gateway/server";
import { cookieName, GITHUB_STATE_COOKIE } from "../src/gateway/sessions";

const ORIGIN = "https://specs.example.com";
const PASSWORD = "correct horse battery";
const CALLBACK = `${ORIGIN}/auth/github/callback`;

let assets: GatewayAssets;
let gateway: Gateway;
let sent: Mail[];
let secrets: SecretStore;
let links: GithubLinks;
let restarts: string[];
/** The codes GitHub was shown, with where each said it came back to. */
let identified: string[];
/** What reached the stand-in worker as its Cookie header. */
let workerCookies: (string | null)[];
let worker: ReturnType<typeof Bun.serve>;
let workerSocket: string;

beforeAll(async () => {
  assets = await buildAssets(false);
  workerSocket = `/tmp/sdc-${process.pid}.sock`;
  worker = Bun.serve({
    unix: workerSocket,
    fetch: (req) => {
      workerCookies.push(req.headers.get("cookie"));
      return Response.json({ ok: true });
    },
  });
});

afterAll(() => worker.stop(true));

async function start(withApp = true): Promise<void> {
  sent = [];
  restarts = [];
  identified = [];
  workerCookies = [];
  const db = openDatabase(":memory:");
  db.query("INSERT INTO allowed_emails (email, created_at) VALUES ('@example.com', 0)").run();
  secrets = new SecretStore(db, await loadKeyring({ SPECDRIVEN_MASTER_KEY: generateMasterKey() }));
  links = new GithubLinks(db);
  gateway = createGateway({
    db,
    secrets,
    mailer: { send: async (m) => void sent.push(m) },
    workers: {
      workerFor: async () => ({ socket: workerSocket, key: "k" }),
      touch: () => {},
      restart: async (userId) => void restarts.push(userId),
    },
    assets,
    appShell: { serve: async () => null },
    production: true,
    publicUrl: ORIGIN,
    githubIdentity: async (token) => ({ token, login: "octo", name: null, email: null, id: 42 }),
    github: withApp
      ? {
          app: {
            authorizeUrl: (state, redirectUri) => `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
            identify: async (code, redirectUri) => {
              identified.push(`${code} ${redirectUri}`);
              if (code !== "good-code") throw new Error("bad_verification_code");
              return { id: 42, login: "octo", name: "Octo Cat", email: "octo@example.com" };
            },
            installUrl: async () => "https://github.com/apps/specdriven/installations/new",
          },
          links,
        }
      : null,
  });
}

beforeEach(() => start());

function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(ORIGIN).host);
  if (init.method && init.method !== "GET") {
    headers.set("content-type", "application/json");
    headers.set("origin", ORIGIN);
  }
  if (init.cookie) headers.set("cookie", init.cookie);
  return gateway.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
}

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function signUp(email: string): Promise<string> {
  await call("/auth/signup", { method: "POST", body: JSON.stringify({ email }) });
  await Bun.sleep(0);
  const token = sent.at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
  const res = await call("/auth/set-password", { method: "POST", body: JSON.stringify({ token, password: PASSWORD }) });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

/** Set out for GitHub: the state it was sent with, and the cookie that must come back with it. */
async function setOut(session: string): Promise<{ state: string; stateCookie: string }> {
  const res = await call("/auth/github/connect", { method: "POST", cookie: session, body: "{}" });
  expect(res.status).toBe(200);
  const to = new URL(((await res.json()) as { url: string }).url);
  expect(to.origin + to.pathname).toBe("https://github.test/authorize");
  expect(to.searchParams.get("redirect_uri")).toBe(CALLBACK);
  const set = res.headers.get("set-cookie")!;
  expect(set).toStartWith(`${cookieName({ secure: true }, GITHUB_STATE_COOKIE)}=`);
  expect(set).toStartWith("__Host-sd_github=");
  expect(set).toContain("HttpOnly");
  expect(set).toContain("Secure");
  return { state: to.searchParams.get("state")!, stateCookie: cookieOf(res) };
}

const me = async (session: string) => (await (await call("/auth/me", { cookie: session })).json()) as Record<string, any>;
const userIdOf = async (session: string) => {
  await call("/auth/github/link", { method: "DELETE", cookie: session });
  return restarts.pop()!;
};

test("with the app, the account page offers connecting and takes no pasted token", async () => {
  const session = await signUp("a@example.com");
  restarts = [];
  const account = await me(session);
  expect(account.githubApp).toEqual({ account: null, installUrl: "https://github.com/apps/specdriven/installations/new" });
  const pasted = await call("/auth/secrets/github", { method: "PUT", cookie: session, body: JSON.stringify({ token: "ghp_x" }) });
  expect(pasted.status).toBe(400);
  expect(((await pasted.json()) as { error: string }).error).toContain("connect GitHub");
  expect(restarts).toEqual([]);
});

test("without the app nothing of it is served", async () => {
  await start(false);
  const session = await signUp("a@example.com");
  expect((await me(session)).githubApp).toBeNull();
  expect((await call("/auth/github/connect", { method: "POST", cookie: session, body: "{}" })).status).toBe(404);
  expect((await call("/auth/github/callback?code=x&state=y", { cookie: session })).status).toBe(404);
  expect((await call("/auth/github/link", { method: "DELETE", cookie: session })).status).toBe(404);
  expect((await call("/auth/secrets/github", { method: "PUT", cookie: session, body: JSON.stringify({ token: "ghp_x" }) })).status).toBe(200);
});

test("signed out, nothing sets out for GitHub, and the way back leads to sign-in first", async () => {
  expect((await call("/auth/github/connect", { method: "POST", body: "{}" })).status).toBe(401);
  const res = await call("/auth/github/callback?code=good-code&state=x");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login?next=%2Faccount");
  expect(identified).toEqual([]);
});

// A signed-in browser can be sent anywhere by a link or by a page it is
// shown. Setting out for GitHub is a write from the account page itself.
test("only the account page sets out for GitHub, never a link or another site's page", async () => {
  const session = await signUp("a@example.com");
  // A link, or a page that navigates there: a page load starts nothing.
  const followed = await call("/auth/github/connect", { cookie: session });
  expect(followed.status).toBe(404);
  expect(followed.headers.get("set-cookie")).toBeNull();
  // A write from another site is refused before it gets here.
  const crossSite = await gateway.fetch(
    new Request(`${ORIGIN}/auth/github/connect`, {
      method: "POST",
      headers: { host: "specs.example.com", origin: "https://evil.example", cookie: session, "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(crossSite.status).toBe(403);
  expect(crossSite.headers.get("set-cookie")).toBeNull();
});

// Someone sent another person's set-password link ends up signed in to that
// person's account. Their own GitHub account must not become that account's.
test("a GitHub account that is one person's here cannot be connected to another's", async () => {
  const mine = await signUp("a@example.com");
  const theirs = await signUp("b@example.com");
  const first = await setOut(mine);
  await call(`/auth/github/callback?code=good-code&state=${first.state}`, { cookie: `${mine}; ${first.stateCookie}` });
  const owner = restarts.at(-1)!;
  restarts = [];
  identified = [];

  // The same GitHub account (the stand-in knows one), from the other account's session.
  const second = await setOut(theirs);
  const back = await call(`/auth/github/callback?code=good-code&state=${second.state}`, { cookie: `${theirs}; ${second.stateCookie}` });
  expect(back.headers.get("location")).toBe("/account?github=taken");
  expect(identified.length).toBe(1);
  expect(restarts).toEqual([]);
  expect((await me(theirs)).githubApp.account).toBeNull();
  expect(links.ownerOf(42)).toBe(owner);

  // Connecting it again to the account that has it is fine, and once it is let go the other may take it.
  const again = await setOut(mine);
  const kept = await call(`/auth/github/callback?code=good-code&state=${again.state}`, { cookie: `${mine}; ${again.stateCookie}` });
  expect(kept.headers.get("location")).toBe("/account");
  await call("/auth/github/link", { method: "DELETE", cookie: mine });
  const third = await setOut(theirs);
  const taken = await call(`/auth/github/callback?code=good-code&state=${third.state}`, { cookie: `${theirs}; ${third.stateCookie}` });
  expect(taken.headers.get("location")).toBe("/account");
  expect((await me(theirs)).githubApp.account.login).toBe("octo");
});

test("what stops a person's worker is limited, so it cannot be done without end", async () => {
  const session = await signUp("a@example.com");
  restarts = [];
  let refused = 0;
  for (let i = 0; i < 70; i++) {
    const path = i % 2 ? "/auth/github/link" : "/auth/secrets/agent-keys/anthropic";
    if ((await call(path, { method: "DELETE", cookie: session })).status === 429) refused++;
  }
  expect(refused).toBe(10);
  expect(restarts.length).toBe(60);
});

test("back from GitHub with its code, the person is who GitHub says, the pasted token is deleted, and the worker starts again", async () => {
  const session = await signUp("a@example.com");
  const userId = await userIdOf(session);
  await secrets.put(userId, "github", "github", "ghp_pasted_months_ago", { login: "octo" });
  restarts = [];
  const { state, stateCookie } = await setOut(session);

  const back = await call(`/auth/github/callback?code=good-code&state=${state}`, { cookie: `${session}; ${stateCookie}` });
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe("/account");
  // The way back is used up.
  expect(back.headers.get("set-cookie")).toMatch(/^__Host-sd_github=;.*Max-Age=0/);
  expect(identified).toEqual([`good-code ${CALLBACK}`]);
  expect(links.get(userId)).toMatchObject({ id: 42, login: "octo", name: "Octo Cat", email: "octo@example.com" });
  expect((await secrets.values(userId)).github).toBeNull();
  expect(restarts).toEqual([userId]);

  const account = await me(session);
  expect(account.githubApp.account.login).toBe("octo");
  expect(account.github).toBeNull();
});

test("a code that did not come back to the browser that set out links nothing", async () => {
  const session = await signUp("a@example.com");
  const other = await signUp("b@example.com");
  const { state, stateCookie } = await setOut(session);
  const theirs = await setOut(other);
  restarts = [];
  const outcome = async (path: string, cookie: string) => (await call(path, { cookie })).headers.get("location");

  // No cookie from setting out; a state this browser was not given; a state that was changed.
  expect(await outcome(`/auth/github/callback?code=good-code&state=${state}`, session)).toBe("/account?github=state");
  expect(await outcome(`/auth/github/callback?code=good-code&state=${theirs.state}`, `${session}; ${stateCookie}`)).toBe("/account?github=state");
  expect(await outcome(`/auth/github/callback?code=good-code&state=${state}x`, `${session}; ${stateCookie}`)).toBe("/account?github=state");
  // Another account's way out, carried into this account's session: an
  // attacker's code for their own GitHub account must not become this person's.
  expect(await outcome(`/auth/github/callback?code=good-code&state=${theirs.state}`, `${session}; ${theirs.stateCookie}`)).toBe(
    "/account?github=state",
  );
  expect(await outcome(`/auth/github/callback?state=${state}`, `${session}; ${stateCookie}`)).toBe("/account?github=state");
  expect(identified).toEqual([]);

  // The person said no at GitHub, or GitHub does not know the code.
  expect(await outcome(`/auth/github/callback?error=access_denied&state=${state}`, `${session}; ${stateCookie}`)).toBe("/account?github=cancelled");
  expect(await outcome(`/auth/github/callback?code=stolen&state=${state}`, `${session}; ${stateCookie}`)).toBe("/account?github=failed");
  expect(identified).toEqual([`stolen ${CALLBACK}`]);

  expect(restarts).toEqual([]);
  expect((await me(session)).githubApp.account).toBeNull();
});

test("GitHub's own return after the app was installed on a repository just shows the account page", async () => {
  const session = await signUp("a@example.com");
  const res = await call("/auth/github/callback?code=from-github&installation_id=7&setup_action=install", { cookie: session });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/account");
  expect(identified).toEqual([]);
});

test("disconnecting removes the link and stops the worker, which ends its tokens", async () => {
  const session = await signUp("a@example.com");
  const { state, stateCookie } = await setOut(session);
  await call(`/auth/github/callback?code=good-code&state=${state}`, { cookie: `${session}; ${stateCookie}` });
  const userId = restarts.at(-1)!;
  restarts = [];
  // A write from another site is refused before it gets here.
  const crossSite = await gateway.fetch(
    new Request(`${ORIGIN}/auth/github/link`, {
      method: "DELETE",
      headers: { host: "specs.example.com", origin: "https://evil.example", cookie: session },
    }),
  );
  expect(crossSite.status).toBe(403);
  expect(links.get(userId)).not.toBeNull();

  expect((await call("/auth/github/link", { method: "DELETE", cookie: session })).status).toBe(200);
  expect(links.get(userId)).toBeNull();
  expect(restarts).toEqual([userId]);
  expect((await me(session)).githubApp.account).toBeNull();
});

test("the secret a browser carries to GitHub never reaches its worker", async () => {
  const session = await signUp("a@example.com");
  const { stateCookie } = await setOut(session);
  const res = await call("/api/state", { cookie: `${session}; ${stateCookie}; theme=dark` });
  expect(res.status).toBe(200);
  expect(workerCookies).toEqual(["theme=dark"]);
});

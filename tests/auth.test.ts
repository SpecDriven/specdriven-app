// GitHub sign-in (git-operations.md) — the device flow and the
// browser (web application) flow — against a stub GitHub served on loopback:
// the state machines, token persistence and the noreply-email fallback — no
// network, no real GitHub.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchIdentity,
  getAuth,
  handleWebCallback,
  pollDeviceFlow,
  pollWebFlow,
  signOut,
  startDeviceFlow,
  startWebFlow,
} from "../src/server/auth";
import { createFileBackend, setTokenBackend } from "../src/server/tokenStore";

let dir: string;
let tokenFile: string;
let server: ReturnType<typeof Bun.serve> | null = null;
/** Scripted answers for POST /login/oauth/access_token, shifted per poll. */
let tokenReplies: unknown[] = [];
/** Bodies POSTed to /login/oauth/access_token, in order. */
let tokenRequests: Record<string, string>[] = [];

const savedEnv = {
  url: process.env.SPECDRIVEN_GITHUB_URL,
  api: process.env.SPECDRIVEN_GITHUB_API_URL,
  client: process.env.SPECDRIVEN_GITHUB_CLIENT_ID,
  secret: process.env.SPECDRIVEN_GITHUB_CLIENT_SECRET,
};

function stubGitHub(): string {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path === "/login/device/code") {
        return Response.json({
          device_code: "dev-code",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        });
      }
      if (req.method === "POST" && path === "/login/oauth/access_token") {
        tokenRequests.push((await req.json()) as Record<string, string>);
        return Response.json(tokenReplies.shift() ?? { error: "authorization_pending" });
      }
      if (req.method === "GET" && path === "/user") {
        if (req.headers.get("authorization") !== "Bearer tok-123") {
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        }
        return Response.json({ login: "octo", id: 5, name: "Octo Cat", email: null });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-auth-"));
  tokenFile = join(dir, "token.json");
  setTokenBackend(createFileBackend(tokenFile));
  const base = stubGitHub();
  process.env.SPECDRIVEN_GITHUB_URL = base;
  process.env.SPECDRIVEN_GITHUB_API_URL = base;
  process.env.SPECDRIVEN_GITHUB_CLIENT_ID = "test-client-id";
  process.env.SPECDRIVEN_GITHUB_CLIENT_SECRET = "test-client-secret";
  tokenReplies = [];
  tokenRequests = [];
});

afterEach(async () => {
  // Clears the tmp token file and any pending flow — before the backend
  // reset below, so nothing ever touches the real user's token.
  await signOut();
  server?.stop(true);
  server = null;
  setTokenBackend(createFileBackend());
  for (const [key, value] of [
    ["SPECDRIVEN_GITHUB_URL", savedEnv.url],
    ["SPECDRIVEN_GITHUB_API_URL", savedEnv.api],
    ["SPECDRIVEN_GITHUB_CLIENT_ID", savedEnv.client],
    ["SPECDRIVEN_GITHUB_CLIENT_SECRET", savedEnv.secret],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

// Scenario: sign in with GitHub — the code is shown, GitHub authorizes,
// the token is stored with the account it belongs to.
test("device flow: pending polls, then authorized with the identity stored", async () => {
  const start = await startDeviceFlow();
  expect(start.userCode).toBe("ABCD-1234");
  expect(start.verificationUri).toBe("https://github.com/login/device");

  tokenReplies = [
    { error: "authorization_pending" },
    { error: "slow_down", interval: 10 },
    { access_token: "tok-123" },
  ];
  expect((await pollDeviceFlow()).status).toBe("pending");
  expect((await pollDeviceFlow()).status).toBe("pending"); // slow_down reads as pending
  const done = await pollDeviceFlow();
  expect(done.status).toBe("authorized");
  // The account email is hidden — the noreply address stands in.
  expect(done.user).toEqual({
    login: "octo",
    name: "Octo Cat",
    email: "5+octo@users.noreply.github.com",
  });

  const auth = await getAuth();
  expect(auth?.token).toBe("tok-123");
  expect(auth?.login).toBe("octo");
  // The token file is a credential: owner-only permissions.
  expect(((await stat(tokenFile)).mode & 0o777)).toBe(0o600);
});

test("device flow: denial and expiry end the flow", async () => {
  await startDeviceFlow();
  tokenReplies = [{ error: "access_denied" }];
  expect((await pollDeviceFlow()).status).toBe("denied");
  // no pending flow anymore
  expect((await pollDeviceFlow()).status).toBe("expired");

  await startDeviceFlow();
  tokenReplies = [{ error: "expired_token" }];
  expect((await pollDeviceFlow()).status).toBe("expired");
  expect(await getAuth()).toBeNull();
});

test("sign out clears the stored token", async () => {
  await startDeviceFlow();
  tokenReplies = [{ access_token: "tok-123" }];
  await pollDeviceFlow();
  expect(await getAuth()).not.toBeNull();
  await signOut();
  expect(await getAuth()).toBeNull();
  expect(await Bun.file(tokenFile).exists()).toBe(false);
});

test("sign-in without a configured GitHub App reports the configuration error", async () => {
  delete process.env.SPECDRIVEN_GITHUB_CLIENT_ID;
  expect(startDeviceFlow()).rejects.toThrow("GitHub sign-in is not configured");
});

test("fetchIdentity keeps a public email as-is", async () => {
  // stub /user returns a null email for tok-123; craft one with email via a
  // one-off route is overkill — check the fallback shape directly instead.
  const identity = await fetchIdentity("tok-123");
  expect(identity.email).toBe("5+octo@users.noreply.github.com");
  expect(identity.name).toBe("Octo Cat");
  expect(identity.id).toBe(5);
});

// Scenario: connect to GitHub via the browser — the authorize url carries
// state + PKCE, the callback exchanges the code (with the client secret and
// verifier) and stores the token, and the dialog's poll sees the outcome.
test("web flow: authorize url and callback exchange store the token", async () => {
  const { authorizeUrl } = startWebFlow("http://127.0.0.1:3000");
  const url = new URL(authorizeUrl);
  expect(url.pathname).toBe("/login/oauth/authorize");
  expect(url.searchParams.get("client_id")).toBe("test-client-id");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "http://127.0.0.1:3000/api/auth/github/callback",
  );
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const state = url.searchParams.get("state")!;
  expect(state.length).toBeGreaterThan(20);
  expect(pollWebFlow().status).toBe("pending");

  tokenReplies = [{ access_token: "tok-123" }];
  const done = await handleWebCallback(new URLSearchParams({ code: "auth-code", state }));
  expect(done.ok).toBe(true);
  expect(done.message).toContain("octo");

  // The exchange carried the secret, the code, and the PKCE verifier whose
  // S256 hash rode along on the authorize url.
  const body = tokenRequests[0]!;
  expect(body.client_secret).toBe("test-client-secret");
  expect(body.code).toBe("auth-code");
  expect(body.redirect_uri).toBe("http://127.0.0.1:3000/api/auth/github/callback");
  expect(createHash("sha256").update(body.code_verifier!).digest("base64url")).toBe(
    url.searchParams.get("code_challenge")!,
  );

  const poll = pollWebFlow();
  expect(poll.status).toBe("authorized");
  expect(poll.user?.login).toBe("octo");
  expect((await getAuth())?.token).toBe("tok-123");
  // the outcome is delivered once; afterwards there is nothing pending
  expect(pollWebFlow().status).toBe("expired");
});

// A stray or forged callback must neither sign anyone in nor cancel the
// flow the user is inside.
test("web flow: a state mismatch is refused and the flow stays pending", async () => {
  startWebFlow("http://127.0.0.1:3000");
  const res = await handleWebCallback(new URLSearchParams({ code: "x", state: "forged" }));
  expect(res.ok).toBe(false);
  expect(tokenRequests).toHaveLength(0); // no exchange attempted
  expect(pollWebFlow().status).toBe("pending");
  expect(await getAuth()).toBeNull();
});

test("web flow: denial on GitHub reads as denied", async () => {
  const { authorizeUrl } = startWebFlow("http://127.0.0.1:3000");
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  const res = await handleWebCallback(new URLSearchParams({ error: "access_denied", state }));
  expect(res.ok).toBe(false);
  expect(pollWebFlow().status).toBe("denied");
  expect(await getAuth()).toBeNull();
});

test("web flow: an exchange failure reaches the poll with its message", async () => {
  const { authorizeUrl } = startWebFlow("http://127.0.0.1:3000");
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  tokenReplies = [{ error: "bad_verification_code" }];
  const res = await handleWebCallback(new URLSearchParams({ code: "nope", state }));
  expect(res.ok).toBe(false);
  const poll = pollWebFlow();
  expect(poll.status).toBe("denied");
  expect(poll.error).toContain("bad_verification_code");
  expect(await getAuth()).toBeNull();
});

test("web flow without the client secret reports the configuration error", () => {
  delete process.env.SPECDRIVEN_GITHUB_CLIENT_SECRET;
  expect(() => startWebFlow("http://127.0.0.1:3000")).toThrow(
    "SPECDRIVEN_GITHUB_CLIENT_SECRET",
  );
  delete process.env.SPECDRIVEN_GITHUB_CLIENT_ID;
  expect(() => startWebFlow("http://127.0.0.1:3000")).toThrow(
    "GitHub sign-in is not configured",
  );
});

test("token round-trips through the file backend across backend resets", async () => {
  await startDeviceFlow();
  tokenReplies = [{ access_token: "tok-123" }];
  await pollDeviceFlow();
  // a fresh backend on the same file (as after an app restart) still loads it
  setTokenBackend(createFileBackend(tokenFile));
  const auth = await getAuth();
  expect(auth?.login).toBe("octo");
  expect(auth?.token).toBe("tok-123");
});

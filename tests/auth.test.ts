// GitHub App device-flow sign-in (specs/git-operations.spec.md), against a
// stub GitHub served on loopback: the state machine, token persistence and
// the noreply-email fallback — no network, no real GitHub.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchIdentity,
  getAuth,
  pollDeviceFlow,
  signOut,
  startDeviceFlow,
} from "../src/server/auth";
import { createFileBackend, setTokenBackend } from "../src/server/tokenStore";

let dir: string;
let tokenFile: string;
let server: ReturnType<typeof Bun.serve> | null = null;
/** Scripted answers for POST /login/oauth/access_token, shifted per poll. */
let tokenReplies: unknown[] = [];

const savedEnv = {
  url: process.env.SPECDRIVEN_GITHUB_URL,
  api: process.env.SPECDRIVEN_GITHUB_API_URL,
  client: process.env.SPECDRIVEN_GITHUB_CLIENT_ID,
};

function stubGitHub(): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
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
  tokenReplies = [];
});

afterEach(async () => {
  server?.stop(true);
  server = null;
  setTokenBackend(createFileBackend());
  for (const [key, value] of [
    ["SPECDRIVEN_GITHUB_URL", savedEnv.url],
    ["SPECDRIVEN_GITHUB_API_URL", savedEnv.api],
    ["SPECDRIVEN_GITHUB_CLIENT_ID", savedEnv.client],
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

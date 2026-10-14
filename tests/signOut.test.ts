// specs/user-info-settings.feature.md "sign out from the user menu" and
// "signing out stops using the GitHub CLI account": signing out clears the
// app's token and turns off the fallback to the GitHub CLI's account — the
// chip, the commit author and the Issues tab stop using gh's account until
// Settings turns it back on. A stub gh on PATH stands in for the CLI.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../src/server/api";
import { getAuth } from "../src/server/auth";
import { resetGhCache, setGhAccountEnabled } from "../src/server/git/gh";
import { setGitEngine } from "../src/server/git";
import { issuesToken } from "../src/server/issues";
import { readState } from "../src/server/state";
import { createFileBackend, saveToken, setTokenBackend } from "../src/server/tokenStore";
import { getCurrentUser } from "../src/server/user";
import { FAKE_GH_ACCOUNT, installFakeGh, type FakeGh } from "./helpers/binPath";

let dir: string;
let fakeGh: FakeGh;
const savedEnv = { root: process.env.SPECDRIVEN_ROOT, home: process.env.SPECDRIVEN_HOME };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-signout-"));
  process.env.SPECDRIVEN_ROOT = join(dir, "root");
  process.env.SPECDRIVEN_HOME = join(dir, "home");
  setTokenBackend(createFileBackend(join(dir, "token.json")));
  fakeGh = installFakeGh();
  setGitEngine("gh");
  setGhAccountEnabled(true);
});

afterEach(async () => {
  fakeGh.restore();
  setGitEngine(null);
  setGhAccountEnabled(true);
  resetGhCache();
  setTokenBackend(createFileBackend());
  for (const [key, value] of [
    ["SPECDRIVEN_ROOT", savedEnv.root],
    ["SPECDRIVEN_HOME", savedEnv.home],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown) {
  const res = (await handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  ))!;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test("signed out with gh signed in, the gh account stands in until sign out", async () => {
  expect((await getCurrentUser()).login).toBe(FAKE_GH_ACCOUNT.login);
  expect(await issuesToken()).not.toBeNull();
  expect((await api("GET", "/api/state")).body.gh.inUse).toBe(true);
});

test("sign out clears the token and stops using the GitHub CLI account", async () => {
  await saveToken({ token: "tok", login: "app-user", name: null, email: "1+app-user@users.noreply.github.com", id: 1 });
  expect((await getCurrentUser()).login).toBe("app-user");

  const out = await api("DELETE", "/api/auth/github");
  expect(out.status).toBe(200);
  expect(await getAuth()).toBeNull();
  expect((await readState(process.env.SPECDRIVEN_ROOT)).useGhAccount).toBe(false);

  // gh is still signed in, but the app no longer uses its account.
  expect((await getCurrentUser()).login).toBeNull();
  expect(await issuesToken()).toBeNull();
  const state = (await api("GET", "/api/state")).body;
  expect(state.auth.signedIn).toBe(false);
  expect(state.gh).toMatchObject({ signedIn: true, login: FAKE_GH_ACCOUNT.login, inUse: false });
});

test("Use GitHub CLI account turns the fallback back on", async () => {
  await api("DELETE", "/api/auth/github");
  expect((await getCurrentUser()).login).toBeNull();

  const on = await api("PUT", "/api/state", { useGhAccount: true });
  expect(on.status).toBe(200);
  // The default is stored as an absent key.
  expect((await readState(process.env.SPECDRIVEN_ROOT)).useGhAccount).toBeUndefined();
  expect((await getCurrentUser()).login).toBe(FAKE_GH_ACCOUNT.login);
  expect((await api("GET", "/api/state")).body.gh.inUse).toBe(true);

  expect((await api("PUT", "/api/state", { useGhAccount: "yes" })).status).toBe(400);
});

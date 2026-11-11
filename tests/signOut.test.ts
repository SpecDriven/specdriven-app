// specs/user-info-settings.feature.md "sign out from the user menu" and
// "the GitHub CLI is a Git access of its own": signing out clears the app's
// token; the GitHub CLI's account is used while it is the Git access chosen
// in Settings — for the chip, the commit author and the Issues tab — and
// signing out of the app leaves it alone. A stub gh on PATH stands in for
// the CLI.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../src/server/api";
import { getAuth } from "../src/server/auth";
import { resetGhCache } from "../src/server/git/gh";
import { setGitEngine } from "../src/server/git";
import { issuesToken } from "../src/server/issues";
import { readState, writeState } from "../src/server/state";
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
});

afterEach(async () => {
  fakeGh.restore();
  setGitEngine(null);
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

test("with the GitHub CLI as the Git access, gh's account is the one in use", async () => {
  expect((await getCurrentUser()).login).toBe(FAKE_GH_ACCOUNT.login);
  expect(await issuesToken()).not.toBeNull();
  const state = (await api("GET", "/api/state")).body;
  expect(state.gitAccess).toBe("gh");
  expect(state.gh.inUse).toBe(true);
});

test("the app's own token is not used while the GitHub CLI is the Git access", async () => {
  await saveToken({ token: "tok", login: "app-user", name: null, email: "1+app-user@users.noreply.github.com", id: 1 });
  expect((await getCurrentUser()).login).toBe(FAKE_GH_ACCOUNT.login);
});

test("sign out clears the app's token and leaves the GitHub CLI alone", async () => {
  setGitEngine("cli");
  await saveToken({ token: "tok", login: "app-user", name: null, email: "1+app-user@users.noreply.github.com", id: 1 });
  expect((await getCurrentUser()).login).toBe("app-user");
  expect((await api("GET", "/api/state")).body.gh.inUse).toBe(false);

  const out = await api("DELETE", "/api/auth/github");
  expect(out.status).toBe(200);
  expect(await getAuth()).toBeNull();
  expect((await getCurrentUser()).login).toBeNull();
  // Nothing about gh is written on the way out.
  expect((await readState(process.env.SPECDRIVEN_ROOT)).useGhAccount).toBeUndefined();

  // Picking the GitHub CLI again uses gh's account, as before.
  setGitEngine("gh");
  expect((await getCurrentUser()).login).toBe(FAKE_GH_ACCOUNT.login);
});

test("log out clears the app's token and closes the open folder, keeping the folder lists", async () => {
  setGitEngine("cli");
  const data = join(dir, "specs");
  await mkdir(data, { recursive: true });
  await writeState({ dataRepo: data, recentFolders: [{ path: data, kind: "spec" }] }, process.env.SPECDRIVEN_ROOT);
  await saveToken({ token: "tok", login: "app-user", name: null, email: "1+app-user@users.noreply.github.com", id: 1 });
  expect((await api("GET", "/api/state")).body.needsFolder).toBe(false);

  const out = await api("POST", "/api/logout");
  expect(out.status).toBe(200);
  expect(out.body.needsFolder).toBe(true);
  expect(await getAuth()).toBeNull();
  const state = await readState(process.env.SPECDRIVEN_ROOT);
  expect(state.dataRepo).toBeUndefined();
  expect(state.openCodeRepo).toBeUndefined();
  expect(state.recentFolders).toEqual([{ path: data, kind: "spec" }]);
  // A reload opens on the first-run screen too.
  expect((await api("GET", "/api/state")).body.needsFolder).toBe(true);
});

test("log out closes an open code repository too", async () => {
  const code = join(dir, "code");
  await mkdir(code, { recursive: true });
  await writeState({ openCodeRepo: code }, process.env.SPECDRIVEN_ROOT);
  expect((await api("GET", "/api/state")).body.needsFolder).toBe(false);

  expect((await api("POST", "/api/logout")).body.needsFolder).toBe(true);
  expect((await readState(process.env.SPECDRIVEN_ROOT)).openCodeRepo).toBeUndefined();
});

// Automates specs/app/user-info-settings.feature.md "Git access": Settings
// picks where git's GitHub credentials come from — the GitHub CLI (the gh
// engine), a personal access token, or the GitHub account sign-in (behind
// its switch), the last two on system git. A stub gh on PATH stands in for
// the CLI.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { currentEngine, setAppSignIn, setGitEngine } from "../src/server/git";
import { effectiveGitAccess } from "../src/server/git/access";
import { signInHint } from "../src/server/git/cli";
import { resetGhCache } from "../src/server/git/gh";
import { readState, writeState } from "../src/server/state";
import { installFakeGh, type FakeGh } from "./helpers/binPath";

let root: string;
let home: string;
let fakeGh: FakeGh;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-git-access-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-git-access-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  fakeGh = installFakeGh();
  setGitEngine(null);
  await writeState({ dataRepo: join(root, "data") }, root);
});

afterEach(async () => {
  reloader.stop();
  fakeGh.restore();
  setGitEngine(null);
  setAppSignIn("token");
  resetGhCache();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const put = async (body: unknown) => {
  const res = (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ))!;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const getState = async () =>
  (await (await handleApi(new Request("http://localhost/api/state")))!.json()) as Record<string, any>;

test("with gh installed and nothing chosen, the GitHub CLI is the Git access", async () => {
  expect((await getState()).gitAccess).toBe("gh");
  expect(currentEngine()).toBe("gh");
});

test("picking a Git access sets the engine it runs on", async () => {
  const token = await put({ gitAccess: "token" });
  expect(token.status).toBe(200);
  expect(token.body.gitAccess).toBe("token");
  expect(currentEngine()).toBe("cli");
  // The token is the default app sign-in, stored as an absent key.
  expect(await readState(root)).toMatchObject({ gitEngine: "cli" });
  expect((await readState(root)).gitAccess).toBeUndefined();

  const gh = await put({ gitAccess: "gh" });
  expect(gh.body.gitAccess).toBe("gh");
  expect(currentEngine()).toBe("gh");
  expect((await readState(root)).gitEngine).toBe("gh");

  expect((await put({ gitAccess: "auto" })).status).toBe(400);
});

test("the GitHub account access needs its switch on, and falls back to the token when it goes off", async () => {
  const refused = await put({ gitAccess: "account" });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain("GitHub account switch");

  const on = await put({ githubAccount: true, gitAccess: "account" });
  expect(on.status).toBe(200);
  expect(on.body.gitAccess).toBe("account");
  expect(await readState(root)).toMatchObject({ gitEngine: "cli", gitAccess: "account" });
  expect(signInHint()).toBe("authentication required — sign in with GitHub in Settings");

  const off = await put({ githubAccount: false });
  expect(off.body.gitAccess).toBe("token");
  expect(signInHint()).toBe("authentication required — add a GitHub personal access token in Settings");
  // The choice is kept for when the switch comes back on.
  expect((await readState(root)).gitAccess).toBe("account");
  expect(effectiveGitAccess("cli", "account", true)).toBe("account");
});

test("a failed sign-in names the way in the chosen Git access offers", async () => {
  setGitEngine("gh");
  expect(signInHint()).toContain("gh auth login");
  expect(signInHint()).not.toContain("sign in with GitHub");
  setGitEngine("cli");
  expect(signInHint()).toBe("authentication required — add a GitHub personal access token in Settings");
});

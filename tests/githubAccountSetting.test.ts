// Automates specs/app/user-info-settings.feature.md "GitHub account behind a
// switch": the GitHub account is not ready, so the `githubAccount` setting
// that shows it is off unless turned on, and stored as an absent key when off.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { normalizeGithubAccount, readState, writeState } from "../src/server/state";

let root: string;
let home: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-gh-account-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-gh-account-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  reloader.stop();
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

const put = async (body: unknown) =>
  (await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ))!;

test("the GitHub account setting is off by default and round-trips through the settings file", async () => {
  expect(normalizeGithubAccount(undefined)).toBe(false);
  await writeState({ dataRepo: join(root, "data") }, root);
  const before = (await handleApi(new Request("http://localhost/api/state")))!;
  expect(((await before.json()) as { githubAccount: boolean }).githubAccount).toBe(false);

  const on = await put({ githubAccount: true });
  expect(on.status).toBe(200);
  expect(((await on.json()) as { githubAccount: boolean }).githubAccount).toBe(true);
  expect((await readState(root)).githubAccount).toBe(true);

  const off = await put({ githubAccount: false });
  expect(((await off.json()) as { githubAccount: boolean }).githubAccount).toBe(false);
  // Off is the default, stored as an absent key.
  expect((await readState(root)).githubAccount).toBeUndefined();
  expect((await put({ githubAccount: "yes" })).status).toBe(400);
});

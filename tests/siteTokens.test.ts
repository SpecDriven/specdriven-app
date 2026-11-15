// The per-site token stores as the app calls them: the Promise functions of
// jiraTokens.ts (confluenceTokens.ts, ahaTokens.ts and qtestTokens.ts are the
// same functions for another kind — src/server/siteTokens.ts), run on the
// app's own runtime. The service underneath is tested in
// tests/persistence/siteTokens.test.ts.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ahaToken, createAhaFileBackend, saveAhaToken, setAhaTokenBackend } from "../src/server/ahaTokens";
import {
  clearJiraToken,
  createJiraFileBackend,
  jiraToken,
  listJiraTokens,
  saveJiraToken,
  setJiraTokenBackend,
  type JiraTokenBackend,
  type JiraTokenRecord,
} from "../src/server/jiraTokens";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "specdriven-site-tokens-"));
  setJiraTokenBackend(createJiraFileBackend(join(home, "jira-tokens.json")));
  setAhaTokenBackend(createAhaFileBackend(join(home, "aha-tokens.json")));
});

afterEach(async () => {
  setJiraTokenBackend(createJiraFileBackend());
  setAhaTokenBackend(createAhaFileBackend());
  await rm(home, { recursive: true, force: true });
});

const ACME: JiraTokenRecord = { base: "https://jira.acme.test", token: "acme-token", user: "Ada" };
const OTHER: JiraTokenRecord = { base: "https://jira.other.test", token: "other-token", user: "Grace" };

test("the list of sites names who each token signs in as and never carries a token", async () => {
  await saveJiraToken(ACME);
  await saveJiraToken(OTHER);
  const listed = await listJiraTokens();
  expect(listed).toEqual([
    { base: ACME.base, user: "Ada" },
    { base: OTHER.base, user: "Grace" },
  ]);
  expect(JSON.stringify(listed)).not.toContain("token");
  expect(await jiraToken(`${ACME.base}/`)).toEqual(ACME);

  await clearJiraToken(ACME.base);
  expect(await jiraToken(ACME.base)).toBe(null);
  expect(await listJiraTokens()).toEqual([{ base: OTHER.base, user: "Grace" }]);
});

test("tokens for several sites saved at once are all kept", async () => {
  const sites = Array.from({ length: 6 }, (_, i) => ({ base: `https://jira-${i}.acme.test`, token: `t${i}`, user: "" }));
  await Promise.all(sites.map((site) => saveJiraToken(site)));
  expect((await listJiraTokens()).map((s) => s.base).sort()).toEqual(sites.map((s) => s.base));
  const onDisk = JSON.parse(await readFile(join(home, "jira-tokens.json"), "utf8")) as JiraTokenRecord[];
  expect(onDisk.map((r) => r.token).sort()).toEqual(sites.map((s) => s.token));
});

test("one kind's tokens are not another's", async () => {
  await saveJiraToken(ACME);
  expect(await ahaToken(ACME.base)).toBe(null);
  await saveAhaToken({ base: "https://acme.aha.io", token: "aha-key", user: "Ada" });
  expect((await listJiraTokens()).map((s) => s.base)).toEqual([ACME.base]);
});

test("a backend that refuses rejects with its own error, and what was saved before stays", async () => {
  const refusal = new Error("keychain is locked");
  const locked: JiraTokenBackend = {
    load: async () => [ACME],
    save: async () => {
      throw refusal;
    },
    clear: async () => {
      throw refusal;
    },
  };
  setJiraTokenBackend(locked);
  expect(await saveJiraToken(OTHER).catch((e) => e)).toBe(refusal);
  expect(await clearJiraToken(ACME.base).catch((e) => e)).toBe(refusal);
  expect(await listJiraTokens()).toEqual([{ base: ACME.base, user: "Ada" }]);
});

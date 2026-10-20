// The Claude API proxy's token store (specs/agents/claude.feature.md "API
// proxy settings are filled in from Claude Code's settings"): a 0600 file
// under the app's home, read once and cached, corrupt means no token.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeTokenPath,
  clearClaudeToken,
  createClaudeFileBackend,
  loadClaudeToken,
  parseClaudeRecord,
  saveClaudeToken,
  setClaudeTokenBackend,
} from "../src/server/claudeToken";

const realHome = process.env.SPECDRIVEN_HOME;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "specdriven-claude-token-"));
  process.env.SPECDRIVEN_HOME = home;
  setClaudeTokenBackend(createClaudeFileBackend());
});

afterEach(async () => {
  setClaudeTokenBackend(createClaudeFileBackend());
  await rm(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.SPECDRIVEN_HOME;
  else process.env.SPECDRIVEN_HOME = realHome;
});

test("the token round-trips through an owner-only file under the app's home", async () => {
  expect(await loadClaudeToken()).toBeNull();
  await saveClaudeToken({ token: "proxy-secret" });
  expect(claudeTokenPath()).toBe(join(home, "claude-token.json"));
  expect((await stat(claudeTokenPath())).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(claudeTokenPath(), "utf8"))).toEqual({ token: "proxy-secret" });
  // A fresh backend reads it back; the cache is reset with the backend.
  setClaudeTokenBackend(createClaudeFileBackend());
  expect(await loadClaudeToken()).toEqual({ token: "proxy-secret" });
  await clearClaudeToken();
  expect(await loadClaudeToken()).toBeNull();
  setClaudeTokenBackend(createClaudeFileBackend());
  expect(await loadClaudeToken()).toBeNull();
});

test("a corrupt or empty token file reads as no token", async () => {
  await writeFile(claudeTokenPath(), "{ not json");
  expect(await loadClaudeToken()).toBeNull();
  expect(parseClaudeRecord(JSON.stringify({ token: "" }))).toBeNull();
  expect(parseClaudeRecord(JSON.stringify({ token: 7 }))).toBeNull();
  expect(parseClaudeRecord("null")).toBeNull();
  expect(parseClaudeRecord(JSON.stringify({ token: "t", extra: 1 }))).toEqual({ token: "t" });
});

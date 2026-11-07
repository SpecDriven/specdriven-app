// Automates specs/external-links/confluence-wiki.feature.md "An agent
// session can read the wiki" on the core's side (src/server/agentMcp.ts):
// which MCP servers a session starting now is handed — the Confluence
// server while a wiki token is saved, none otherwise, none in the demo or
// hosted app — and how the desktop app points it at its own bundle and file.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentMcpServers, setConfluenceMcpLauncher, setConfluenceMcpTokensFile } from "../src/server/agentMcp";
import {
  clearConfluenceToken,
  createConfluenceFileBackend,
  exportConfluenceTokens,
  onConfluenceTokensChanged,
  saveConfluenceToken,
  setConfluenceTokenBackend,
} from "../src/server/confluenceTokens";

let home: string;
const realHome = process.env.SPECDRIVEN_HOME;
const realRoot = process.env.SPECDRIVEN_ROOT;
const ENV = ["DEMO_MODE", "SPECDRIVEN_HOSTED"] as const;
const realEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

/** Write the settings file SPECDRIVEN_ROOT points agentMcpServers() at. */
async function writeSettings(state: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, ".specdriven"), { recursive: true });
  await writeFile(join(home, ".specdriven", "settings.json"), JSON.stringify(state));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "specdriven-agent-mcp-"));
  process.env.SPECDRIVEN_HOME = home;
  process.env.SPECDRIVEN_ROOT = home;
  for (const k of ENV) delete process.env[k];
  setConfluenceTokenBackend(createConfluenceFileBackend(join(home, "confluence-tokens.json")));
  // Confluence on by default for these tests; the off case is its own test.
  await writeSettings({ confluenceEnabled: true });
});

afterEach(async () => {
  onConfluenceTokensChanged(null);
  setConfluenceMcpLauncher(null);
  setConfluenceMcpTokensFile(null);
  setConfluenceTokenBackend(createConfluenceFileBackend());
  if (realHome === undefined) delete process.env.SPECDRIVEN_HOME;
  else process.env.SPECDRIVEN_HOME = realHome;
  if (realRoot === undefined) delete process.env.SPECDRIVEN_ROOT;
  else process.env.SPECDRIVEN_ROOT = realRoot;
  for (const k of ENV) {
    if (realEnv[k] === undefined) delete process.env[k];
    else process.env[k] = realEnv[k]!;
  }
  await rm(home, { recursive: true, force: true });
});

test("no wiki token, no server", async () => {
  expect(await agentMcpServers()).toEqual([]);
});

test("Confluence switched off in Settings hands out none, even with a saved token", async () => {
  await writeSettings({ confluenceEnabled: false });
  await saveConfluenceToken({ base: "https://wiki.acme.com", token: "pat", user: "me" });
  expect(await agentMcpServers()).toEqual([]);
});

test("Confluence absent from Settings (the default) hands out none, even with a saved token", async () => {
  await writeSettings({});
  await saveConfluenceToken({ base: "https://wiki.acme.com", token: "pat", user: "me" });
  expect(await agentMcpServers()).toEqual([]);
});

test("a saved token brings the Confluence server, run from the app's source with its token file", async () => {
  await saveConfluenceToken({ base: "https://wiki.acme.com", token: "pat", user: "me" });
  const servers = await agentMcpServers();
  expect(servers).toHaveLength(1);
  const [s] = servers;
  expect(s!.name).toBe("specdriven-confluence");
  expect(s!.command).toBe(process.execPath);
  expect(s!.args).toHaveLength(1);
  expect(s!.args[0]).toEndWith(join("src", "mcp", "confluence.ts"));
  expect(s!.env).toEqual({ SPECDRIVEN_CONFLUENCE_TOKENS_FILE: join(home, "confluence-tokens.json") });
  // Never the token itself.
  expect(JSON.stringify(servers)).not.toContain("pat");
});

test("the demo and the hosted app hand out none", async () => {
  await saveConfluenceToken({ base: "https://wiki.acme.com", token: "pat", user: "me" });
  process.env.DEMO_MODE = "1";
  expect(await agentMcpServers()).toEqual([]);
  delete process.env.DEMO_MODE;
  process.env.SPECDRIVEN_HOSTED = "1";
  expect(await agentMcpServers()).toEqual([]);
});

test("the desktop app says how to run it and where the tokens are", async () => {
  await saveConfluenceToken({ base: "https://wiki.acme.com", token: "pat", user: "me" });
  setConfluenceMcpLauncher(() => ({ command: "/Applications/SpecDriven.app/Contents/MacOS/SpecDriven", args: ["/bundle/mcp/confluence.js"], env: { ELECTRON_RUN_AS_NODE: "1" } }));
  setConfluenceMcpTokensFile(async () => "/userData/confluence-tokens.mcp.json");
  expect(await agentMcpServers()).toEqual([
    {
      name: "specdriven-confluence",
      command: "/Applications/SpecDriven.app/Contents/MacOS/SpecDriven",
      args: ["/bundle/mcp/confluence.js"],
      env: { ELECTRON_RUN_AS_NODE: "1", SPECDRIVEN_CONFLUENCE_TOKENS_FILE: "/userData/confluence-tokens.mcp.json" },
    },
  ]);
});

test("the desktop app's export is the records, tokens included, owner-only, and follows every change", async () => {
  const file = join(home, "confluence-tokens.mcp.json");
  const changes: number[] = [];
  onConfluenceTokensChanged((records) => changes.push(records.length));
  await saveConfluenceToken({ base: "https://wiki.acme.com", token: "pat", user: "me" });
  expect(await exportConfluenceTokens(file)).toBe(file);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual([{ base: "https://wiki.acme.com", token: "pat", user: "me" }]);
  await saveConfluenceToken({ base: "https://wiki.other.com", token: "pat2", user: "me" });
  await clearConfluenceToken("https://wiki.acme.com");
  expect(changes).toEqual([1, 2, 1]);
  await exportConfluenceTokens(file);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual([{ base: "https://wiki.other.com", token: "pat2", user: "me" }]);
});

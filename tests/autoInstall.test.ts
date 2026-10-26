// Agent plugins installed for the commands found on this machine
// (src/plugins/host/autoInstall.ts, specs/agents/agent-plugins.feature.md
// "Agent plugins are installed for the commands found on this machine"):
// a marketplace row that names an agent whose command is on PATH is
// installed once; one the user removed is not installed again; a
// marketplace that cannot be reached installs nothing and says so. The
// offers the pane shows come from the cached indexes alone. Driven here
// with fakes for the marketplace, PATH and the installer.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentOffers, autoInstalled, ensureCommandPlugins, rememberAutoInstalled } from "../src/plugins/host/autoInstall";
import { marketplacesHome } from "../src/plugins/host/sources";
import { parseMarketplaceIndex, type MarketplacePlugin, type MarketplaceRef } from "../src/plugins/marketplace";

const realHome = process.env.SPECDRIVEN_HOME;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "specdriven-auto-install-"));
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.SPECDRIVEN_HOME;
  else process.env.SPECDRIVEN_HOME = realHome;
});

const market: MarketplaceRef = { name: "specdriven", source: "https://example.test/plugins" };
const rows: MarketplacePlugin[] = [
  { name: "agent-claude", source: "./plugins/agent-claude", description: "Claude", agent: { id: "claude", command: "claude" } },
  { name: "agent-codex", source: "./plugins/agent-codex", description: "Codex", agent: { id: "codex", command: "codex" } },
  { name: "agent-pi", source: "./plugins/agent-pi", description: "Pi", agent: { id: "pi", command: "pi" } },
  { name: "models", source: "./plugins/models", description: "Event models" },
];

test("the index's agent field is read when it names an id and a command", () => {
  const index = parseMarketplaceIndex({
    name: "m",
    plugins: [
      { name: "a", source: "./a", agent: { id: "gemini", command: " gemini " } },
      { name: "b", source: "./b", agent: { id: "x" } },
      { name: "c", source: "./c", agent: "gemini" },
    ],
  });
  expect(index.plugins.map((p) => p.agent)).toEqual([{ id: "gemini", command: "gemini" }, undefined, undefined]);
});

test("installs the agent plugins whose commands are on PATH, once, and remembers them", async () => {
  const installed: string[] = [];
  const persisted: unknown[] = [];
  const state: Record<string, unknown> = { plugins: { repos: {} } };
  const deps = {
    marketplaces: [market],
    commandFound: (c: string) => c === "claude" || c === "pi",
    installed: async () => ["agent-pi"],
    install: async (_e: MarketplaceRef, name: string) => {
      installed.push(name);
    },
    indexes: async () => [{ entry: market, plugins: rows }],
    log: () => {},
  };
  const first = await ensureCommandPlugins(state, async (s) => void persisted.push(structuredClone(s)), deps);
  expect(first.installed).toEqual(["agent-claude"]);
  expect(first.skipped).toEqual([
    { name: "agent-codex", why: "no `codex` on PATH" },
    { name: "agent-pi", why: "installed" },
  ]);
  expect(first.errors).toEqual([]);
  expect(autoInstalled(state)).toEqual(["agent-claude"]);
  expect(persisted).toHaveLength(1);

  // Gone from the plugin folders since (removed by the user): not installed
  // again, even with the command there.
  const second = await ensureCommandPlugins(state, async () => {}, deps);
  expect(second.installed).toEqual([]);
  expect(second.skipped).toContainEqual({ name: "agent-claude", why: "removed by the user" });
  expect(installed).toEqual(["agent-claude"]);
  rememberAutoInstalled(state, "agent-claude");
  expect(autoInstalled(state)).toEqual(["agent-claude"]);
});

test("a marketplace that cannot be reached, or an install that fails, installs nothing and is reported", async () => {
  const lines: string[] = [];
  const state: Record<string, unknown> = {};
  const result = await ensureCommandPlugins(state, async () => {}, {
    marketplaces: [market, { name: "other", source: "https://example.test/other" }],
    commandFound: () => true,
    installed: async () => [],
    install: async (_e, name) => {
      if (name === "agent-codex") throw new Error("clone failed");
    },
    indexes: async () => [
      { entry: market, plugins: rows.slice(0, 2) },
      { entry: { name: "other", source: "x" }, plugins: [], error: "offline" },
    ],
    log: (line) => lines.push(line),
  });
  expect(result.installed).toEqual(["agent-claude"]);
  expect(result.errors).toEqual(["agent-codex: clone failed", "other: offline"]);
  expect(lines.some((l) => l.includes("other not reachable"))).toBe(true);
  expect(autoInstalled(state)).toEqual(["agent-claude"]);
});

test("the offers come from the cached indexes on disk, for agents no plugin registers", async () => {
  const dir = join(marketplacesHome(), "specdriven");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "marketplace.json"), JSON.stringify({ name: "specdriven", plugins: rows }));
  const offers = await agentOffers({}, ["claude"], {
    marketplaces: [market, { name: "missing", source: "x" }],
    commandFound: (c) => c === "codex",
  });
  expect(offers).toEqual([
    { plugin: "agent-codex", marketplace: "specdriven", label: "Codex", description: "Codex", cli: "codex", cliFound: true },
    { plugin: "agent-pi", marketplace: "specdriven", label: "Pi", description: "Pi", cli: "pi", cliFound: false },
  ]);
  expect(await agentOffers({}, ["claude", "codex", "pi"], { marketplaces: [market] })).toEqual([]);
});

// Which installed plugins the start offers to update (specs/app/plugins
// .feature.md "Plugins with an update are offered in a dialog at start"):
// a marketplace plugin whose index row names a newer version, or pins
// another ref — never an older one, a linked folder, or a row the app
// refuses. And which marketplace is the default one: by its url.

import { expect, test } from "bun:test";
import { startupUpdates } from "../src/plugins/host/autoInstall";
import {
  compareVersions,
  isDefaultMarketplace,
  pluginUpdates,
  type InstallRecord,
  type MarketplaceIndex,
  type MarketplaceRef,
} from "../src/plugins/marketplace";

test("versions compare part by part, a pre-release before its release", () => {
  expect(compareVersions("1.10.0", "1.9.2")).toBeGreaterThan(0);
  expect(compareVersions("1.2", "1.2.0")).toBe(0);
  expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
  expect(compareVersions("1.2.0-beta", "1.2.0")).toBeLessThan(0);
  expect(compareVersions("1.2.0", "1.2.0-beta")).toBeGreaterThan(0);
  expect(compareVersions("1.16.0", "1.17.0")).toBeLessThan(0);
});

test("the default marketplace is known by its url, whatever its name", () => {
  expect(isDefaultMarketplace({ name: "specdriven", source: "https://github.com/SpecDriven/plugins" })).toBe(true);
  expect(isDefaultMarketplace({ name: "plugins", source: "https://github.com/specdriven/plugins.git/" })).toBe(true);
  expect(isDefaultMarketplace({ name: "specdriven", source: "https://example.test/plugins" })).toBe(false);
});

const market: MarketplaceRef = { name: "plugins", source: "https://github.com/SpecDriven/plugins" };
const record = (name: string, extra: Partial<InstallRecord> = {}): InstallRecord => ({
  marketplace: "plugins",
  name,
  source: `./plugins/${name}`,
  installedAt: "2026-11-01T00:00:00.000Z",
  ...extra,
});
const index: MarketplaceIndex = {
  name: "specdriven",
  plugins: [
    { name: "agent-claude", source: "./plugins/agent-claude", description: "", version: "1.17.0" },
    { name: "agent-codex", source: "./plugins/agent-codex", description: "", version: "1.3.0" },
    { name: "agent-pi", source: "./plugins/agent-pi", description: "", version: "1.1.0" },
    { name: "pinned", source: "https://example.test/pinned.git", ref: "v2", description: "" },
    { name: "future", source: "./plugins/future", description: "", version: "9.0.0", api: "99" },
  ],
};

test("a plugin whose index row is newer, or pinned to another ref, is offered; nothing else is", () => {
  const updates = pluginUpdates(
    [
      // Newer in the index: offered, from the manifest's version.
      { id: "agent-claude", displayName: "Claude", version: "1.16.0", install: record("agent-claude", { version: "1.16.0" }) },
      // The same version: not offered.
      { id: "agent-codex", version: "1.3.0", install: record("agent-codex", { version: "1.3.0" }) },
      // Installed ahead of a stale index: never offered a downgrade.
      { id: "agent-pi", version: "1.2.0", install: record("agent-pi", { version: "1.2.0" }) },
      // The pin moved: offered, named by its ref.
      { id: "pinned", version: "1.0.0", install: record("pinned", { ref: "v1", source: "https://example.test/pinned.git" }) },
      // A row the app refuses: not offered.
      { id: "future", version: "1.0.0", install: record("future") },
      // Linked from a folder — no install record: not offered.
      { id: "linked", version: "0.1.0" },
      // From a marketplace with no index here: not offered.
      { id: "elsewhere", version: "0.1.0", install: record("elsewhere", { marketplace: "gone" }) },
    ],
    [{ entry: market, index }],
  );
  expect(updates).toEqual([
    { id: "agent-claude", displayName: "Claude", marketplace: "plugins", from: "1.16.0", to: "1.17.0" },
    { id: "pinned", displayName: "pinned", marketplace: "plugins", from: "1.0.0", to: "v2" },
  ]);
});

test("the start's check reads the installed plugins against the indexes it is handed", async () => {
  const updates = await startupUpdates(
    {},
    {
      marketplaces: [market],
      installed: () => [{ id: "agent-codex", displayName: "Codex", version: "1.2.0", install: record("agent-codex") }],
      indexes: async (entries) => entries.map((entry) => ({ entry, index })),
    },
  );
  expect(updates).toEqual([{ id: "agent-codex", displayName: "Codex", marketplace: "plugins", from: "1.2.0", to: "1.3.0" }]);
  // With no marketplace reached on start, nothing is offered.
  expect(
    await startupUpdates({}, { marketplaces: [], installed: () => [{ id: "agent-codex", install: record("agent-codex") }], indexes: async () => [] }),
  ).toEqual([]);
});

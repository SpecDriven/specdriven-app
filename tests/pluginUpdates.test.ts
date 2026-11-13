// Which installed plugins the start offers to update (specs/app/plugins
// .feature.md "Plugins with an update are offered in a dialog at start"):
// a marketplace plugin whose index row names a newer version, or pins
// another ref — never an older one, a linked folder, or a row the app
// refuses. And which marketplace is the default one: by its url.
// A released plugin (specs/app/plugins.feature.md "A plugin is released as
// a versioned zip in its release folder") is measured against the versions
// its releases.json lists: offered the newest one this app can run, left
// alone while the user holds it at an older one, and moved off a version
// that was withdrawn.

import { expect, test } from "bun:test";
import { startupUpdates } from "../src/plugins/host/autoInstall";
import {
  compareVersions,
  isDefaultMarketplace,
  isPrerelease,
  newestInstallable,
  parseInstallRecord,
  parseReleases,
  pluginUpdates,
  releaseFileName,
  releaseOf,
  releaseRefusal,
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
    "0.1.270",
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

// ---- releases ------------------------------------------------------------------

const sha = (c: string) => c.repeat(64);

test("releases.json is read newest first, and refused when it is not a list of zips with checksums", () => {
  const releases = parseReleases(
    {
      plugin: "agent-claude",
      releases: [
        { version: "1.9.0", file: "agent-claude-1.9.0.zip", sha256: sha("A"), size: 10, date: "2026-10-01" },
        { version: "1.10.0", file: "agent-claude-1.10.0.zip", sha256: sha("b"), api: 1, minAppVersion: "0.1.196", notes: "Thinking", yanked: "" },
        { version: "1.10.0-beta", file: "agent-claude-1.10.0-beta.zip", sha256: sha("c"), yanked: "superseded" },
      ],
    },
    "agent-claude",
  );
  expect(releases.map((r) => r.version)).toEqual(["1.10.0", "1.10.0-beta", "1.9.0"]);
  expect(releases[0]).toEqual({ version: "1.10.0", file: "agent-claude-1.10.0.zip", sha256: sha("b"), api: "1", minAppVersion: "0.1.196", notes: "Thinking" });
  // The checksum is compared in lowercase.
  expect(releases[2]).toEqual({ version: "1.9.0", file: "agent-claude-1.9.0.zip", sha256: sha("a"), size: 10, date: "2026-10-01" });
  expect(releases[1]!.yanked).toBe("superseded");
  expect(parseReleases({ releases: [] })).toEqual([]);

  const one = (row: Record<string, unknown>) => () => parseReleases({ releases: [{ version: "1.0.0", file: "a-1.0.0.zip", sha256: sha("a"), ...row }] });
  expect(() => parseReleases([])).toThrow("not an object");
  expect(() => parseReleases({})).toThrow('no "releases" list');
  expect(() => parseReleases({ plugin: "other", releases: [] }, "mine")).toThrow('is for "other", not "mine"');
  expect(one({ version: "latest" })).toThrow('"latest" is not a version');
  expect(one({ version: undefined })).toThrow("has no version");
  expect(one({ file: "../a.zip" })).toThrow("not a zip in the release folder");
  expect(one({ file: "sub/a.zip" })).toThrow("not a zip in the release folder");
  expect(one({ file: "a.tgz" })).toThrow("not a zip in the release folder");
  expect(one({ file: undefined })).toThrow("names no file");
  expect(one({ sha256: "abc" })).toThrow("no SHA-256 checksum");
  expect(() =>
    parseReleases({ releases: [{ version: "1.0", file: "a.zip", sha256: sha("a") }, { version: "1.0.0", file: "b.zip", sha256: sha("b") }] }),
  ).toThrow("listed twice");
  expect(() =>
    parseReleases({ releases: [{ version: "1.0.0", file: "a.zip", sha256: sha("a") }, { version: "1.1.0", file: "a.zip", sha256: sha("b") }] }),
  ).toThrow("a.zip is listed twice");
});

test("a release is named after its plugin and version, a scope folded into the name", () => {
  expect(releaseFileName("agent-claude", "1.19.0")).toBe("agent-claude-1.19.0.zip");
  expect(releaseFileName("@acme/jira-tab", "0.3.1-beta")).toBe("acme-jira-tab-0.3.1-beta.zip");
  // What it names is a file parseReleases accepts.
  expect(parseReleases({ releases: [{ version: "0.3.1-beta", file: releaseFileName("@acme/jira-tab", "0.3.1-beta"), sha256: sha("a") }] })).toHaveLength(1);
});

const released = parseReleases({
  releases: [
    { version: "2.0.0", file: "p-2.0.0.zip", sha256: sha("a"), minAppVersion: "0.2.0" },
    { version: "1.4.0-beta", file: "p-1.4.0-beta.zip", sha256: sha("b") },
    { version: "1.3.0", file: "p-1.3.0.zip", sha256: sha("c"), yanked: "loses settings" },
    { version: "1.2.0", file: "p-1.2.0.zip", sha256: sha("d"), minAppVersion: "0.1.200" },
    { version: "1.1.0", file: "p-1.1.0.zip", sha256: sha("e"), api: "2" },
    { version: "1.0.0", file: "p-1.0.0.zip", sha256: sha("f") },
  ],
});

test("a release this app cannot run says why; the newest it can run is what Install means", () => {
  const by = (v: string) => releaseOf(released, v)!;
  expect(releaseRefusal(by("2.0.0"), "0.1.270")).toBe("version 2.0.0 needs SpecDriven 0.2.0 or newer; this is 0.1.270");
  expect(releaseRefusal(by("2.0.0"), "0.2.0")).toBeNull();
  expect(releaseRefusal(by("1.3.0"), "0.1.270")).toBe("version 1.3.0 was withdrawn: loses settings");
  expect(releaseRefusal(by("1.1.0"), "0.1.270")).toBe("version 1.1.0 needs plugin api 2; this app speaks api 1");
  expect(releaseRefusal(by("1.2.0"), "0.1.270")).toBeNull();
  expect(releaseOf(released, "v1.2")?.version).toBe("1.2.0");
  expect(releaseOf(released, "1.5.0")).toBeUndefined();
  expect(isPrerelease("1.4.0-beta")).toBe(true);
  expect(isPrerelease("1.4.0")).toBe(false);

  // An app new enough takes the newest; an older one the newest it can run,
  // passing over the pre-release, the withdrawn one and the other api.
  expect(newestInstallable(released, "0.2.5")?.version).toBe("2.0.0");
  expect(newestInstallable(released, "0.1.270")?.version).toBe("1.2.0");
  expect(newestInstallable(released, "0.1.190")?.version).toBe("1.0.0");
  expect(newestInstallable([by("2.0.0"), by("1.3.0")], "0.1.270")).toBeUndefined();
  expect(newestInstallable([], "0.1.270")).toBeUndefined();
});

test("an install record keeps the checksum, the version it replaced and the hold", () => {
  expect(
    parseInstallRecord({ marketplace: "m", name: "p", source: "./plugins/p", version: "1.0.0", sha256: sha("a"), previous: "1.2.0", held: true, installedAt: "t" }),
  ).toEqual({ marketplace: "m", name: "p", source: "./plugins/p", version: "1.0.0", sha256: sha("a"), previous: "1.2.0", held: true, installedAt: "t" });
  // A record an older app wrote has none of them.
  expect(parseInstallRecord({ marketplace: "m", name: "p", source: "./plugins/p", held: "yes", installedAt: "t" })).toEqual({
    marketplace: "m",
    name: "p",
    source: "./plugins/p",
    installedAt: "t",
  });
});

test("a released plugin is offered the newest version this app runs — unless held — and moved off a withdrawn one", () => {
  const releasedIndex: MarketplaceIndex = {
    name: "specdriven",
    plugins: [
      // The row's own version is the newest; this app cannot run it.
      { name: "p", source: "./plugins/p", description: "", version: "2.0.0", releases: released },
      { name: "bad", source: "./plugins/bad", description: "", version: "9.0.0", releasesError: "release/releases.json: no list" },
      { name: "none", source: "./plugins/none", description: "", version: "9.0.0", releases: [releaseOf(released, "2.0.0")!] },
    ],
  };
  const check = (version: string, extra: Partial<InstallRecord> = {}, app = "0.1.270") =>
    pluginUpdates([{ id: "p", version, install: record("p", { version, ...extra }) }], [{ entry: market, index: releasedIndex }], app);
  const offer = (from: string, to: string) => [{ id: "p", displayName: "p", marketplace: "plugins", from, to }];

  // Behind the newest this app runs: offered that one, not the row's 2.0.0.
  expect(check("1.0.0")).toEqual(offer("1.0.0", "1.2.0"));
  // On it: nothing, though 2.0.0 and a beta are newer.
  expect(check("1.2.0")).toEqual([]);
  // A newer app is offered 2.0.0.
  expect(check("1.2.0", {}, "0.2.0")).toEqual(offer("1.2.0", "2.0.0"));
  // Held at an older version by the user: not offered.
  expect(check("1.0.0", { held: true })).toEqual([]);
  // On a pre-release ahead of the newest stable: never offered a step back.
  expect(check("1.4.0-beta")).toEqual([]);
  // On a withdrawn version: offered the newest good one, older though it is, held or not.
  expect(check("1.3.0")).toEqual(offer("1.3.0", "1.2.0"));
  expect(check("1.3.0", { held: true })).toEqual(offer("1.3.0", "1.2.0"));

  // A plugin whose releases.json cannot be read, or with nothing this app runs, is left alone.
  expect(
    pluginUpdates(
      [
        { id: "bad", version: "1.0.0", install: record("bad", { version: "1.0.0" }) },
        { id: "none", version: "1.0.0", install: record("none", { version: "1.0.0" }) },
      ],
      [{ entry: market, index: releasedIndex }],
      "0.1.270",
    ),
  ).toEqual([]);
});

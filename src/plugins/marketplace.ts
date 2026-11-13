// The marketplace (specs/app/plugins.feature.md "The marketplace is a git
// repository with an index", "A plugin from the marketplace is installed
// with consent"; roadmap/plugin-architecture.md "Discovery, profile,
// installation"): a git repository with `marketplace.json` at its root —
// the marketplace's name and owner and the plugins it lists, each with a
// source that is a git url pinned to a ref, or a subdirectory of the
// marketplace itself. Which marketplaces this machine reads is the
// profile's `plugins.marketplaces`, beside the enabled list; absent, the
// SpecDriven index. What an installed plugin remembers about where it came
// from is its install record. A plugin kept in a subdirectory may also be
// released (specs/app/plugins.feature.md "A plugin is released as a
// versioned zip in its release folder"): a `release` folder beside its
// source holds one zip per version and `releases.json`, which lists them
// with their checksums and what each needs of the app — so any of them can
// be installed, and an older one put back. All of it pure, shared by the
// server, the CLI and the browser.

import { API_MAJOR, PLUGIN_ID_PATTERN, compareVersions as compareAppVersions } from "./manifest";

/** A marketplace as the settings name it: a short name and a git url. */
export interface MarketplaceRef {
  /** The cache folder's name under `~/.specdriven/marketplaces`. */
  name: string;
  /** The git url the app clones and pulls through its own engine. */
  source: string;
}

/** One row of a marketplace index. */
export interface MarketplacePlugin {
  /** The plugin's id as the index names it — what Install is asked for. */
  name: string;
  /** A git url, or `./<subdirectory>` of the marketplace repository. */
  source: string;
  /** The tag, branch or commit a git source is pinned to; the default branch when absent. */
  ref?: string;
  description: string;
  version?: string;
  category?: string;
  /** The plugin api the index claims; the manifest's is checked again after the clone. */
  api?: string;
  /**
   * The coding agent the plugin supplies (specs/agents/agent-plugins
   * .feature.md): its provider id and the command it needs on PATH, which
   * the app installs the plugin for when it finds the command.
   */
  agent?: { id: string; command: string };
  /**
   * The versions released in the plugin's `release` folder, newest first —
   * read by the host from `releases.json`, never from the index itself.
   * A row without them is installed as its folder is now.
   */
  releases?: PluginRelease[];
  /** Why the plugin's `releases.json` could not be read; nothing of it installs. */
  releasesError?: string;
}

/** One released version of a plugin: a zip in its `release` folder. */
export interface PluginRelease {
  version: string;
  /** The zip's name in the `release` folder. */
  file: string;
  /** The zip's SHA-256, lowercase hex; a zip that does not match is refused. */
  sha256: string;
  size?: number;
  /** The day it was released, `YYYY-MM-DD`. */
  date?: string;
  /** The plugin api the version speaks. */
  api?: string;
  /** The oldest app the version runs in. */
  minAppVersion?: string;
  notes?: string;
  /** Why the version was withdrawn: never offered, and an install on it is moved off. */
  yanked?: string;
  /** Why this app cannot install the version, as the host lists it; absent when it can. */
  refusal?: string;
}

export interface MarketplaceIndex {
  name: string;
  owner?: { name: string; url?: string };
  plugins: MarketplacePlugin[];
}

/** The index this app reads when the settings name none. */
export const DEFAULT_MARKETPLACES: readonly MarketplaceRef[] = [
  { name: "specdriven", source: "https://github.com/SpecDriven/plugins" },
];

/** A marketplace name: one folder name, no scope, no dots leading. */
export const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The marketplaces the profile section names: `plugins.marketplaces` as
 * `{ name, source }` rows, malformed rows dropped. The SpecDriven index is
 * always among them, first when the list does not name it (by its url,
 * under whatever name): it cannot be removed (specs/app/plugins.feature.md
 * "The SpecDriven marketplace cannot be removed").
 */
export function marketplaceEntries(section: Record<string, unknown>): MarketplaceRef[] {
  const raw = section.marketplaces;
  return withDefaultMarketplaces(Array.isArray(raw) ? raw : []);
}

// The marketplaces every list holds. The test preload empties it, so a test
// that names a local marketplace does not also clone the SpecDriven one from
// GitHub; the tests of the default put it back. Never changed by the app.
let permanent: readonly MarketplaceRef[] = DEFAULT_MARKETPLACES;

/** Replace the marketplaces every list holds; null restores the default. For tests only. */
export function setPermanentMarketplacesForTests(list: readonly MarketplaceRef[] | null): void {
  permanent = list ?? DEFAULT_MARKETPLACES;
}

/** The marketplaces every list holds: the SpecDriven one. */
export function permanentMarketplaces(): readonly MarketplaceRef[] {
  return permanent;
}

/**
 * Settings rows as marketplaces, malformed ones and repeated names dropped,
 * with each default marketplace the rows do not name put first.
 */
export function withDefaultMarketplaces(raw: readonly unknown[]): MarketplaceRef[] {
  const rows: MarketplaceRef[] = [];
  for (const row of raw) {
    const ref = marketplaceRef(row);
    if (ref && !rows.some((r) => r.name === ref.name)) rows.push(ref);
  }
  const missing = permanent.filter(
    (d) => !rows.some((r) => normalizedSource(r.source) === normalizedSource(d.source)),
  );
  // A row that took a default's name for another url gives the name up.
  const out = [...missing];
  for (const row of rows) {
    let name = row.name;
    for (let n = 2; out.some((r) => r.name === name); n++) name = `${row.name}-${n}`;
    out.push(name === row.name ? row : { ...row, name });
  }
  return out;
}

/** One settings row as a marketplace, or null for a malformed one. */
export function marketplaceRef(row: unknown): MarketplaceRef | null {
  if (!row || typeof row !== "object") return null;
  const { name, source } = row as { name?: unknown; source?: unknown };
  if (typeof name !== "string" || !MARKETPLACE_NAME_PATTERN.test(name)) return null;
  if (typeof source !== "string" || !source.trim()) return null;
  return { name, source: source.trim() };
}

/**
 * A marketplace name for a git url the user typed: the last path segment
 * without `.git`, lowercased — `https://github.com/SpecDriven/plugins` is
 * `plugins`. Null when nothing usable is left.
 */
export function marketplaceNameFor(source: string): string | null {
  const last = source
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\.git$/, "")
    .split(/[\\/:]/)
    .pop();
  const name = (last ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return name && MARKETPLACE_NAME_PATTERN.test(name) ? name : null;
}

/**
 * The subdirectory a `./…` source names, relative to the marketplace root
 * with no way out of it; null for a git url.
 */
export function subdirectorySource(source: string): string | null {
  if (!/^\.\.?[\\/]/.test(source) && !source.startsWith("./")) return null;
  const parts = source.replace(/^\.[\\/]/, "").split(/[\\/]+/).filter((p) => p && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) {
    throw new Error(`the source "${source}" leaves the marketplace`);
  }
  return parts.join("/");
}

/**
 * Read `marketplace.json`, refusing one the app cannot use: no name, no
 * plugin list, a plugin row without a name or a source, or a name that is
 * not a plugin id. Rows are kept in the index's order.
 */
export function parseMarketplaceIndex(raw: unknown): MarketplaceIndex {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("marketplace.json is not an object");
  }
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) throw new Error("marketplace.json names no marketplace");
  if (!Array.isArray(o.plugins)) throw new Error('marketplace.json has no "plugins" list');
  const plugins: MarketplacePlugin[] = [];
  o.plugins.forEach((row, i) => {
    if (!row || typeof row !== "object") throw new Error(`plugin ${i + 1} is not an object`);
    const p = row as Record<string, unknown>;
    const pname = typeof p.name === "string" ? p.name : "";
    if (!PLUGIN_ID_PATTERN.test(pname)) {
      throw new Error(pname ? `"${pname}" is not a plugin id` : `plugin ${i + 1} has no name`);
    }
    if (plugins.some((x) => x.name === pname)) throw new Error(`"${pname}" is listed twice`);
    const source = typeof p.source === "string" ? p.source.trim() : "";
    if (!source) throw new Error(`"${pname}" has no source`);
    subdirectorySource(source); // throws for a subdirectory that escapes
    const str = (key: string): string | undefined =>
      typeof p[key] === "string" && (p[key] as string).trim() ? (p[key] as string).trim() : undefined;
    const ref = str("ref");
    const api = p.api === undefined ? undefined : String(p.api);
    const agentRow = p.agent && typeof p.agent === "object" ? (p.agent as Record<string, unknown>) : null;
    const agent =
      agentRow && typeof agentRow.id === "string" && agentRow.id.trim() && typeof agentRow.command === "string" && agentRow.command.trim()
        ? { id: agentRow.id.trim(), command: agentRow.command.trim() }
        : undefined;
    plugins.push({
      name: pname,
      source,
      ...(ref ? { ref } : {}),
      description: str("description") ?? "",
      ...(str("version") ? { version: str("version") } : {}),
      ...(str("category") ? { category: str("category") } : {}),
      ...(api ? { api } : {}),
      ...(agent ? { agent } : {}),
    });
  });
  let owner: MarketplaceIndex["owner"];
  if (o.owner && typeof o.owner === "object") {
    const w = o.owner as Record<string, unknown>;
    if (typeof w.name === "string" && w.name.trim()) {
      owner = { name: w.name.trim(), ...(typeof w.url === "string" && w.url ? { url: w.url } : {}) };
    }
  }
  return { name, ...(owner ? { owner } : {}), plugins };
}

/** Why an index row cannot be installed before anything is fetched, or null. */
export function indexRowRefusal(plugin: MarketplacePlugin): string | null {
  if (plugin.api === undefined) return null;
  const major = Number.parseInt(plugin.api, 10);
  if (Number.isNaN(major)) return `the index claims plugin api "${plugin.api}", which is not a version`;
  if (major !== API_MAJOR) {
    return `the plugin needs plugin api ${plugin.api}; this app speaks api ${API_MAJOR}`;
  }
  return null;
}

// ---- releases ----------------------------------------------------------------

/** The folder beside a plugin's source that holds its released versions. */
export const RELEASE_DIR = "release";
/** The list of released versions in that folder. */
export const RELEASES_FILE = "releases.json";
/** How many versions `specdriven plugin release` keeps in the folder. */
export const RELEASES_KEPT = 10;

const VERSION_PATTERN = /^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/;
const RELEASE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;

/** The zip a version of a plugin is released as: `agent-claude-1.19.0.zip`. */
export function releaseFileName(id: string, version: string): string {
  return `${id.replace(/^@/, "").replace(/[^a-zA-Z0-9._-]/g, "-")}-${version}.zip`;
}

/** Whether a version is a pre-release (`1.2.0-beta`): installed only when picked. */
export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

/**
 * Read `releases.json`, refusing one the app cannot use: no list, a version
 * that is not one or is listed twice, a file that is not a zip's bare name
 * in the folder, or a checksum that is not a SHA-256. Answers the versions
 * newest first, whatever order the file has them in.
 */
export function parseReleases(raw: unknown, plugin?: string): PluginRelease[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${RELEASES_FILE} is not an object`);
  const o = raw as Record<string, unknown>;
  if (plugin !== undefined && o.plugin !== undefined && o.plugin !== plugin) {
    throw new Error(`${RELEASES_FILE} is for "${String(o.plugin)}", not "${plugin}"`);
  }
  if (!Array.isArray(o.releases)) throw new Error(`${RELEASES_FILE} has no "releases" list`);
  const out: PluginRelease[] = [];
  o.releases.forEach((row, i) => {
    if (!row || typeof row !== "object") throw new Error(`release ${i + 1} is not an object`);
    const r = row as Record<string, unknown>;
    const str = (key: string): string | undefined =>
      typeof r[key] === "string" && (r[key] as string).trim() ? (r[key] as string).trim() : undefined;
    const version = str("version") ?? "";
    if (!VERSION_PATTERN.test(version)) {
      throw new Error(version ? `"${version}" is not a version` : `release ${i + 1} has no version`);
    }
    if (out.some((x) => compareVersions(x.version, version) === 0)) throw new Error(`version ${version} is listed twice`);
    const file = str("file") ?? "";
    if (!RELEASE_FILE_PATTERN.test(file)) {
      throw new Error(file ? `${version}: "${file}" is not a zip in the release folder` : `${version} names no file`);
    }
    if (out.some((x) => x.file === file)) throw new Error(`${file} is listed twice`);
    const sha256 = (str("sha256") ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${version} has no SHA-256 checksum`);
    const api = r.api === undefined ? undefined : String(r.api);
    out.push({
      version,
      file,
      sha256,
      ...(typeof r.size === "number" && r.size >= 0 ? { size: r.size } : {}),
      ...(str("date") ? { date: str("date") } : {}),
      ...(api ? { api } : {}),
      ...(str("minAppVersion") ? { minAppVersion: str("minAppVersion") } : {}),
      ...(str("notes") ? { notes: str("notes") } : {}),
      ...(str("yanked") ? { yanked: str("yanked") } : {}),
    });
  });
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Why this app cannot install a released version, or null: it was
 * withdrawn, speaks another plugin api, or needs a newer app. Read from the
 * list alone — the zip's own manifest is checked again once it is unpacked.
 */
export function releaseRefusal(release: PluginRelease, appVersion: string): string | null {
  if (release.yanked !== undefined) return `version ${release.version} was withdrawn: ${release.yanked}`;
  if (release.api !== undefined) {
    const major = Number.parseInt(release.api, 10);
    if (Number.isNaN(major)) return `version ${release.version} claims plugin api "${release.api}", which is not a version`;
    if (major !== API_MAJOR) {
      return `version ${release.version} needs plugin api ${release.api}; this app speaks api ${API_MAJOR}`;
    }
  }
  if (release.minAppVersion && compareAppVersions(appVersion, release.minAppVersion) < 0) {
    return `version ${release.version} needs SpecDriven ${release.minAppVersion} or newer; this is ${appVersion}`;
  }
  return null;
}

/**
 * The version Install and Update mean when none is asked for: the newest
 * one this app can run, pre-releases left to whoever picks them.
 */
export function newestInstallable(
  releases: readonly PluginRelease[],
  appVersion: string,
): PluginRelease | undefined {
  return [...releases]
    .sort((a, b) => compareVersions(b.version, a.version))
    .find((r) => !isPrerelease(r.version) && releaseRefusal(r, appVersion) === null);
}

/** The released version with this number, if the list has it. */
export function releaseOf(releases: readonly PluginRelease[], version: string): PluginRelease | undefined {
  return releases.find((r) => compareVersions(r.version, version) === 0);
}

/** The file in an installed plugin's folder that says where it came from. */
export const INSTALL_RECORD_FILE = ".specdriven-install.json";

/** What Install writes beside the plugin: enough for Update and for Settings. */
export interface InstallRecord {
  marketplace: string;
  /** The row's name in the index. */
  name: string;
  source: string;
  ref?: string;
  version?: string;
  /** The commit the plugin (or, for a subdirectory, the marketplace) was at. */
  commit?: string;
  /** The checksum of the release zip the folder was unpacked from. */
  sha256?: string;
  /** The version this one replaced: what "Roll back" puts back. */
  previous?: string;
  /**
   * The user picked a version older than the newest: it stays, with no
   * update offered, until they update it themselves.
   */
  held?: boolean;
  installedAt: string;
}

/** An install record as read from its file, or null for anything else. */
export function parseInstallRecord(raw: unknown): InstallRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.marketplace !== "string" || typeof r.name !== "string" || typeof r.source !== "string") {
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    marketplace: r.marketplace,
    name: r.name,
    source: r.source,
    ...(str(r.ref) ? { ref: str(r.ref) } : {}),
    ...(str(r.version) ? { version: str(r.version) } : {}),
    ...(str(r.commit) ? { commit: str(r.commit) } : {}),
    ...(str(r.sha256) ? { sha256: str(r.sha256) } : {}),
    ...(str(r.previous) ? { previous: str(r.previous) } : {}),
    ...(r.held === true ? { held: true } : {}),
    installedAt: str(r.installedAt) ?? "",
  };
}

// ---- updates ------------------------------------------------------------------

/** A git url without its scheme case, trailing slashes or `.git`, for comparing. */
function normalizedSource(source: string): string {
  return source.trim().replace(/[\\/]+$/, "").replace(/\.git$/, "").toLowerCase();
}

/**
 * Whether a marketplace is the SpecDriven index the app reads by default —
 * by its git url, whatever name the profile gave it (specs/app/plugins
 * .feature.md "The marketplaces are refreshed on start…").
 */
export function isDefaultMarketplace(entry: MarketplaceRef): boolean {
  const source = normalizedSource(entry.source);
  return DEFAULT_MARKETPLACES.some((m) => normalizedSource(m.source) === source);
}

/**
 * Compare two dotted versions numerically, part by part — `1.10.0` is newer
 * than `1.9.2`; a pre-release (`1.2.0-beta`) sorts before its release; a
 * leading `v` is ignored. Negative when a < b, positive when a > b.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/i, "").split(/-(.*)/s, 2);
    return { parts: core.split(".").map((p) => Number.parseInt(p, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** An installed plugin as the update check reads it. */
export interface InstalledForUpdate {
  id: string;
  displayName?: string;
  /** The manifest's version. */
  version?: string;
  install?: InstallRecord;
}

/** A plugin the start offers to update (specs/app/plugins.feature.md S14). */
export interface PluginUpdate {
  id: string;
  displayName: string;
  marketplace: string;
  /** The version installed, when it has one. */
  from?: string;
  /** The version — or, for a ref change alone, the ref — the index offers. */
  to: string;
}

/**
 * The installed marketplace plugins whose index row has moved on: a newer
 * version than the one installed, or a pin to another ref. A plugin with no
 * install record (linked, or the data folder's), whose marketplace has no
 * index here, or whose row is gone or one the app refuses, is left out.
 *
 * A released plugin is measured against its releases instead: offered the
 * newest version this app can run when that is newer than the one
 * installed — not when the user holds it at an older one — and moved off a
 * version that was withdrawn, even to an older one.
 */
export function pluginUpdates(
  installed: readonly InstalledForUpdate[],
  indexes: readonly { entry: MarketplaceRef; index: MarketplaceIndex }[],
  appVersion: string,
): PluginUpdate[] {
  const out: PluginUpdate[] = [];
  for (const plugin of installed) {
    const record = plugin.install;
    if (!record) continue;
    const index = indexes.find((i) => i.entry.name === record.marketplace)?.index;
    const row = index?.plugins.find((p) => p.name === record.name);
    if (!row || indexRowRefusal(row)) continue;
    const from = plugin.version || record.version || undefined;
    if (row.releasesError) continue;
    if (row.releases) {
      const target = newestInstallable(row.releases, appVersion);
      if (!target) continue;
      const withdrawn = from !== undefined && releaseOf(row.releases, from)?.yanked !== undefined;
      if (record.held && !withdrawn) continue;
      const moved = from === undefined || compareVersions(target.version, from) > 0;
      if (!moved && !(withdrawn && compareVersions(target.version, from!) !== 0)) continue;
      out.push({
        id: plugin.id,
        displayName: plugin.displayName || plugin.id,
        marketplace: record.marketplace,
        ...(from ? { from } : {}),
        to: target.version,
      });
      continue;
    }
    const newer = row.version !== undefined && (from === undefined || compareVersions(row.version, from) > 0);
    const repinned = row.ref !== undefined && row.ref !== record.ref;
    if (!newer && !repinned) continue;
    out.push({
      id: plugin.id,
      displayName: plugin.displayName || plugin.id,
      marketplace: record.marketplace,
      ...(from ? { from } : {}),
      to: (newer ? row.version : undefined) ?? row.ref!,
    });
  }
  return out;
}

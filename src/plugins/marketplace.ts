// The marketplace (specs/app/plugins.feature.md "The marketplace is a git
// repository with an index", "A plugin from the marketplace is installed
// with consent"; roadmap/plugin-architecture.md "Discovery, profile,
// installation"): a git repository with `marketplace.json` at its root —
// the marketplace's name and owner and the plugins it lists, each with a
// source that is a git url pinned to a ref, or a subdirectory of the
// marketplace itself. Which marketplaces this machine reads is the
// profile's `plugins.marketplaces`, beside the enabled list; absent, the
// SpecDriven index. What an installed plugin remembers about where it came
// from is its install record. All of it pure, shared by the server, the CLI
// and the browser.

import { API_MAJOR, PLUGIN_ID_PATTERN } from "./manifest";

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
 * `{ name, source }` rows, malformed rows dropped; the default index when
 * the key is absent — an empty list is the user's own choice of none.
 */
export function marketplaceEntries(section: Record<string, unknown>): MarketplaceRef[] {
  const raw = section.marketplaces;
  if (raw === undefined) return [...DEFAULT_MARKETPLACES];
  if (!Array.isArray(raw)) return [];
  const rows: MarketplaceRef[] = [];
  for (const row of raw) {
    const ref = marketplaceRef(row);
    if (ref && !rows.some((r) => r.name === ref.name)) rows.push(ref);
  }
  return rows;
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
 */
export function pluginUpdates(
  installed: readonly InstalledForUpdate[],
  indexes: readonly { entry: MarketplaceRef; index: MarketplaceIndex }[],
): PluginUpdate[] {
  const out: PluginUpdate[] = [];
  for (const plugin of installed) {
    const record = plugin.install;
    if (!record) continue;
    const index = indexes.find((i) => i.entry.name === record.marketplace)?.index;
    const row = index?.plugins.find((p) => p.name === record.name);
    if (!row || indexRowRefusal(row)) continue;
    const from = plugin.version || record.version || undefined;
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

// Where plugins come from besides the tree (specs/app/plugins.feature.md "A
// plugin loads from a local folder", roadmap/plugin-architecture.md
// "Discovery, profile, installation"): a folder under `~/.specdriven/plugins`
// — installed from a marketplace, or linked by hand — a folder under the
// data repo's `.specdriven/plugins`, which travels with a team's repo and is
// trusted before its first load, and the paths the profile's `sources` name,
// the vibe-coded plugin under development. Discovery reads each folder's
// package.json and nothing else; the loader builds and mounts.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { parsePackageManifest, type PluginManifest } from "../manifest";
import { INSTALL_RECORD_FILE, parseInstallRecord, type InstallRecord } from "../marketplace";

/** Where a filesystem plugin was found, in load order. */
export type SourceKind = "home" | "repo" | "path";

export interface DiscoveredPlugin {
  /** The manifest's id, or the folder's name while the manifest fails to parse. */
  id: string;
  dir: string;
  source: SourceKind;
  manifest?: PluginManifest;
  /** Where a marketplace install came from, for a folder that has the record. */
  install?: InstallRecord;
  /** Why the folder cannot load: no manifest, one the app refuses, a duplicate id. */
  error?: string;
}

/** `~/.specdriven`, or SPECDRIVEN_HOME (the tests' sandbox, the demo's root). */
export function specdrivenHome(): string {
  return process.env.SPECDRIVEN_HOME || join(homedir(), ".specdriven");
}

/** Where installed and hand-linked plugins live: `~/.specdriven/plugins/<id>`. */
export function pluginsHome(): string {
  return join(specdrivenHome(), "plugins");
}

/** Where the app keeps the halves it built, by plugin and revision. */
export function pluginBuildHome(): string {
  return join(specdrivenHome(), "plugin-builds");
}

/** Where the marketplace clones live: `~/.specdriven/marketplaces/<name>`. */
export function marketplacesHome(): string {
  return join(specdrivenHome(), "marketplaces");
}

/** A plugin id as a folder name: the scope's `/` cannot be one. */
export function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** A data repo's own plugins folder: `<repo>/.specdriven/plugins`. */
export function repoPluginsDir(dataDir: string): string {
  return join(dataDir, ".specdriven", "plugins");
}

export interface DiscoveryOptions {
  /** The data repo, when one is configured, for its `.specdriven/plugins`. */
  dataDir: string | null;
  /** The profile's `sources`: explicit plugin folders. */
  paths: readonly string[];
  appVersion: string;
}

/**
 * Every plugin folder the three sources hold, in load order: the home
 * folder, the data repo's, then the explicit paths. A second folder with an
 * id already taken is reported, not loaded — the first source wins.
 */
export async function discoverPlugins(opts: DiscoveryOptions): Promise<DiscoveredPlugin[]> {
  const found: DiscoveredPlugin[] = [];
  for (const dir of await subfolders(pluginsHome())) {
    const plugin = await readPluginFolder(dir, "home", opts.appVersion);
    if (plugin) found.push(plugin);
  }
  if (opts.dataDir) {
    for (const dir of await subfolders(repoPluginsDir(opts.dataDir))) {
      const plugin = await readPluginFolder(dir, "repo", opts.appVersion);
      if (plugin) found.push(plugin);
    }
  }
  for (const path of opts.paths) {
    const dir = resolve(path);
    const plugin =
      (await readPluginFolder(dir, "path", opts.appVersion)) ??
      ({ id: folderName(dir), dir, source: "path", error: `No package.json in ${dir}` } as const);
    found.push(plugin);
  }
  const seen = new Map<string, DiscoveredPlugin>();
  for (const plugin of found) {
    const first = seen.get(plugin.id);
    if (first && !plugin.error) {
      plugin.error = `Another plugin already has the id "${plugin.id}" (${first.dir})`;
    } else if (!first) {
      seen.set(plugin.id, plugin);
    }
  }
  return found;
}

/**
 * A folder as a plugin: its package.json read as a manifest, or the reason
 * it cannot be. Null when there is no package.json at all — a folder that
 * is not a plugin.
 */
export async function readPluginFolder(
  dir: string,
  source: SourceKind,
  appVersion: string,
): Promise<DiscoveredPlugin | null> {
  const file = join(dir, "package.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { id: folderName(dir), dir, source, error: `package.json does not parse: ${(e as Error).message}` };
  }
  const install = await readInstallRecord(dir);
  try {
    const manifest = parsePackageManifest(raw, appVersion);
    return { id: manifest.id, dir, source, manifest, ...(install ? { install } : {}) };
  } catch (e) {
    const named = (raw as { specdriven?: { id?: unknown }; name?: unknown } | null)?.specdriven?.id;
    const id = typeof named === "string" && named ? named : folderName(dir);
    return { id, dir, source, ...(install ? { install } : {}), error: (e as Error).message };
  }
}

/** The install record a marketplace install left in the folder, if any. */
export async function readInstallRecord(dir: string): Promise<InstallRecord | null> {
  try {
    return parseInstallRecord(JSON.parse(await readFile(join(dir, INSTALL_RECORD_FILE), "utf8")));
  } catch {
    return null;
  }
}

function folderName(dir: string): string {
  return dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;
}

/** The directories directly under a folder, dotfiles skipped; none for a missing folder. */
async function subfolders(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    try {
      // stat follows a symlink: a folder linked by hand counts.
      if ((await stat(dir)).isDirectory()) dirs.push(dir);
    } catch {
      // gone between readdir and stat
    }
  }
  return dirs;
}

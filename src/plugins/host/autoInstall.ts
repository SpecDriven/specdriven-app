// Agent plugins installed for the commands found on this machine
// (specs/agents/agent-plugins.feature.md "Agent plugins are installed for
// the commands found on this machine"): at start, each marketplace row that
// names an agent whose command is on PATH, and whose plugin is not
// installed, is installed the way Settings → Plugins would — once. What was
// installed this way is remembered in the profile section, so a plugin the
// user removed is not installed again; a start that cannot reach the
// marketplace installs nothing and says so in the log. Not in the hosted
// app, and not in the demo, whose agent is its own simulation. Called from
// applyStartupState (src/server/api.ts) without being awaited. The offers
// (what the pane shows as installable) read the cached indexes only, so a
// start never waits on git for them.

import { which } from "../../server/run";
import type { AgentOffer } from "../../server/agentTypes";
import { PROFILE_KEY } from "../profile";
import { DEFAULT_MARKETPLACES, marketplaceEntries, type MarketplacePlugin, type MarketplaceRef } from "../marketplace";
import { cachedMarketplaceIndexes, confirmInstall, loadMarketplaces } from "./marketplace";
import { discoverPlugins } from "./sources";
import { version as appVersion } from "../../../package.json";

/** The profile key that remembers what auto-install put in place. */
export const AUTO_INSTALLED_KEY = "autoInstalled";

type State = Record<string, unknown>;

function profileSection(state: State): Record<string, unknown> {
  const section = state[PROFILE_KEY];
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}

/** The ids auto-install has put in place before, from the profile section. */
export function autoInstalled(state: State): string[] {
  const raw = profileSection(state)[AUTO_INSTALLED_KEY];
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

/** Remember an id as auto-installed, in place. */
export function rememberAutoInstalled(state: State, id: string): void {
  const section = { ...profileSection(state) };
  const list = autoInstalled(state);
  if (!list.includes(id)) section[AUTO_INSTALLED_KEY] = [...list, id];
  state[PROFILE_KEY] = section;
}

export interface AutoInstallDeps {
  /** The marketplaces to read; default: the profile's, else the SpecDriven index. */
  marketplaces?: readonly MarketplaceRef[];
  /** Whether a command is on PATH; default: src/server/run.ts which. */
  commandFound?: (command: string) => boolean;
  /** The plugin ids already installed; default: a scan of the plugin folders. */
  installed?: () => Promise<string[]>;
  /** Install one row; default: the marketplace's confirmInstall. */
  install?: (entry: MarketplaceRef, name: string) => Promise<unknown>;
  /** Read the indexes; default: loadMarketplaces without a refresh. */
  indexes?: (entries: readonly MarketplaceRef[]) => Promise<{ entry: MarketplaceRef; plugins: MarketplacePlugin[]; error?: string }[]>;
  log?: (line: string) => void;
}

// Injection seam (the folderChooser pattern): what the start's install
// reaches for — the marketplace, PATH, the plugin folders — swapped by a
// test for fakes; null restores the defaults.
let startDeps: AutoInstallDeps | null = null;

export function setAutoInstallDeps(deps: AutoInstallDeps | null): AutoInstallDeps | null {
  const previous = startDeps;
  startDeps = deps;
  return previous;
}

/** The dependencies the start's install runs with: the seam's, else the defaults. */
export function autoInstallDeps(): AutoInstallDeps {
  return startDeps ?? {};
}

export interface AutoInstallResult {
  installed: string[];
  skipped: { name: string; why: string }[];
  errors: string[];
}

/**
 * Install the agent plugins whose commands this machine has. Reads the
 * settings, installs, records each id, and persists; the caller rescans
 * the plugins afterwards.
 */
export async function ensureCommandPlugins(
  state: State,
  persist: (state: State) => Promise<void>,
  deps: AutoInstallDeps = {},
): Promise<AutoInstallResult> {
  const log = deps.log ?? ((line) => console.log(`[plugins] ${line}`));
  const marketplaces = deps.marketplaces ?? marketplaceEntries(profileSection(state));
  const commandFound = deps.commandFound ?? ((command) => which(command) !== null);
  const installed =
    deps.installed ??
    (async () => (await discoverPlugins({ dataDir: null, paths: [], appVersion })).filter((p) => !p.error).map((p) => p.id));
  const install = deps.install ?? confirmInstall;
  const indexes =
    deps.indexes ??
    (async (entries: readonly MarketplaceRef[]) =>
      (await loadMarketplaces(entries, { refresh: false })).map((m) => ({
        entry: { name: m.name, source: m.source },
        plugins: m.index?.plugins ?? [],
        ...(m.error ? { error: m.error } : {}),
      })));

  const result: AutoInstallResult = { installed: [], skipped: [], errors: [] };
  const present = await installed();
  const before = autoInstalled(state);
  let changed = false;
  for (const { entry, plugins, error } of await indexes(marketplaces)) {
    if (error) {
      log(`marketplace ${entry.name} not reachable; installing no agent plugins from it (${error})`);
      result.errors.push(`${entry.name}: ${error}`);
      continue;
    }
    for (const row of plugins) {
      if (!row.agent) continue;
      if (present.includes(row.name)) {
        result.skipped.push({ name: row.name, why: "installed" });
        continue;
      }
      if (before.includes(row.name)) {
        result.skipped.push({ name: row.name, why: "removed by the user" });
        continue;
      }
      if (!commandFound(row.agent.command)) {
        result.skipped.push({ name: row.name, why: `no \`${row.agent.command}\` on PATH` });
        continue;
      }
      try {
        await install(entry, row.name);
        rememberAutoInstalled(state, row.name);
        changed = true;
        result.installed.push(row.name);
        log(`installed ${row.name} from ${entry.name} for the \`${row.agent.command}\` command`);
      } catch (e) {
        result.errors.push(`${row.name}: ${(e as Error).message}`);
        log(`could not install ${row.name} from ${entry.name}: ${(e as Error).message}`);
      }
    }
  }
  if (changed) await persist(state);
  return result;
}

/**
 * The agent plugins the cached marketplace indexes offer and that are not
 * registered: what the pane names as installable (src/frontend/
 * AgentPane.tsx AgentEmptyGuide). Reads the caches on disk only.
 */
export async function agentOffers(
  state: State,
  registered: readonly string[],
  deps: { commandFound?: (command: string) => boolean; marketplaces?: readonly MarketplaceRef[] } = {},
): Promise<AgentOffer[]> {
  const commandFound = deps.commandFound ?? ((command) => which(command) !== null);
  const marketplaces = deps.marketplaces ?? marketplaceEntries(profileSection(state));
  const offers: AgentOffer[] = [];
  for (const { entry, index } of await cachedMarketplaceIndexes(marketplaces)) {
    for (const row of index.plugins) {
      if (!row.agent || registered.includes(row.agent.id)) continue;
      if (offers.some((o) => o.plugin === row.name)) continue;
      offers.push({
        plugin: row.name,
        marketplace: entry.name,
        label: row.agent.id.charAt(0).toUpperCase() + row.agent.id.slice(1),
        description: row.description,
        cli: row.agent.command,
        cliFound: commandFound(row.agent.command),
      });
    }
  }
  return offers;
}

export { DEFAULT_MARKETPLACES };

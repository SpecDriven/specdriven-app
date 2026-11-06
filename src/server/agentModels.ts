// The models each coding agent is allowed in this data repo
// (specs/agents/agent-plugins.feature.md "Each agent offers the models the
// data repo lists"): one file per agent id in the data repo's `.specdriven/`,
//
//   .specdriven/claude-models.json   ["opus", "sonnet"]
//   .specdriven/codex-models.json    ["gpt-5-codex"]
//
// which Settings → AI agents edits and every model dropdown chooses from —
// the import dialog's, Settings → Jira's, an agent plugin's default. Agents
// name their models differently, so the lists never mix. Saves land in the
// working tree only, like custom-attributes.txt; the reload cron's sync
// stages, commits and pushes the files, so the team shares one set of lists.
//
// A listed model should be one the agent's API reports (its provider's
// reportedModels()); one that is not is still kept and offered, but the log
// gets a warning naming it (warnUnreportedModels).
//
// The lists used to share one `.specdriven/agent-models.json` keyed by agent
// id; the first read or write that finds that file splits it into the
// per-agent files and removes it.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileExists, readTextFile, writeTextFile } from "./fsx";
import { getLogger } from "./telemetry";

const log = getLogger("agent-models");

/** The folder, relative to the data repo, that holds every agent's file. */
export const AGENT_MODELS_DIR = ".specdriven";

/** The file that used to hold every agent's list, keyed by agent id. */
export const LEGACY_AGENT_MODELS_FILE = ".specdriven/agent-models.json";

/** The most models one agent lists: a menu, not a catalog. */
export const MAX_AGENT_MODELS = 50;

/** A model name as the agents' CLIs take one — what the import route accepts. */
const MODEL_NAME = /^(?!-)[\w.:/@[\]-]{1,100}$/;

/** An agent id as plugins register one: `claude`, `codex`, `pi`. */
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** An agent's file name: `<agent id>-models.json`. */
const AGENT_FILE = /^([a-z0-9][a-z0-9_-]{0,63})-models\.json$/;

export type AgentModels = Record<string, string[]>;

/** Whether a string names an agent the files can hold a list for — any
    plugin agent id but `agent`, whose file name the old shared file had. */
export function isAgentId(id: string): boolean {
  return AGENT_ID.test(id) && id !== "agent";
}

/** An agent's file, relative to the data repo: `.specdriven/claude-models.json`. */
export function agentModelsFile(agent: string): string {
  return `${AGENT_MODELS_DIR}/${agent}-models.json`;
}

/** Why a model name would be refused, or null when it is fine. */
export function modelNameProblem(name: string): string | null {
  return MODEL_NAME.test(name) ? null : `Not a model name: ${name.slice(0, 100)}`;
}

/** A stored list as the dropdowns use it: names only, trimmed, valid, once each. */
export function normalizeModelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (MODEL_NAME.test(name) && !out.includes(name)) out.push(name);
    if (out.length === MAX_AGENT_MODELS) break;
  }
  return out;
}

/** Agent ids to their lists as the app reads them, empty lists dropped. */
export function normalizeAgentModels(value: unknown): AgentModels {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AgentModels = {};
  for (const [agent, list] of Object.entries(value as Record<string, unknown>)) {
    if (!isAgentId(agent)) continue;
    const models = normalizeModelList(list);
    if (models.length > 0) out[agent] = models;
  }
  return out;
}

/** The broken old shared file already warned about. */
let warnedLegacy: string | null = null;

const listText = (models: readonly string[]) => `${JSON.stringify(models, null, 2)}\n`;

/**
 * Split the old shared file into one file per agent, then remove it. An
 * agent that already has its own file keeps it; a shared file that is not a
 * JSON object is left alone (to fix by hand) and reads as no lists.
 */
async function splitLegacyFile(dataDir: string): Promise<void> {
  const path = join(dataDir, LEGACY_AGENT_MODELS_FILE);
  const text = await readTextFile(path);
  if (text === null) return;
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Said once per content, not on every read of the state.
    if (warnedLegacy !== text) {
      warnedLegacy = text;
      log.warn("the old agent model file is not a JSON object — left as it is", { file: LEGACY_AGENT_MODELS_FILE });
    }
    return;
  }
  const lists = normalizeAgentModels(parsed);
  for (const [agent, models] of Object.entries(lists)) {
    const own = join(dataDir, agentModelsFile(agent));
    if (!(await fileExists(own))) await writeTextFile(own, listText(models));
  }
  await rm(path, { force: true });
  log.info("split the agent model lists into a file per agent", {
    file: LEGACY_AGENT_MODELS_FILE,
    agents: Object.keys(lists).join(",") || "(none)",
  });
}

/** One agent's file as written, or null when it is missing; throws on a file that is not a JSON list. */
async function readAgentFile(dataDir: string, agent: string): Promise<unknown[] | null> {
  const file = agentModelsFile(agent);
  const text = await readTextFile(join(dataDir, file));
  if (text === null || !text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON — fix it by hand first`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${file} must hold a JSON list of model names`);
  return parsed;
}

/** Every agent's list; `{}` when the data repo has none. An unreadable file reads as no list. */
export async function readAgentModels(dataDir: string): Promise<AgentModels> {
  await splitLegacyFile(dataDir).catch((e: Error) =>
    log.warn("could not split the old agent model file", { file: LEGACY_AGENT_MODELS_FILE, error: e.message }),
  );
  let names: string[];
  try {
    names = await readdir(join(dataDir, AGENT_MODELS_DIR));
  } catch {
    return {};
  }
  const out: AgentModels = {};
  for (const name of names.sort()) {
    const agent = name.match(AGENT_FILE)?.[1];
    if (!agent || !isAgentId(agent)) continue;
    try {
      const models = normalizeModelList(await readAgentFile(dataDir, agent));
      if (models.length > 0) out[agent] = models;
    } catch (e) {
      log.warn("an agent's model file reads as no list", { agent, error: (e as Error).message });
    }
  }
  return out;
}

/**
 * Replace one agent's list — an empty one removes the agent's file — and
 * return every agent's after. Throws on a name no agent would take, on too
 * many names, and on an existing file that is not a JSON list (fixed by
 * hand rather than overwritten).
 */
export async function writeAgentModels(dataDir: string, agent: string, models: unknown): Promise<AgentModels> {
  if (!isAgentId(agent)) throw new Error(`Not an agent id: ${agent.slice(0, 64)}`);
  if (!Array.isArray(models) || models.some((m) => typeof m !== "string")) {
    throw new Error("models must be a list of model names");
  }
  const list: string[] = [];
  for (const raw of models as string[]) {
    const name = raw.trim();
    if (!name) continue;
    const problem = modelNameProblem(name);
    if (problem) throw new Error(problem);
    if (!list.includes(name)) list.push(name);
  }
  if (list.length > MAX_AGENT_MODELS) throw new Error(`At most ${MAX_AGENT_MODELS} models per agent`);

  await splitLegacyFile(dataDir);
  await readAgentFile(dataDir, agent);
  const path = join(dataDir, agentModelsFile(agent));
  if (list.length > 0) await writeTextFile(path, listText(list));
  else await rm(path, { force: true });
  return readAgentModels(dataDir);
}

// --- Checking the lists against what the agents' APIs report ----------------

/**
 * The models an agent's API reports right now — ids and aliases it takes —
 * or null when there is no such agent or it cannot say (no plugin hook,
 * signed out, unreachable).
 */
export type ReportedModels = (agent: string) => Promise<readonly string[] | null>;

/** What each agent's last check found missing, so a warning is logged once per change, not per read. */
const lastMissing = new Map<string, string>();

/**
 * Warn in the log about every listed model its agent's API does not report.
 * Agents whose API cannot say are skipped. Logs a model once until the
 * agent's list or report changes, and returns what is missing per agent.
 */
export async function warnUnreportedModels(lists: AgentModels, reported: ReportedModels): Promise<AgentModels> {
  const missing: AgentModels = {};
  for (const [agent, models] of Object.entries(lists)) {
    let known: readonly string[] | null;
    try {
      known = await reported(agent);
    } catch (e) {
      log.debug("could not ask an agent which models it reports", { agent, error: (e as Error).message });
      continue;
    }
    if (!known) continue;
    const set = new Set(known);
    const absent = models.filter((m) => !set.has(m));
    const key = JSON.stringify(absent);
    if (absent.length > 0) missing[agent] = absent;
    if (lastMissing.get(agent) === key) continue;
    lastMissing.set(agent, key);
    for (const model of absent) {
      log.warn("a listed model is not one the agent's API reports", {
        agent,
        model,
        file: agentModelsFile(agent),
        reported: known.join(","),
      });
    }
  }
  return missing;
}

/** Forget what was already warned about (tests). */
export function resetUnreportedModelWarnings(): void {
  lastMissing.clear();
  warnedLegacy = null;
}

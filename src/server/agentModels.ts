// The models each coding agent offers (specs/agents/agent-plugins.feature.md
// "Each agent offers the models the data repo lists"): one list per agent id
// in the data repo's `.specdriven/agent-models.json`,
//
//   { "claude": ["opus", "sonnet"], "codex": ["gpt-5-codex"] }
//
// which Settings → AI agents edits and every model dropdown chooses from —
// the import dialog's, Settings → Jira's, an agent plugin's default. Agents
// name their models differently, so the lists never mix. Saves land in the
// working tree only, like custom-attributes.txt; the reload cron's sync
// stages, commits and pushes the file, so the team shares one set of lists.

import { join } from "node:path";
import { readTextFile, writeTextFile } from "./fsx";

/** The file's path, relative to the data repo. */
export const AGENT_MODELS_FILE = ".specdriven/agent-models.json";

/** The most models one agent lists: a menu, not a catalog. */
export const MAX_AGENT_MODELS = 50;

/** A model name as the agents' CLIs take one — what the import route accepts. */
const MODEL_NAME = /^(?!-)[\w.:/@[\]-]{1,100}$/;

/** An agent id as plugins register one: `claude`, `codex`, `pi`. */
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type AgentModels = Record<string, string[]>;

/** Whether a string names an agent the file can key a list by. */
export function isAgentId(id: string): boolean {
  return AGENT_ID.test(id);
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

/** The file's contents as the app reads them: agent ids to their lists, empty lists dropped. */
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

/** Every agent's list; `{}` when the data repo has no file or an unreadable one. */
export async function readAgentModels(dataDir: string): Promise<AgentModels> {
  const text = await readTextFile(join(dataDir, AGENT_MODELS_FILE));
  if (text === null) return {};
  try {
    return normalizeAgentModels(JSON.parse(text));
  } catch {
    return {};
  }
}

/**
 * Replace one agent's list — an empty one removes the agent's key — and
 * return every agent's after. The other agents' lists are kept as the file
 * holds them, so a teammate's list for an agent this app lacks survives.
 * Throws on a name no agent would take, on too many names, and on a file
 * that is not a JSON object (fixed by hand rather than overwritten).
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

  const path = join(dataDir, AGENT_MODELS_FILE);
  const text = await readTextFile(path);
  let file: Record<string, unknown> = {};
  if (text !== null && text.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${AGENT_MODELS_FILE} is not valid JSON — fix it by hand first`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${AGENT_MODELS_FILE} must hold a JSON object`);
    }
    file = parsed as Record<string, unknown>;
  }
  if (list.length > 0) file[agent] = list;
  else delete file[agent];
  await writeTextFile(path, `${JSON.stringify(file, null, 2)}\n`);
  return normalizeAgentModels(file);
}

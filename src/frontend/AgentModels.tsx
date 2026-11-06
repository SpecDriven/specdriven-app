// The models each coding agent offers (specs/agents/agent-plugins.feature.md
// "Each agent offers the models the data repo lists"): the agent plugin
// lists everything its sign-in offers (AgentProvider.choices — the account's
// models, a proxy's GET /v1/models, its CLI's aliases), the agent's Settings
// section (Settings → Claude) keeps one list of names per agent in the data repo's
// .specdriven/<agent>-models.json (src/server/agentModels.ts) that narrows it,
// and every model field is a dropdown of what is left, the agent's default
// chosen until another is.

import { useEffect, useState } from "react";
import type { AgentDescriptor, AgentModelOption } from "../server/agentTypes";

export type AgentModels = Record<string, string[]>;

/** A menu row: a bare name, or an agent's option with the name it shows. */
export type ModelRow = string | Pick<AgentModelOption, "value" | "displayName">;

/** Rows as options: a bare name shows as itself. */
export function modelRows(models: readonly ModelRow[]): Pick<AgentModelOption, "value" | "displayName">[] {
  return models.map((m) => (typeof m === "string" ? { value: m, displayName: m } : m));
}

/** An option's text: its name, and the value when that differs. */
export function modelOptionLabel(row: Pick<AgentModelOption, "value" | "displayName">): string {
  return row.displayName && row.displayName !== row.value ? `${row.displayName} — ${row.value}` : row.value;
}

/** The `agentModels` of a state payload, `{}` when absent or malformed. */
export function agentModelsOf(payload: Record<string, unknown>): AgentModels {
  const raw = payload.agentModels;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AgentModels = {};
  for (const [agent, list] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(list)) out[agent] = list.filter((m): m is string => typeof m === "string");
  }
  return out;
}

/** A list as the editor shows it: one model per line. */
export function modelListText(models: readonly string[]): string {
  return models.join("\n");
}

/** The editor's text as a list: a line per model, blanks dropped, each once. */
export function parseModelList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const name = line.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The model a field holds: the one chosen, else the agent's own default
 * when it has one, else the first its menu names — blank only when the
 * menu is empty.
 */
export function chosenModel(models: readonly ModelRow[], value: string, fallback: string | null = null): string {
  return value.trim() || fallback || modelRows(models)[0]?.value || "";
}

/**
 * A model field: the models its agent offers, the default chosen until
 * another is. A value the menu no longer holds — chosen before the menu
 * changed — stays on offer, so opening the menu never changes it. An empty
 * menu leaves nothing to choose.
 */
export function ModelSelect({
  models,
  value,
  fallback = null,
  onChange,
  ariaLabel,
}: {
  models: readonly ModelRow[];
  value: string;
  /** The agent's own default, chosen while `value` is blank. */
  fallback?: string | null;
  onChange: (model: string) => void;
  ariaLabel: string;
}) {
  const rows = modelRows(models);
  const chosen = chosenModel(rows, value, fallback);
  if (!chosen) {
    return (
      <select aria-label={ariaLabel} value="" disabled>
        <option value="">No models listed</option>
      </select>
    );
  }
  const options = rows.some((m) => m.value === chosen) ? rows : [...rows, { value: chosen, displayName: chosen }];
  return (
    <select aria-label={ariaLabel} value={chosen} onChange={(e) => onChange(e.target.value)}>
      {options.map((m) => (
        <option key={m.value} value={m.value}>
          {modelOptionLabel(m)}
        </option>
      ))}
    </select>
  );
}

/**
 * The agents whose plugin adds no Settings section of its own (Codex, so
 * far): each gets a section of the app's, titled after it, holding its
 * model list. The others' lists sit in their own section (Settings → Claude).
 */
export function agentsWithoutSection<A extends Pick<AgentDescriptor, "id">>(
  agents: readonly A[],
  sectionIds: readonly string[],
): A[] {
  return agents.filter((a) => !sectionIds.includes(a.id));
}

/**
 * An agent's model list, in its Settings section: a model per line, saved
 * when the field loses focus. Agents name their models differently, so each
 * keeps its own, in the data repo's `.specdriven/<agent>-models.json`.
 */
export function AgentModelList({
  agent,
  models,
  onSaved,
}: {
  agent: AgentDescriptor;
  models: string[];
  onSaved: (next: AgentModels) => void;
}) {
  const saved = modelListText(models);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A teammate's list arriving with the state replaces an untouched draft.
  useEffect(() => setDraft(saved), [saved]);

  const save = async () => {
    const list = parseModelList(draft);
    setDraft(modelListText(list));
    if (modelListText(list) === saved) {
      setError(null);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/agent-models/${encodeURIComponent(agent.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: list }),
      });
      const data = (await res.json().catch(() => ({}))) as { agentModels?: AgentModels; error?: string };
      if (!res.ok || !data.agentModels) {
        setError(data.error ?? `Saving the models failed (HTTP ${res.status})`);
        return;
      }
      setError(null);
      onSaved(data.agentModels);
    } catch (e) {
      setError(`Saving the models failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="settings-row agent-models-row">
      <span className="settings-row-label">
        {agent.label} models
        <span className="settings-row-hint">
          {error ??
            `One per line, as ${agent.label} names them; every ${agent.label} model menu — the coding agent pane's, "Import from Jira/Wiki", its default model — offers only these, in this order. Empty, they offer every model ${agent.label} lists. Kept in the data repo's .specdriven/${agent.id}-models.json, shared with the team; a listed model ${agent.label}'s API does not report is still offered, with a warning in the log.`}
        </span>
      </span>
      <textarea
        aria-label={`${agent.label} models`}
        className="agent-models-list"
        value={draft}
        rows={Math.min(Math.max(parseModelList(draft).length + 1, 3), 10)}
        disabled={saving}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={agent.id === "claude" ? "opus\nsonnet\nclaude-sonnet-4-5[1m]" : "One model per line"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
      />
    </label>
  );
}

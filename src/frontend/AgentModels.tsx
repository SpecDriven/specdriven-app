// The models each coding agent offers (specs/agents/agent-plugins.feature.md
// "Each agent offers the models the data repo lists"): Settings → AI agents
// edits one list per agent, kept in the data repo's
// .specdriven/agent-models.json (src/server/agentModels.ts), and every model
// field is a dropdown of its agent's list — the agent's own default first.

import { useEffect, useState } from "react";
import type { AgentDescriptor } from "../server/agentTypes";

export type AgentModels = Record<string, string[]>;

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
 * A model field: the agent's own default (the empty value), then the models
 * its list names. A value the list no longer holds — chosen before the list
 * changed — stays on offer, so opening the menu never changes it.
 */
export function ModelSelect({
  agentLabel,
  models,
  value,
  onChange,
  ariaLabel,
}: {
  agentLabel: string;
  models: readonly string[];
  value: string;
  onChange: (model: string) => void;
  ariaLabel: string;
}) {
  const options = value && !models.includes(value) ? [...models, value] : models;
  return (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{agentLabel}&apos;s default</option>
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

/**
 * Settings → AI agents: one list per installed agent, a model per line,
 * saved when the field loses focus. Agents name their models differently,
 * so each keeps its own.
 */
export function AgentModelsSettings({
  agents,
  agentModels,
  onSaved,
}: {
  agents: AgentDescriptor[];
  agentModels: AgentModels;
  onSaved: (next: AgentModels) => void;
}) {
  return (
    <>
      {agents.map((a) => (
        <AgentModelList
          key={a.id}
          agent={a}
          models={agentModels[a.id] ?? []}
          onSaved={onSaved}
        />
      ))}
    </>
  );
}

function AgentModelList({
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
          {error ?? `One per line, as ${agent.label} names them; its model menus offer these after ${agent.label}'s own default.`}
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

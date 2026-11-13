import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { AgentIcon } from "./AgentIcons";
import { Popover } from "./Popover";
import { Tooltip } from "./Tooltip";
import { Keys } from "./shortcuts";
import {
  agentChat,
  type AgentChoices,
  type AgentDescriptor,
  type AgentModelOption,
  type EffortLevel,
} from "./agentChat";
import { EFFORT_LABEL, EFFORT_LEVELS } from "../server/agentTypes";

/**
 * The composer bar's model chip and its picker
 * (specs/agents/agent-pane.feature.md "The composer bar picks the folder,
 * model, effort and mode"). The effort levels depend on the model and the
 * models on the agent, so the three are picked in one place: a row of agent
 * icons (before a session, when more than one agent can start), the models
 * the agent offers — searchable once the list is long — and the effort
 * levels the model takes. The rows are plain data built here, so what the
 * picker lists is tested without mounting it.
 */

/** What each effort level means: the tooltip of its button. */
export const EFFORT_DESCRIPTION: Record<EffortLevel, string> = {
  low: "Quick answers, little thinking",
  medium: "Balanced speed and thinking",
  high: "Thinks things through",
  xhigh: "Longer thinking for hard problems",
  max: "The most thinking the model allows",
};

/** The longest model list picked by number; a longer one gets a search field instead. */
export const MAX_KEYED_MODELS = 9;

/** The row a model value stands for: by its value, or the id an alias resolves to. */
export function modelRow(choices: AgentChoices | null, model: string | null | undefined): AgentModelOption | undefined {
  if (!choices || !model) return undefined;
  const exact = choices.models.find((m) => m.value === model);
  if (exact) return exact;
  // Several aliases can stand for one id (Claude's "default" and "opus"):
  // the one new sessions start on wins, else the first.
  const resolved = choices.models.filter((m) => m.resolvedModel === model);
  return resolved.find((m) => m.value === choices.model) ?? resolved[0];
}

/** A model as the bar names it: its row's name, else the value, else "Default". */
export function modelLabel(choices: AgentChoices | null, model: string | null | undefined): string {
  return modelRow(choices, model)?.displayName ?? model ?? "Default model";
}

/** One row of the model list. */
export interface ModelPick {
  id: string;
  /** What picking the row sets; null is the agent's own default. */
  value: string | null;
  name: string;
  /** A quieter line under the name. */
  description?: string;
  /** The model new sessions start on: badged "Default". */
  isDefault: boolean;
  checked: boolean;
}

/**
 * The model list: the agent's own default first (while no model is set),
 * then every model it offers, the current one checked and the one new
 * sessions start on badged.
 */
export function modelRows(
  choices: AgentChoices,
  current: string | null | undefined,
  agent: Pick<AgentDescriptor, "label">,
): ModelPick[] {
  const currentRow = modelRow(choices, current);
  const defaultRow = modelRow(choices, choices.model);
  const rows: ModelPick[] = choices.models.map((m) => ({
    id: `model:${m.value}`,
    value: m.value,
    name: m.displayName,
    // A description that only repeats the name (a proxy's rows) is left off.
    ...(m.description && m.description !== m.displayName ? { description: m.description } : {}),
    isDefault: m === defaultRow,
    checked: m === currentRow,
  }));
  // A model the agent reports that is not on its list still shows, checked.
  if (current && !currentRow) {
    rows.unshift({ id: `model:${current}`, value: current, name: current, isDefault: false, checked: true });
  }
  if (choices.model === null) {
    rows.unshift({
      id: "model:default",
      value: null,
      name: "Default model",
      description: `Whatever ${agent.label} picks on its own`,
      isDefault: false,
      checked: !current,
    });
  }
  return rows;
}

/** The rows a search leaves: every word typed is somewhere in the name or the value. */
export function filterModelRows(rows: readonly ModelPick[], query: string): ModelPick[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((r) => {
    const text = `${r.name} ${r.value ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The levels a model takes: its row's, else every level (the agent
    lowers one its model does not take). */
export function effortsFor(choices: AgentChoices | null, model: string | null | undefined): readonly EffortLevel[] {
  return modelRow(choices, model ?? choices?.model)?.efforts ?? EFFORT_LEVELS;
}

/** One button of the effort row. */
export interface EffortPick {
  id: string;
  /** What picking it sets; null leaves the level to the agent. */
  value: EffortLevel | null;
  label: string;
  description: string;
  checked: boolean;
}

/** The effort row: the agent's own default, then each level the model takes. */
export function effortRows(
  efforts: readonly EffortLevel[],
  current: EffortLevel | null | undefined,
  agent: Pick<AgentDescriptor, "label">,
): EffortPick[] {
  return [
    {
      id: "effort:default",
      value: null,
      label: "Default",
      description: `${agent.label} decides for the model`,
      checked: !current,
    },
    ...efforts.map((e) => ({
      id: `effort:${e}`,
      value: e,
      label: EFFORT_LABEL[e],
      description: EFFORT_DESCRIPTION[e],
      checked: e === current,
    })),
  ];
}

/** "Agent, model and effort" from the parts the picker offers. */
function inWords(parts: readonly string[]): string {
  const words = parts.map((p, i) => (i === 0 ? p : p.toLowerCase()));
  if (words.length < 2) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

export interface ModelPickerProps {
  agent: AgentDescriptor;
  /** What the agent offers; null until it comes, and for an agent that offers nothing. */
  choices: AgentChoices | null;
  model: string | null | undefined;
  effort: EffortLevel | null | undefined;
  /** False for a running session whose agent cannot switch models. */
  canPickModel: boolean;
  disabled: boolean;
  onModel: (model: string | null) => void;
  onEffort: (effort: EffortLevel | null) => void;
  /** Before a session: the agents that can start, to pick between. */
  agents?: readonly AgentDescriptor[];
  onPickAgent?: (id: string) => void;
}

/**
 * The chip — the agent's icon, the model and the effort — and the picker it
 * opens. With nothing to pick (a session whose agent takes neither a model
 * nor an effort from the bar) the model is plain text.
 */
export function ModelPicker(props: ModelPickerProps) {
  const { agent, choices, model, effort, canPickModel, disabled, agents, onPickAgent } = props;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const efforts = effortsFor(choices, model);
  const others = onPickAgent && agents && agents.length > 1 ? agents : null;
  const pickModel = choices !== null && canPickModel;
  const pickEffort = choices !== null && agent.capabilities.effort === true && efforts.length > 0;

  if (!others && !pickModel && !pickEffort) {
    if (!model) return null;
    return (
      <Tooltip label={`${agent.label} runs on ${model}`}>
        <span className="agent-bar-fact" tabIndex={0}>
          {modelLabel(choices, model)}
        </span>
      </Tooltip>
    );
  }

  // An agent that names no model (it offers none, and reports none) is named itself.
  const named = pickModel || !!model;
  const name = named ? modelLabel(choices, model) : agent.label;
  const level = pickEffort && effort ? EFFORT_LABEL[effort] : null;
  const what = inWords([...(others ? ["Agent"] : []), ...(pickModel ? ["Model"] : []), ...(pickEffort ? ["Effort"] : [])]);
  const ariaLabel = [
    ...(others ? [`Agent: ${agent.label}`] : []),
    ...(named ? [`Model: ${name}`] : []),
    ...(pickEffort ? [`Effort: ${level ?? "default"}`] : []),
  ].join(" · ");

  return (
    <div className="agent-bar-picker" data-picker="model">
      <Tooltip label={`${what} — new sessions start on what you pick`}>
        <button
          type="button"
          className="agent-bar-chip"
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          <AgentIcon agent={agent.id} size={13} />
          <span className="agent-bar-chip-text">{name}</span>
          {level && <span className="agent-bar-chip-more">· {level}</span>}
          <ChevronDown size={12} aria-hidden="true" className="agent-bar-chevron" />
        </button>
      </Tooltip>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        label={what}
        className="agent-bar-menu agent-bar-menu-right agent-model-popover"
        containerSelector={'.agent-bar-picker[data-picker="model"]'}
      >
        <PickerBody
          {...props}
          others={others}
          pickModel={pickModel}
          pickEffort={pickEffort}
          efforts={efforts}
          name={name}
          close={() => setOpen(false)}
        />
      </Popover>
    </div>
  );
}

/** What the open picker holds. Mounted while it is open, so a search starts empty each time. */
function PickerBody({
  agent,
  choices,
  model,
  effort,
  onModel,
  onEffort,
  onPickAgent,
  others,
  pickModel,
  pickEffort,
  efforts,
  name,
  close,
}: ModelPickerProps & {
  others: readonly AgentDescriptor[] | null;
  pickModel: boolean;
  pickEffort: boolean;
  efforts: readonly EffortLevel[];
  name: string;
  close: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  /** The agent whose list is being asked for; its "no models" is not yet known. */
  const [asking, setAsking] = useState<string | null>(agent.id);

  // The list is what the agent's sign-in offers now: ask as the picker opens
  // and as another agent is picked (a list loaded a moment ago is served as
  // it stands, without a request).
  useEffect(() => {
    let alive = true;
    setAsking(agent.id);
    void agentChat
      .loadChoices(agent.id)
      .catch(() => undefined)
      .then(() => {
        if (alive) setAsking(null);
      });
    return () => {
      alive = false;
    };
  }, [agent.id]);

  const rows = pickModel && choices ? modelRows(choices, model, agent) : [];
  const search = rows.length > MAX_KEYED_MODELS;
  const shown = search ? filterModelRows(rows, query) : rows;

  // Focus starts where the hand goes next: the search field, else the model
  // that is on (the dialog's focus trap would take the first agent icon).
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const on = el.querySelector<HTMLElement>('[data-group="model"] [aria-checked="true"]');
    const first =
      el.querySelector<HTMLElement>(".agent-model-search input") ??
      on ??
      el.querySelector<HTMLElement>('[data-group="model"] button') ??
      el.querySelector<HTMLElement>('[data-group="effort"] [aria-checked="true"]');
    first?.focus();
    on?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const group = (which: string) => [
    ...(body.current?.querySelectorAll<HTMLButtonElement>(`[data-group="${which}"] button:not(:disabled)`) ?? []),
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target instanceof HTMLElement ? e.target : null;
    const typing = t?.tagName === "INPUT";
    const within = t?.closest<HTMLElement>("[data-group]")?.dataset.group;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const list = group("model");
        if (list.length === 0) return;
        const down = e.key === "ArrowDown";
        if (typing) {
          if (!down) return;
          e.preventDefault();
          list[0]!.focus();
          return;
        }
        if (within !== "model") return;
        e.preventDefault();
        const at = list.indexOf(t as HTMLButtonElement);
        const field = body.current?.querySelector<HTMLElement>(".agent-model-search input");
        // Up from the first row is back in the search field.
        if (!down && at === 0 && field) field.focus();
        else list[(at + (down ? 1 : -1) + list.length) % list.length]!.focus();
        return;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        if (within !== "agent" && within !== "effort") return;
        const list = group(within);
        const at = list.indexOf(t as HTMLButtonElement);
        if (at === -1) return;
        e.preventDefault();
        list[(at + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length]!.focus();
        return;
      }
      case "Enter": {
        // Enter in the search field picks the first model it left.
        if (!typing) return;
        e.preventDefault();
        if (shown[0]) onModel(shown[0].value);
        return;
      }
      default: {
        // A short list picks by number, as the mode menu does; a long one's
        // digits belong to the search ("5.5").
        if (search || typing || !/^[1-9]$/.test(e.key)) return;
        const row = rows[Number(e.key) - 1];
        if (!row) return;
        e.preventDefault();
        onModel(row.value);
      }
    }
  };

  return (
    <div ref={body} className="agent-model-body" onKeyDown={onKeyDown}>
      {others && (
        <div role="radiogroup" aria-label="Agent" data-group="agent" className="agent-model-agents">
          {others.map((a) => (
            <Tooltip
              key={a.id}
              label={
                <span className="agent-model-tip">
                  <strong>{a.label}</strong>
                  <span>{a.description}</span>
                </span>
              }
            >
              <button
                type="button"
                role="radio"
                aria-checked={a.id === agent.id}
                aria-label={a.label}
                className={`agent-model-agent${a.id === agent.id ? " on" : ""}`}
                onClick={() => {
                  if (a.id === agent.id) return;
                  setQuery("");
                  onPickAgent?.(a.id);
                }}
              >
                <AgentIcon agent={a.id} size={16} />
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      {search && (
        <label className="agent-model-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="text"
            value={query}
            placeholder="Search models"
            aria-label="Search models"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <div className="menu-heading" aria-hidden="true">
        Model
      </div>
      {pickModel ? (
        // A searched list keeps its height while it is narrowed, so the field
        // being typed in stays where it is.
        <div className={`agent-model-list${search ? " is-searched" : ""}`}>
          <div role="radiogroup" aria-label="Model" data-group="model" className="agent-model-rows">
            {shown.map((row, i) => (
              <button
                key={row.id}
                type="button"
                role="radio"
                aria-checked={row.checked}
                data-model={row.id}
                className={`menu-item${row.checked ? " checked" : ""}`}
                onClick={() => onModel(row.value)}
              >
                <span className="menu-check" aria-hidden="true">
                  {row.checked && <Check size={12} />}
                </span>
                <span className="menu-text">
                  <span className="menu-label">
                    {row.name}
                    {row.isDefault && <span className="menu-badge">Default</span>}
                  </span>
                  {row.description !== undefined && <span className="menu-desc">{row.description}</span>}
                </span>
                {!search && i < MAX_KEYED_MODELS && <Keys spec={String(i + 1)} />}
              </button>
            ))}
          </div>
          {shown.length === 0 && (
            <p className="agent-model-note" role="status">
              No model matches “{query.trim()}”
            </p>
          )}
        </div>
      ) : (
        <p className="agent-model-note">
          {model
            ? `${agent.label} runs on ${name} for the whole session`
            : asking === agent.id
              ? "Loading models…"
              : `${agent.label} picks its own model`}
        </p>
      )}
      {pickEffort && (
        <>
          <div className="menu-heading agent-model-effort-heading" aria-hidden="true">
            Effort
          </div>
          <div role="radiogroup" aria-label="Effort" data-group="effort" className="agent-model-efforts">
            {effortRows(efforts, effort, agent).map((row) => (
              <Tooltip key={row.id} label={row.description}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={row.checked}
                  data-effort={row.id}
                  className={`agent-model-effort${row.checked ? " on" : ""}`}
                  onClick={() => {
                    onEffort(row.value);
                    close();
                  }}
                >
                  {row.label}
                </button>
              </Tooltip>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

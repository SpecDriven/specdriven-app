import { useState, type Ref } from "react";
import { backdropDismiss } from "./backdropDismiss";
import { sameBase } from "../server/confluenceUrl";
import { sameJiraBase } from "../server/jiraUrl";
import { classifySource, MAX_JIRA_SOURCES, MAX_SCENARIOS, MAX_WIKI_SOURCES } from "../server/importSources";
import type { AgentDescriptor } from "../server/agentTypes";
import type { ConfluenceWiki } from "./ConfluenceToken";
import type { JiraSite } from "./JiraToken";
import { ModelSelect, type AgentModels } from "./AgentModels";

// "Import from Jira/Wiki here…" in a folder's ⋯ menu
// (specs/external-links/jira-wiki-import.feature.md): the user collects up
// to five Jira issue urls and five Confluence page urls, picks the agent
// when more than one can answer, and the model it answers with (the
// default set in Settings → Jira, or the agent's own), and Analyze has the server read them and
// propose a feature title and up to fifteen scenarios. Those are reviewed
// here — kept or dropped, renamed — before Create feature writes the file.
// When the sources describe more than fifteen, the dialog says so and
// Continue asks for the rest.

/** A url the dialog accepted, with what it names. */
export interface ImportSource {
  url: string;
  kind: "jira" | "wiki";
  /** "ABC-123" for an issue; the page url's last words for a page. */
  label: string;
}

/** A scenario as the review step shows it. */
export interface ReviewScenario {
  name: string;
  body: string;
  sources: string[];
  keep: boolean;
  /** The body is shown. */
  open: boolean;
}

/** What /api/import/propose answers. */
export interface ProposeResult {
  title: string;
  scenarios: { name: string; body: string; sources: string[] }[];
  more: string[];
  agent: string;
  sources: { kind: "jira" | "wiki"; url: string; title: string }[];
}

/** What /api/import/create answers: the feature file written. */
export interface ImportCreateResult {
  fileName: string;
  title: string;
  scenarios: number;
}

/** The review step's state, for the dialog and for tests that start there. */
export interface Proposal {
  title: string;
  scenarios: ReviewScenario[];
  more: string[];
  agent: string;
  sources: ProposeResult["sources"];
}

const AGENT_KEY = "specdriven.importAgent";
const MODELS_KEY = "specdriven.importModels";

/** The default model per agent id, as set in Settings → Jira, kept on this device. */
export function importModels(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

/** Set (or, blank, clear) an agent's default model for imports. */
export function setImportModel(agent: string, model: string): void {
  const models = importModels();
  if (model.trim()) models[agent] = model.trim();
  else delete models[agent];
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify(models));
  } catch {
    // no storage: nothing to remember
  }
}

/** What a model field holds that the server would refuse, or null. */
export function modelProblem(model: string): string | null {
  const m = model.trim();
  if (!m || /^(?!-)[\w.:/@[\]-]{1,100}$/.test(m)) return null;
  return "A model name is letters, digits and . - _ : / @ [ ], like claude-sonnet-4-6.";
}

/** The agents that answer one-shot turns here, by rank. */
export function oneShotAgents(agents: AgentDescriptor[]): AgentDescriptor[] {
  return agents.filter((a) => a.available && a.capabilities.oneShot);
}

function lastAgent(choices: AgentDescriptor[]): string {
  try {
    const kept = localStorage.getItem(AGENT_KEY);
    if (kept && choices.some((a) => a.id === kept)) return kept;
  } catch {
    // no storage: the first agent
  }
  return choices[0]?.id ?? "";
}

/** A page url's last path words, for the row's label. */
function pageLabel(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const words = decodeURIComponent(last.replace(/\+/g, " "));
    return /^\d+$/.test(words) || words.includes(".") || !words ? "Confluence page" : words;
  } catch {
    return "Confluence page";
  }
}

/** The source a url names, as a row, or null when it names none. */
export function sourceRow(url: string): ImportSource | null {
  const ref = classifySource(url);
  if (!ref) return null;
  return { url: ref.url, kind: ref.kind, label: ref.kind === "jira" ? ref.key : pageLabel(ref.url) };
}

/**
 * What stands between the url typed and adding it: nothing (null), or the
 * one sentence the dialog shows under the field.
 */
export function sourceProblem(url: string, rows: ImportSource[], jiraSites: JiraSite[], wikis: ConfluenceWiki[]): string | null {
  if (!url.trim()) return null;
  const ref = classifySource(url);
  if (!ref) return "Not a Jira issue or Confluence page url — open it in the browser and copy the address.";
  if (rows.some((r) => r.url.toLowerCase() === ref.url.toLowerCase())) return "That one is already in the list.";
  if (ref.kind === "jira") {
    if (rows.filter((r) => r.kind === "jira").length >= MAX_JIRA_SOURCES) {
      return `At most ${MAX_JIRA_SOURCES} Jira issues can be read at once.`;
    }
    if (!jiraSites.some((s) => sameJiraBase(s.base, ref.base))) {
      return `No Jira token for ${ref.base} — add one in Settings → Jira.`;
    }
    return null;
  }
  if (rows.filter((r) => r.kind === "wiki").length >= MAX_WIKI_SOURCES) {
    return `At most ${MAX_WIKI_SOURCES} Confluence pages can be read at once.`;
  }
  if (!wikis.some((w) => sameBase(w.base, ref.base))) {
    return `No Confluence token for ${ref.base} — add one in Settings → Confluence.`;
  }
  return null;
}

function review(result: ProposeResult, earlier?: Proposal): Proposal {
  const scenarios = result.scenarios.map((s) => ({ ...s, keep: true, open: false }));
  return {
    title: earlier?.title ?? result.title,
    scenarios: earlier ? [...earlier.scenarios, ...scenarios] : scenarios,
    more: result.more,
    agent: result.agent,
    sources: earlier?.sources ?? result.sources,
  };
}

export function ImportFromJiraWikiDialog({
  folder,
  jiraSites,
  wikis,
  agents,
  agentModels = {},
  trapRef,
  initialProposal,
  onCreated,
  onClose,
}: {
  /** The folder the feature lands in, or null for the top level. */
  folder: string | null;
  jiraSites: JiraSite[];
  wikis: ConfluenceWiki[];
  agents: AgentDescriptor[];
  /** The models each agent offers (Settings → AI agents), by agent id. */
  agentModels?: AgentModels;
  trapRef?: Ref<HTMLDivElement>;
  /** Start at the review step with this proposal (tests). */
  initialProposal?: Proposal;
  onCreated: (result: ImportCreateResult) => void;
  onClose: () => void;
}) {
  const choices = oneShotAgents(agents);
  const [url, setUrl] = useState("");
  const [rows, setRows] = useState<ImportSource[]>([]);
  const [agent, setAgent] = useState(() => lastAgent(choices));
  const [model, setModel] = useState(() => importModels()[lastAgent(choices)] ?? "");
  const [proposal, setProposal] = useState<Proposal | null>(initialProposal ?? null);
  const [busy, setBusy] = useState<"analyze" | "more" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const problem = sourceProblem(url, rows, jiraSites, wikis);
  const chosen = choices.find((a) => a.id === agent) ?? choices[0];
  const badModel = modelProblem(model);

  const chooseAgent = (next: string) => {
    setAgent(next);
    // Another agent names its models differently: its own default.
    setModel(importModels()[next] ?? "");
    try {
      localStorage.setItem(AGENT_KEY, next);
    } catch {
      // no storage: remembered for this dialog only
    }
  };

  const add = () => {
    const row = sourceRow(url);
    if (!row || problem) return;
    setRows((prev) => [...prev, row]);
    setUrl("");
    setError(null);
  };

  const propose = async (earlier?: Proposal) => {
    if (busy) return;
    setBusy(earlier ? "more" : "analyze");
    setError(null);
    try {
      const res = await fetch("/api/import/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: rows.map((r) => r.url),
          ...(chosen ? { agent: chosen.id } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(earlier ? { exclude: earlier.scenarios.map((s) => s.name) } : {}),
        }),
      });
      const data = (await res.json()) as ProposeResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Reading the sources failed (HTTP ${res.status})`);
        return;
      }
      setProposal(review(data, earlier));
    } catch {
      setError("Could not reach the server — is it running?");
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!proposal || busy) return;
    const kept = proposal.scenarios.filter((s) => s.keep);
    if (!proposal.title.trim() || kept.length === 0) return;
    setBusy("create");
    setError(null);
    try {
      const res = await fetch("/api/import/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder,
          title: proposal.title.trim(),
          scenarios: kept.map(({ name, body, sources }) => ({ name, body, sources })),
          sources: proposal.sources,
        }),
      });
      const data = (await res.json()) as ImportCreateResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Creating the feature failed (HTTP ${res.status})`);
        return;
      }
      onCreated(data);
    } catch {
      setError("Could not reach the server — is it running?");
    } finally {
      setBusy(null);
    }
  };

  const update = (i: number, patch: Partial<ReviewScenario>) =>
    setProposal((p) => (p ? { ...p, scenarios: p.scenarios.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : p));

  const where = folder ? (
    <>
      in <strong>{folder}</strong>
    </>
  ) : (
    "at the top level"
  );
  const kept = proposal?.scenarios.filter((s) => s.keep).length ?? 0;

  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div
        className="dialog modal-dialog confluence-dialog import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import from Jira/Wiki"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        {proposal === null ? (
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) add();
              else void propose();
            }}
          >
            <h3>Import from Jira/Wiki</h3>
            <p>
              The issues and pages are read with this device's tokens, and an agent proposes a feature {where}: a title
              and up to {MAX_SCENARIOS} scenarios, which you review before anything is written.
            </p>
            {rows.length > 0 && (
              <ul className="import-sources" aria-label="Sources">
                {rows.map((r) => (
                  <li key={r.url}>
                    <span className={`import-kind import-kind-${r.kind}`}>{r.kind === "jira" ? "Jira" : "Confluence"}</span>
                    <span className="import-source-label" title={r.url}>
                      {r.label}
                    </span>
                    <button
                      type="button"
                      className="link"
                      aria-label={`Remove ${r.label}`}
                      onClick={() => setRows((prev) => prev.filter((x) => x.url !== r.url))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label>
              Jira issue or Confluence page url
              <div className="import-add">
                <input
                  aria-label="Jira issue or Confluence page url"
                  autoFocus
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://jira.acme.com/browse/ABC-123"
                />
                <button type="button" className="btn btn-secondary" disabled={!url.trim() || problem !== null} onClick={add}>
                  Add
                </button>
              </div>
            </label>
            {problem && <p className="hint">{problem}</p>}
            {choices.length > 1 ? (
              <label>
                Analyze with
                <select aria-label="Analyze with" value={chosen?.id ?? ""} onChange={(e) => chooseAgent(e.target.value)}>
                  {choices.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : chosen ? (
              <p className="hint">Analyzed by {chosen.label}.</p>
            ) : (
              <p className="hint">No agent can read the sources — install the Claude or Codex agent plugin.</p>
            )}
            {chosen && (
              <label>
                Model
                <ModelSelect
                  ariaLabel="Model"
                  agentLabel={chosen.label}
                  models={agentModels[chosen.id] ?? []}
                  value={model}
                  onChange={setModel}
                />
              </label>
            )}
            {badModel ? (
              <p className="hint">{badModel}</p>
            ) : (
              chosen && (
                <p className="hint">
                  {(agentModels[chosen.id] ?? []).length > 0
                    ? "Set the default for imports in Settings → Jira."
                    : `List ${chosen.label}'s models in Settings → AI agents to choose one here.`}
                </p>
              )
            )}
            {error && <p className="error">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy !== null || rows.length === 0 || !chosen || badModel !== null}
                onClick={() => void propose()}
              >
                {busy === "analyze"
                  ? `Reading ${rows.length} source${rows.length === 1 ? "" : "s"} and asking ${chosen?.label ?? "the agent"}…`
                  : "Analyze"}
              </button>
            </div>
          </form>
        ) : (
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <h3>Review the proposed feature</h3>
            <p>
              {proposal.agent} proposed {proposal.scenarios.length} scenario{proposal.scenarios.length === 1 ? "" : "s"}{" "}
              from {proposal.sources.length} source{proposal.sources.length === 1 ? "" : "s"}. Keep what fits, rename what
              needs it; the feature is created {where} with the kept scenarios as proposed.
            </p>
            <label>
              Feature title
              <input
                aria-label="Feature title"
                value={proposal.title}
                onChange={(e) => setProposal((p) => (p ? { ...p, title: e.target.value } : p))}
              />
            </label>
            <ul className="import-scenarios" aria-label="Proposed scenarios">
              {proposal.scenarios.map((s, i) => (
                <li key={`${i}-${s.name}`} className={s.keep ? "" : "dropped"}>
                  <div className="import-scenario-row">
                    <input
                      type="checkbox"
                      aria-label={`Keep ${s.name}`}
                      checked={s.keep}
                      onChange={(e) => update(i, { keep: e.target.checked })}
                    />
                    <input
                      aria-label={`Scenario ${i + 1} name`}
                      className="import-scenario-name"
                      value={s.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                    />
                    <button
                      type="button"
                      className="link"
                      aria-expanded={s.open}
                      onClick={() => update(i, { open: !s.open })}
                    >
                      {s.open ? "Hide" : "Show"}
                    </button>
                  </div>
                  {s.open && <pre className="import-scenario-body">{s.body}</pre>}
                </li>
              ))}
            </ul>
            {proposal.more.length > 0 && (
              <p className="import-more">
                The sources describe {proposal.more.length} more scenario{proposal.more.length === 1 ? "" : "s"}:{" "}
                {proposal.more.join(", ")}.{" "}
                <button
                  type="button"
                  className="link"
                  disabled={busy !== null}
                  onClick={() => void propose(proposal)}
                >
                  {busy === "more" ? "Asking for the rest…" : "Continue"}
                </button>
              </p>
            )}
            {error && <p className="error">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setProposal(null)} disabled={busy !== null}>
                Back
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy !== null || kept === 0 || !proposal.title.trim()}>
                {busy === "create" ? "Creating…" : `Create feature with ${kept} scenario${kept === 1 ? "" : "s"}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Settings → Jira: the model each agent that can analyze the sources answers
 * an import with, unless the dialog names another. Blank leaves the agent's
 * own default. Kept on this device: which models answer depends on its
 * account or proxy.
 */
export function ImportModelSettings({
  agents,
  agentModels = {},
}: {
  agents: AgentDescriptor[];
  agentModels?: AgentModels;
}) {
  const choices = oneShotAgents(agents);
  const [models, setModels] = useState(importModels);
  if (choices.length === 0) return null;
  return (
    <>
      {choices.map((a) => {
        const value = models[a.id] ?? "";
        const problem = modelProblem(value);
        return (
          <label key={a.id} className="settings-row">
            <span className="settings-row-label">
              {choices.length > 1 ? `Import model for ${a.label}` : "Import model"}
              <span className="settings-row-hint">
                {problem ??
                  `The model ${a.label} uses for "Import from Jira/Wiki", unless the dialog names another — one of the models Settings → AI agents lists for ${a.label}. Remembered on this device.`}
              </span>
            </span>
            <ModelSelect
              ariaLabel={`Import model for ${a.label}`}
              agentLabel={a.label}
              models={agentModels[a.id] ?? []}
              value={value}
              onChange={(next) => {
                setModels((m) => ({ ...m, [a.id]: next }));
                if (!modelProblem(next)) setImportModel(a.id, next);
              }}
            />
          </label>
        );
      })}
    </>
  );
}

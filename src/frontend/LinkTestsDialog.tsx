import { useEffect, useState, type Ref } from "react";
import { backdropDismiss } from "./backdropDismiss";
import type { AgentDescriptor } from "../server/agentTypes";
import type { TestLinking } from "../server/intentTestUrl";
import { ModelSelect, chosenModel, type AgentModels, type ModelRow } from "./AgentModels";
import { useAgentChoices } from "./agentChat";
import { lastAgent } from "./ExtractSpecsDialog";
import { modelProblem, oneShotAgents } from "./ImportFromJiraWikiDialog";

// "Link tests to specs" (specs/app/extract-specs-from-code.feature.md
// "Tests are linked later, on their own"): for a specification folder whose
// specs were extracted from a code project without their tests linked — or
// whose project has gained tests since — start the pass that links them. An
// agent matches each extracted feature's scenarios to the tests of the code
// it was extracted from; the run goes on in the background and the pill in
// the sidebar's corner follows it, as it follows the drafting.
//
// Only features that say which code they were extracted from are taken up:
// one a person wrote names no code to take tests from.

/** One of the folder's code repositories, with whether its tests can be linked. */
export interface LinkRepo extends TestLinking {
  dir: string;
  default: boolean;
}

/** What GET /api/extract/tests answers. */
export interface LinkChoices {
  repos: LinkRepo[];
  /** The spec folders (under `specs/`, "" for its top) that hold extracted features, and how many. */
  folders: { folder: string; features: number }[];
}

const NO_SERVER = "Could not reach the server — is it running?";
const baseName = (dir: string): string => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? dir;
const features = (n: number): string => `${n} feature${n === 1 ? "" : "s"}`;

export function LinkTestsDialog({
  agents,
  agentModels = {},
  folder = null,
  initialChoices,
  trapRef,
  onStarted,
  onClose,
}: {
  agents: AgentDescriptor[];
  agentModels?: AgentModels;
  /** The spec folder selected in the sidebar: offered as the scope when it holds extracted features. */
  folder?: string | null;
  /** What could be linked, when it is known already (tests). */
  initialChoices?: LinkChoices;
  trapRef?: Ref<HTMLDivElement>;
  /** The run was started: the pill takes over. */
  onStarted: () => void;
  onClose: () => void;
}) {
  const agentChoices = oneShotAgents(agents);
  const [choices, setChoices] = useState<LinkChoices | null>(initialChoices ?? null);
  const [repo, setRepo] = useState(() => pickRepo(initialChoices));
  const [scope, setScope] = useState(() => pickScope(initialChoices, folder));
  const [agent, setAgent] = useState(() => lastAgent(agentChoices));
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosenAgent = agentChoices.find((a) => a.id === agent) ?? agentChoices[0];
  const offered = useAgentChoices(chosenAgent?.id ?? null);
  const menu: ModelRow[] = offered?.models ?? agentModels[chosenAgent?.id ?? ""] ?? [];
  const sentModel = chosenAgent ? chosenModel(menu, model, offered?.model ?? null) : "";
  const badModel = modelProblem(sentModel);

  useEffect(() => {
    if (initialChoices) return;
    let live = true;
    void fetch("/api/extract/tests")
      .then(async (res) => {
        const data = (await res.json()) as LinkChoices & { error?: string };
        if (!live) return;
        if (!res.ok) return setError(data.error ?? `HTTP ${res.status}`);
        setChoices(data);
        setRepo(pickRepo(data));
        setScope(pickScope(data, folder));
      })
      .catch(() => live && setError(NO_SERVER));
    return () => {
      live = false;
    };
  }, []);

  const chosenRepo = choices?.repos.find((r) => r.dir === repo) ?? null;
  const total = choices?.folders.reduce((n, f) => n + f.features, 0) ?? 0;
  /** Why the run cannot be started, said in place of the fields it would need. */
  const blocked = !choices
    ? null
    : choices.repos.length === 0
      ? "This folder names no code repository. Add the project under Project settings, then link its tests."
      : total === 0
        ? "No feature in this folder was extracted from code, so there is no code to take tests from."
        : !chosenAgent
          ? "No agent is set up here to match tests to scenarios — switch one on in Settings → Plugins."
          : null;
  const can = Boolean(choices && !blocked && chosenRepo && !chosenRepo.problem && !badModel);

  const start = async () => {
    if (busy || !can || !chosenRepo || !chosenAgent) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/extract/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codeDir: chosenRepo.dir,
          ...(scope ? { folder: scope } : {}),
          agent: chosenAgent.id,
          ...(sentModel ? { model: sentModel } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setError(data.error ?? `The tests are not being linked (HTTP ${res.status})`);
      onStarted();
    } catch {
      setError(NO_SERVER);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div
        className="dialog modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Link tests to specs"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          className="modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <h3>Link tests to specs</h3>
          <p>
            An agent reads each feature that was extracted from code, and the tests of that code, and lists under each
            scenario the tests that check it. Links are only added: a scenario keeps the ones it has.
          </p>
          {!choices && !error && <p className="hint">Looking for tests…</p>}
          {blocked && <p className="hint">{blocked}</p>}
          {choices && !blocked && (
            <>
              {choices.repos.length > 1 ? (
                <label>
                  Code repository
                  <select aria-label="Code repository" value={repo} onChange={(e) => setRepo(e.target.value)}>
                    {choices.repos.map((r) => (
                      <option key={r.dir} value={r.dir}>
                        {baseName(r.dir)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {chosenRepo &&
                (chosenRepo.problem ? (
                  <p className="error">
                    {baseName(chosenRepo.dir)}: {chosenRepo.problem}.
                  </p>
                ) : (
                  <p className="hint">
                    {chosenRepo.files} test file{chosenRepo.files === 1 ? "" : "s"} in {baseName(chosenRepo.dir)}; the links
                    point at {chosenRepo.repo} on GitHub.
                  </p>
                ))}
              <label>
                Features
                <select aria-label="Features to link" value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="">Every extracted feature ({features(total)})</option>
                  {choices.folders
                    .filter((f) => f.folder !== "")
                    .map((f) => (
                      <option key={f.folder} value={f.folder}>
                        {f.folder} ({features(f.features)})
                      </option>
                    ))}
                </select>
              </label>
              {agentChoices.length > 1 && (
                <label>
                  Link tests with
                  <select aria-label="Link tests with" value={chosenAgent?.id ?? ""} onChange={(e) => (setAgent(e.target.value), setModel(""))}>
                    {agentChoices.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Model
                <ModelSelect ariaLabel="Model" models={menu} value={model} fallback={offered?.model ?? null} onChange={setModel} />
              </label>
              {badModel && <p className="hint">{badModel}</p>}
              <p className="hint">One agent turn for each feature, in the background.</p>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !can}>
              {busy ? "Starting…" : "Link tests"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The repository to start on: the folder's default one when its tests can be linked, else the first that can. */
function pickRepo(choices: LinkChoices | undefined): string {
  const repos = choices?.repos ?? [];
  const usable = repos.filter((r) => !r.problem);
  return (usable.find((r) => r.default) ?? usable[0] ?? repos.find((r) => r.default) ?? repos[0])?.dir ?? "";
}

/** The scope to start on: the folder selected in the sidebar when it holds extracted features, else all of them. */
function pickScope(choices: LinkChoices | undefined, folder: string | null): string {
  const wanted = (folder ?? "").replace(/^specs(\/|$)/, "");
  return wanted && choices?.folders.some((f) => f.folder === wanted) ? wanted : "";
}

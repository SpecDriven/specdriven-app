import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { backdropDismiss } from "./backdropDismiss";
import type { AgentDescriptor } from "../server/agentTypes";
import type { ModuleProposal } from "../server/intentModules";
import type { RefineJob } from "../server/intentRefine";
import type { ChosenFolder, CreatedSpecs, TargetState } from "../server/intentRepo";
import type { TestLinking } from "../server/intentTestUrl";
import { LANGUAGE_LABEL, repoNameProblem } from "../server/intentNames";
import { DRAFT_INSTRUCTIONS, DRAFT_RULES, instructionsProblem, tidyInstructions } from "../server/intentDraftPrompt";
import { ModelSelect, chosenModel, type AgentModels, type ModelRow } from "./AgentModels";
import { useAgentChoices } from "./agentChat";
import { modelProblem, oneShotAgents } from "./ImportFromJiraWikiDialog";
import {
  builtInPrompt,
  chosen,
  flatten,
  folderCounts,
  hasFolderPrompt,
  move,
  moveTargets,
  promptChanged,
  promptFor,
  promptReviewNote,
  promptToSend,
  proposalSummary,
  rename,
  reviewFolders,
  reviewProblem,
  reviewSummary,
  setAllSelected,
  setSelected,
  type PromptDraft,
  type PromptReview,
  type ReviewFolder,
} from "./extractSpecs";

// "Extract specs from a code project" (specs/app/extract-specs-from-code.
// feature.md): choose the project's folder; review the folders its module
// structure suggests — tick, rename, nest, or have an agent regroup them by
// business area; read, and change, what the agent is told when it drafts
// their specs ("The drafting prompt is shown before anything is made");
// then say where they go: a new specification folder, made
// beside the project with a repository on GitHub, or one that already
// exists, which they are added to. Create (or Add) does it, opens the
// folder in this window, and starts an agent drafting proposed specs for
// each folder in the background — and, when asked, linking the project's
// tests to the scenarios once they are drafted ("Tests are linked in a pass
// of their own").

/** GitHub as POST /api/extract/analyse describes it for the project. */
export interface ExtractGithub {
  /** The GitHub host the repository would be made on. */
  host: string;
  /** The accounts it can be made under, the suggested one first. */
  owners: string[];
  /** Why it cannot be made there, when it cannot. */
  problem?: string;
}

/** What POST /api/extract/analyse answers. */
export interface ExtractAnalysis {
  codeDir: string;
  proposal: ModuleProposal;
  /** Why there is nothing to extract. */
  problem?: string;
  /** The specification folder's suggested name, for a new one. */
  name: string;
  /** Where a folder of that name would go. */
  target: string;
  targetState: TargetState;
  /** The specification folder the project already has, when the app can tell. */
  existing?: string | null;
  /** What sits at the project's `specs` now. */
  specsLink: "missing" | "linked" | "elsewhere" | "folder";
  github?: ExtractGithub;
  /** Whether the project's tests could be linked to the specs drafted from it. */
  tests?: TestLinking;
}

/** What the dialog hands back once the specification folder is made. */
export interface ExtractCreated {
  created: CreatedSpecs;
  codeDir: string;
  /** The folders to draft specs for, as they were made. */
  folders: ChosenFolder[];
  agent?: string;
  model?: string;
  /** Go on, once the specs are drafted, to link the project's tests to them. */
  linkTests?: boolean;
  /** The writing instructions to draft with, when the user changed them on the prompt step. */
  instructions?: string;
}

/** The file a specification folder keeps its own drafting prompt in. */
const PROMPT_FILE = ".specdriven/extract-prompt.md";

/** The drafting prompt a specification folder on this computer keeps, or null: it has none, or cannot be asked. */
async function savedPrompt(folder: string): Promise<string | null> {
  try {
    const res = await fetch("/api/extract/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    const data = (await res.json()) as { saved?: string | null };
    return res.ok && typeof data.saved === "string" ? data.saved : null;
  } catch {
    return null;
  }
}

const AGENT_KEY = "specdriven.importAgent";
const NO_SERVER = "Could not reach the server — is it running?";

export function lastAgent(choices: AgentDescriptor[]): string {
  try {
    const kept = localStorage.getItem(AGENT_KEY);
    if (kept && choices.some((a) => a.id === kept)) return kept;
  } catch {
    // no storage: the first agent
  }
  return choices[0]?.id ?? "";
}

/** The parent folder of a path, with the separator it uses. */
function besides(target: string): string {
  const cut = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  return cut <= 0 ? target : target.slice(0, cut + 1);
}

/** The tree under review: presentational, so it renders without a server. */
export function ReviewTree({
  tree,
  disabled,
  onToggle,
  onRename,
  onMove,
}: {
  tree: readonly ReviewFolder[];
  disabled?: boolean;
  onToggle: (key: string, selected: boolean) => void;
  onRename: (key: string, name: string) => void;
  onMove: (key: string, into: string | null) => void;
}) {
  const top = new Set(tree.map((f) => f.key));
  const rows = (list: readonly ReviewFolder[], depth: number): ReactNode =>
    list.map((f) => {
      const targets = moveTargets(tree, f.key);
      const mixed = f.children.length > 0 && flatten(f.children).some((c) => c.selected !== f.selected);
      return (
        <li key={f.key} role="treeitem" aria-level={depth} aria-selected={f.selected}>
          <div className="extract-row" style={{ paddingInlineStart: `${(depth - 1) * 1.25}rem` }}>
            <input
              type="checkbox"
              aria-label={`Include ${f.name || "this folder"}`}
              checked={f.selected}
              disabled={disabled}
              ref={(el) => {
                if (el) el.indeterminate = mixed;
              }}
              onChange={(e) => onToggle(f.key, e.target.checked)}
            />
            <input
              className="extract-name"
              aria-label={`Name of ${f.name || "this folder"}`}
              value={f.name}
              disabled={disabled}
              maxLength={100}
              onChange={(e) => onRename(f.key, e.target.value)}
            />
            {f.languages.map((l) => (
              <span key={l} className="import-kind">
                {LANGUAGE_LABEL[l]}
              </span>
            ))}
            <select
              className="extract-move"
              aria-label={`Move ${f.name || "this folder"} into`}
              title="Move into another folder"
              value=""
              disabled={disabled || (targets.length === 0 && top.has(f.key))}
              onChange={(e) => {
                if (e.target.value) onMove(f.key, e.target.value === "__top__" ? null : e.target.value);
              }}
            >
              <option value="">Move…</option>
              {!top.has(f.key) && <option value="__top__">To the top level</option>}
              {targets.map((t) => (
                <option key={t.key} value={t.key}>
                  {`${"  ".repeat(t.depth - 1)}Into ${t.name || "(unnamed)"}`}
                </option>
              ))}
            </select>
          </div>
          <p className="hint extract-note" style={{ marginInlineStart: `${(depth - 1) * 1.25 + 1.5}rem` }} title={f.modules.join("\n")}>
            {[f.reason, folderCounts(f), f.description].filter(Boolean).join(" · ")}
          </p>
          {f.children.length > 0 && <ul role="group">{rows(f.children, depth + 1)}</ul>}
        </li>
      );
    });
  return (
    <ul className="extract-tree" role="tree" aria-label="Proposed folders">
      {rows(tree, 1)}
    </ul>
  );
}

type Step = "project" | "review" | "prompt" | "repo";

export function ExtractSpecsDialog({
  codeDir: initialDir,
  agents,
  agentModels = {},
  browse,
  browseSpecs,
  openSpecFolder,
  trapRef,
  initialAnalysis,
  initialStep,
  onCreated,
  onClose,
}: {
  /** The project to start on — the open code repository — or none to ask for one. */
  codeDir?: string | null;
  agents: AgentDescriptor[];
  /** The models each agent's Settings section lists, by agent id. */
  agentModels?: AgentModels;
  /** The native folder chooser, where there is one. */
  browse?: () => Promise<string | null>;
  /** The same, asking for a specification folder. */
  browseSpecs?: () => Promise<string | null>;
  /** The specification folder that is open, offered as the existing one to add to. */
  openSpecFolder?: string | null;
  trapRef?: Ref<HTMLDivElement>;
  /** Start at the review step with this analysis (tests). */
  initialAnalysis?: ExtractAnalysis;
  /** Start at this step instead (tests). */
  initialStep?: Step;
  onCreated: (result: ExtractCreated) => void;
  onClose: () => void;
}) {
  const choices = oneShotAgents(agents);
  const [step, setStep] = useState<Step>(initialAnalysis ? (initialStep ?? "review") : "project");
  const [dir, setDir] = useState(initialDir ?? "");
  const [analysis, setAnalysis] = useState<ExtractAnalysis | null>(initialAnalysis ?? null);
  const [tree, setTree] = useState<ReviewFolder[]>(() => reviewFolders(initialAnalysis?.proposal.folders ?? []));
  const [name, setName] = useState(initialAnalysis?.name ?? "");
  const [target, setTarget] = useState<{ dir: string; state: TargetState } | null>(
    initialAnalysis ? { dir: initialAnalysis.target, state: initialAnalysis.targetState } : null,
  );
  /** Whether the folders go into a new specification folder, or one that is already there. */
  const [into, setInto] = useState<"new" | "existing">(initialAnalysis?.existing ? "existing" : "new");
  /** The existing one: its folder, or its GitHub url. */
  const [existingFolder, setExistingFolder] = useState(initialAnalysis?.existing ?? openSpecFolder ?? "");
  const [link, setLink] = useState(false);
  const [publish, setPublish] = useState(true);
  const [owner, setOwner] = useState(initialAnalysis?.github?.owners[0] ?? "");
  const [isPrivate, setIsPrivate] = useState(true);
  const [agent, setAgent] = useState(() => lastAgent(choices));
  const [model, setModel] = useState("");
  /** Whether the project's tests are linked to the scenarios once they are drafted. */
  const [linkTests, setLinkTests] = useState(true);
  /** The writing instructions the agent drafts with, as the prompt step shows them. */
  const [prompt, setPrompt] = useState<PromptDraft>(builtInPrompt);
  /** Why the wizard came back to the prompt step: the folder named after it drafts with another prompt. */
  const [promptReview, setPromptReview] = useState<PromptReview | null>(null);
  const [busy, setBusy] = useState<"analyse" | "prompt" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  /**
   * A fresh repository named as the existing folder, which the server asked
   * about (specs/app/extract-specs-from-code.feature.md "Target specs repo is
   * not initialized"): the folder, while the question is up.
   */
  const [setUpOffer, setSetUpOffer] = useState<string | null>(null);
  /** The folder the user agreed to have set up; sent as `initialize` while it is still the one named. */
  const [setUpAgreed, setSetUpAgreed] = useState<string | null>(null);
  /** The regrouping an agent is at work on, by its job's id. */
  const [refining, setRefining] = useState<string | null>(null);
  /** What the last regrouping came to, said under the tree. */
  const [refineNote, setRefineNote] = useState<string | null>(null);
  /** Asked before a regrouping replaces changes made by hand. */
  const [confirmRefine, setConfirmRefine] = useState(false);

  const chosenAgent = choices.find((a) => a.id === agent) ?? choices[0];
  const offered = useAgentChoices(chosenAgent?.id ?? null);
  const menu: ModelRow[] = offered?.models ?? agentModels[chosenAgent?.id ?? ""] ?? [];
  const sentModel = chosenAgent ? chosenModel(menu, model, offered?.model ?? null) : "";
  const badModel = modelProblem(sentModel);

  const analyse = async (path: string) => {
    const typed = path.trim();
    if (!typed || busy) return;
    setBusy("analyse");
    setError(null);
    try {
      const res = await fetch("/api/extract/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeDir: typed }),
      });
      const data = (await res.json()) as ExtractAnalysis & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Reading the project failed (HTTP ${res.status})`);
        return;
      }
      setAnalysis(data);
      setDir(data.codeDir);
      if (data.problem) {
        setError(data.problem);
        return;
      }
      setTree(reviewFolders(data.proposal.folders));
      setName(data.name);
      setTarget({ dir: data.target, state: data.targetState });
      // A project that already has a specification folder is offered that one.
      setInto(data.existing ? "existing" : "new");
      setExistingFolder(data.existing ?? openSpecFolder ?? "");
      setOwner(data.github?.owners[0] ?? "");
      setExisting(null);
      setStep("review");
    } catch {
      setError(NO_SERVER);
    } finally {
      setBusy(null);
    }
  };

  // Opened on a project — the code repository that is open — it is read at once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || initialAnalysis || !initialDir) return;
    started.current = true;
    void analyse(initialDir);
  }, []);

  // A regrouping takes an agent a while: asked for, then polled until it ends.
  useEffect(() => {
    if (!refining) return;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/extract/refine/${refining}`);
        const job = (await res.json()) as RefineJob & { error?: string };
        if (!live || (res.ok && job.state === "running")) return;
        setRefining(null);
        if (res.ok && job.state === "done" && job.refined) {
          setTree(reviewFolders(job.refined.folders));
          setRefineNote(`Regrouped by ${job.refined.agent}${job.refined.notes ? ` — ${job.refined.notes}` : ""}`);
        } else if (job.state !== "cancelled") {
          setError(job.error ?? "The folders could not be regrouped");
        }
      } catch {
        if (!live) return;
        setRefining(null);
        setError(NO_SERVER);
      }
    }, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [refining]);
  // Closing the dialog stops a regrouping that is still at work.
  const refiningRef = useRef<string | null>(null);
  refiningRef.current = refining;
  useEffect(
    () => () => {
      if (refiningRef.current) void fetch(`/api/extract/refine/${refiningRef.current}`, { method: "DELETE" }).catch(() => {});
    },
    [],
  );

  const browseProject = async () => {
    const picked = await browse?.();
    if (!picked) return;
    setDir(picked);
    void analyse(picked);
  };

  const picked = chosen(tree);
  const problem = reviewProblem(tree);
  const nameProblem = repoNameProblem(name);
  const place = analysis ? `${besides(analysis.target)}${name.trim()}` : "";
  const sameName = analysis !== null && name.trim() === analysis.name;
  const taken = sameName ? target?.state : undefined;
  const blocked = taken === "spec" || taken === "taken" || taken === "unset";
  const toExisting = into === "existing";
  const github = analysis?.github;
  const canPublish = Boolean(github && github.owners.length > 0 && !github.problem);
  const drafted = picked.filter((f) => f.draft).length;
  const tests = analysis?.tests;
  /** Linking needs specs to link to, an agent to match them, tests, and somewhere on github.com for the links to point. */
  const canLink = Boolean(tests && !tests.problem && chosenAgent && drafted > 0);

  /** The prompt is shown only when it will be used: an agent drafts at least one folder. */
  const showsPrompt = Boolean(chosenAgent) && drafted > 0;
  const promptProblem = instructionsProblem(prompt.text);
  /** Whether the folder named keeps a prompt of its own, which is what the step started from. */
  const folderPrompt = hasFolderPrompt(prompt);
  const isBuiltIn = tidyInstructions(prompt.text) === DRAFT_INSTRUCTIONS;
  const reviewNote = promptReviewNote(prompt, promptReview);
  /** The existing folder whose prompt applies; "" for a new one, which keeps none yet. */
  const promptFolder = toExisting ? existingFolder.trim() : "";

  /** From the folders to the prompt — the named folder's own, when it keeps one — or past it when nothing is drafted. */
  const toPrompt = async () => {
    if (!showsPrompt) return setStep("repo");
    if (busy) return;
    if (promptFolder !== prompt.loadedFor) {
      setBusy("prompt");
      const saved = promptFolder ? await savedPrompt(promptFolder) : null;
      setPrompt(promptFor(prompt, promptFolder, saved).prompt);
      setBusy(null);
    }
    setStep("prompt");
  };

  /** Whether the folders were changed by hand since they were proposed. */
  const edited =
    analysis !== null && refineNote === null && JSON.stringify(tree) !== JSON.stringify(reviewFolders(analysis.proposal.folders));

  const refine = async () => {
    if (!analysis || refining || !chosenAgent) return;
    setConfirmRefine(false);
    setError(null);
    try {
      const res = await fetch("/api/extract/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeDir: analysis.codeDir, agent: chosenAgent.id, ...(sentModel ? { model: sentModel } : {}) }),
      });
      const job = (await res.json()) as RefineJob & { error?: string };
      if (!res.ok) return setError(job.error ?? `Regrouping failed (HTTP ${res.status})`);
      setRefining(job.id);
    } catch {
      setError(NO_SERVER);
    }
  };

  const stopRefine = () => {
    if (!refining) return;
    void fetch(`/api/extract/refine/${refining}`, { method: "DELETE" }).catch(() => {});
    setRefining(null);
  };

  const chooseAgent = (next: string) => {
    setAgent(next);
    setModel("");
    try {
      localStorage.setItem(AGENT_KEY, next);
    } catch {
      // no storage: remembered for this dialog only
    }
  };

  const create = async (agreed: string | null = setUpAgreed) => {
    if (busy || !analysis || problem || badModel) return;
    if (toExisting ? !existingFolder.trim() : nameProblem !== null) return;
    if (showsPrompt && promptProblem) return setStep("prompt");
    setBusy("create");
    setError(null);
    setExisting(null);
    setSetUpOffer(null);
    const initialize = agreed !== null && agreed === existingFolder.trim();
    try {
      // The folder was named after the prompt was shown: what it drafts with
      // is looked up now, and anything the user has not seen is shown first.
      let asked = prompt;
      if (showsPrompt && promptFolder !== prompt.loadedFor) {
        const next = promptFor(prompt, promptFolder, promptFolder ? await savedPrompt(promptFolder) : null);
        asked = next.prompt;
        setPrompt(asked);
        if (next.review) {
          setPromptReview(next.review);
          setStep("prompt");
          return;
        }
      }
      const instructions = showsPrompt ? promptToSend(asked) : undefined;
      const res = await fetch("/api/extract/repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          toExisting
            ? {
                codeDir: analysis.codeDir,
                existing: existingFolder.trim(),
                folders: picked,
                link,
                ...(initialize ? { initialize: true } : {}),
              }
            : {
                codeDir: analysis.codeDir,
                name: name.trim(),
                folders: picked,
                link,
                github: canPublish && publish ? { host: github!.host, owner, private: isPrivate } : null,
              },
        ),
      });
      const data = (await res.json()) as CreatedSpecs & {
        error?: string;
        existing?: string;
        dir?: string;
        initialize?: boolean;
      };
      if (!res.ok && data.initialize) {
        // Not refused: asked. The answer is the question under the field.
        setSetUpOffer(existingFolder.trim());
        return;
      }
      if (!res.ok) {
        setError(data.error ?? `Making the folder failed (HTTP ${res.status})`);
        if ((data.existing === "spec" || data.existing === "unset") && data.dir) setExisting(data.dir);
        return;
      }
      onCreated({
        created: data,
        codeDir: analysis.codeDir,
        folders: picked,
        ...(chosenAgent ? { agent: chosenAgent.id } : {}),
        ...(sentModel ? { model: sentModel } : {}),
        ...(canLink && linkTests ? { linkTests: true } : {}),
        ...(instructions ? { instructions } : {}),
      });
    } catch {
      setError(NO_SERVER);
    } finally {
      setBusy(null);
    }
  };

  const title = "Extract specs from a code project";
  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div
        className="dialog modal-dialog confluence-dialog import-dialog extract-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        {step === "project" && (
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              void analyse(dir);
            }}
          >
            <h3>{title}</h3>
            <p>
              Choose a code project. Its module structure is read — Java, JavaScript, TypeScript and Python — and
              proposed as folders for its specifications, which you review before anything is made. Nothing is
              written into the project.
            </p>
            <label>
              Code project
              <div className="import-add">
                <input
                  aria-label="Code project folder"
                  placeholder="/path/to/project"
                  value={dir}
                  autoFocus
                  onChange={(e) => setDir(e.target.value)}
                />
                {browse && (
                  <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void browseProject()}>
                    Browse…
                  </button>
                )}
              </div>
            </label>
            {busy === "analyse" && <p className="hint">Reading the project…</p>}
            {error && <p className="error">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy !== null || !dir.trim()}>
                {busy === "analyse" ? "Reading…" : "Analyse"}
              </button>
            </div>
          </form>
        )}
        {step === "review" && analysis && (
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!problem) void toPrompt();
            }}
          >
            <h3>Folders for {analysis.proposal.project}</h3>
            <p>
              These folders come from the project’s build files and layout. Tick the ones to make, rename them, and
              move one into another to nest it. {proposalSummary(analysis.proposal, LANGUAGE_LABEL)}
            </p>
            <div className="extract-tools">
              <button type="button" className="btn btn-ghost" onClick={() => setTree((t) => setAllSelected(t, true))}>
                Tick all
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setTree((t) => setAllSelected(t, false))}>
                Untick all
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={refining !== null}
                onClick={() => {
                  setTree(reviewFolders(analysis.proposal.folders));
                  setRefineNote(null);
                }}
              >
                {refineNote ? "Back to the original" : "Reset"}
              </button>
              {chosenAgent && analysis.proposal.folders.length > 0 && (
                <span className="extract-refine">
                  {refining ? (
                    <>
                      <span className="hint">{chosenAgent.label} is regrouping…</span>
                      <button type="button" className="btn btn-ghost" onClick={stopRefine}>
                        Stop
                      </button>
                    </>
                  ) : confirmRefine ? (
                    <>
                      <span className="hint">This replaces your changes.</span>
                      <button type="button" className="btn btn-secondary" onClick={() => void refine()}>
                        Regroup anyway
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setConfirmRefine(false)}>
                        Keep mine
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      title="Regroup and rename the folders by what the project does, not by how its code is laid out"
                      onClick={() => (edited ? setConfirmRefine(true) : void refine())}
                    >
                      Refine with {chosenAgent.label}
                    </button>
                  )}
                </span>
              )}
            </div>
            <ReviewTree
              tree={tree}
              disabled={refining !== null}
              onToggle={(key, on) => setTree((t) => setSelected(t, key, on))}
              onRename={(key, value) => setTree((t) => rename(t, key, value))}
              onMove={(key, into) => setTree((t) => move(t, key, into))}
            />
            <p className={problem ? "error" : "hint"}>{problem ?? `${reviewSummary(tree)}.`}</p>
            {refineNote && <p className="hint">{refineNote}</p>}
            {error && <p className="error">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              {!initialDir && (
                <button type="button" className="btn btn-secondary" onClick={() => setStep("project")}>
                  Back
                </button>
              )}
              <button type="submit" className="btn btn-primary" disabled={problem !== null || refining !== null || busy !== null}>
                Next
              </button>
            </div>
          </form>
        )}
        {step === "prompt" && analysis && (
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (promptProblem) return;
              setPromptReview(null);
              setStep("repo");
            }}
          >
            <h3>Drafting prompt</h3>
            <p>
              This is what {chosenAgent?.label ?? "the agent"} is told when it drafts specs for{" "}
              <strong>{analysis.proposal.project}</strong>. Change how the specs are written here; each folder’s turn
              also carries the project’s name, the folder’s name and its files.
            </p>
            {reviewNote && <p className="extract-prompt-note">{reviewNote}</p>}
            <label>
              How the specs are written
              <textarea
                className="extract-prompt"
                aria-label="Drafting prompt"
                rows={12}
                spellCheck={false}
                autoFocus
                value={prompt.text}
                onChange={(e) => setPrompt((p) => ({ ...p, text: e.target.value }))}
              />
            </label>
            <div className="extract-tools">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={isBuiltIn}
                onClick={() => setPrompt((p) => ({ ...p, text: DRAFT_INSTRUCTIONS }))}
              >
                Reset to default
              </button>
              {folderPrompt && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!promptChanged(prompt)}
                  onClick={() => setPrompt((p) => ({ ...p, text: p.loaded }))}
                >
                  Back to the folder’s prompt
                </button>
              )}
            </div>
            {promptProblem ? (
              <p className="error">{promptProblem}</p>
            ) : (
              <p className="hint">
                {folderPrompt && !promptChanged(prompt) ? (
                  <>
                    This is the specification folder’s own prompt, kept in <code>{PROMPT_FILE}</code>.
                  </>
                ) : !promptChanged(prompt) ? (
                  <>
                    The built-in prompt. Changed, it is saved in the specification folder as <code>{PROMPT_FILE}</code> and
                    used by everyone who drafts specs into it.
                  </>
                ) : folderPrompt && isBuiltIn ? (
                  <>
                    The built-in prompt. The folder’s own, in <code>{PROMPT_FILE}</code>, is removed when the drafting starts.
                  </>
                ) : (
                  <>
                    Saved in the specification folder as <code>{PROMPT_FILE}</code> when the drafting starts, and used by
                    everyone who drafts specs into it.
                  </>
                )}
              </p>
            )}
            <div className="extract-rules" role="group" aria-label="Always added by the app">
              <p className="hint">Always added by the app</p>
              <p>{DRAFT_RULES}</p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setStep("review")}>
                Back
              </button>
              <button type="submit" className="btn btn-primary" disabled={promptProblem !== null}>
                Next
              </button>
            </div>
          </form>
        )}
        {step === "repo" && analysis && (
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <h3>Specification folder</h3>
            <p>
              {picked.length === 1 ? "The folder" : `The ${picked.length} folders`} you chose for{" "}
              <strong>{analysis.proposal.project}</strong> go into a specification folder: a new one beside the
              project, or one you already have.
            </p>
            <fieldset className="choice-group">
              <legend>Where the specifications go</legend>
              <label className="choice">
                <input type="radio" name="extract-into" checked={!toExisting} onChange={() => setInto("new")} />
                <span className="choice-label">
                  <span>A new specification folder</span>
                  <span className="hint">Made beside the project, set up from scratch.</span>
                </span>
              </label>
              <label className="choice">
                <input type="radio" name="extract-into" checked={toExisting} onChange={() => setInto("existing")} />
                <span className="choice-label">
                  <span>An existing specification folder</span>
                  <span className="hint">The folders are added to it; what it holds stays as it is.</span>
                </span>
              </label>
            </fieldset>
            {toExisting ? (
              <>
                <label>
                  Existing specification folder
                  <div className="import-add">
                    <input
                      aria-label="Existing specification folder"
                      placeholder="/path/to/specs-folder or https://github.com/owner/repo"
                      value={existingFolder}
                      autoFocus
                      onChange={(e) => {
                        setExistingFolder(e.target.value);
                        setSetUpOffer(null);
                      }}
                    />
                    {browseSpecs && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy !== null}
                        onClick={() => void browseSpecs().then((picked) => picked && setExistingFolder(picked))}
                      >
                        Browse…
                      </button>
                    )}
                  </div>
                </label>
                {setUpOffer !== null && setUpOffer === existingFolder.trim() ? (
                  <div className="extract-setup" role="group" aria-label="Set up the folder">
                    <p>
                      <code>{setUpOffer}</code> is not set up as a specification folder yet. Set it up? Its <code>.specdriven</code> and{" "}
                      <code>specs</code> folders, project settings and a README are added, committed and pushed, then the folders are
                      added to it.
                    </p>
                    <div className="dialog-actions">
                      <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setSetUpOffer(null)}>
                        Not now
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy !== null}
                        onClick={() => {
                          setSetUpAgreed(setUpOffer);
                          void create(setUpOffer);
                        }}
                      >
                        Set it up and add
                      </button>
                    </div>
                  </div>
                ) : setUpAgreed !== null && setUpAgreed === existingFolder.trim() ? (
                  <p className="hint">It is set up as a specification folder first, then the folders are added to it.</p>
                ) : (
                <p className="hint">
                  {analysis.existing && existingFolder.trim() === analysis.existing
                    ? `${analysis.proposal.project} already has this specification folder.`
                    : "A folder on this computer, or a repository on GitHub, which is cloned. The project is added to its code repositories."}
                </p>
                )}
              </>
            ) : (
              <>
                <label>
                  Name
                  <input aria-label="Specification folder name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
                </label>
                {nameProblem ? (
                  <p className="error">{nameProblem}</p>
                ) : taken === "spec" ? (
                  <p className="error">
                    {place} is a specification folder already.{" "}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setExistingFolder(target!.dir);
                        setInto("existing");
                      }}
                    >
                      Add to it instead
                    </button>
                  </p>
                ) : taken === "unset" ? (
                  <p className="error">
                    {place} is a repository with nothing in it yet.{" "}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setExistingFolder(target!.dir);
                        setSetUpAgreed(target!.dir);
                        setSetUpOffer(null);
                        setInto("existing");
                      }}
                    >
                      Set it up and add to it
                    </button>
                  </p>
                ) : taken === "taken" ? (
                  <p className="error">There is already something at {place} — choose another name.</p>
                ) : (
                  <p className="hint">
                    Made at <code>{place}</code>
                  </p>
                )}
                {github && (
                  <fieldset className="choice-group">
                    <legend>GitHub</legend>
                    {canPublish ? (
                      <>
                        <label className="choice">
                          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
                          <span className="choice-label">
                            <span>Create a repository on {github.host}</span>
                            <span className="hint">
                              {publish
                                ? `${owner}/${name.trim() || "…"}, with the folder pushed to it`
                                : "The folder stays on this computer; it can be published later."}
                            </span>
                          </span>
                        </label>
                        {publish && github.owners.length > 1 && (
                          <label>
                            Owner
                            <select aria-label="Repository owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
                              {github.owners.map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        {publish && (
                          <label className="choice">
                            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                            <span className="choice-label">Private</span>
                          </label>
                        )}
                      </>
                    ) : (
                      <p className="hint">
                        {github.problem ?? "No GitHub sign-in to create a repository with."} The folder is made on this
                        computer; it can be published later.
                      </p>
                    )}
                  </fieldset>
                )}
              </>
            )}
            {analysis.specsLink === "missing" && (
              <label className="choice">
                <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
                <span className="choice-label">
                  <span>
                    Add a <code>specs</code> link to the code project
                  </span>
                  <span className="hint">
                    A link in {analysis.proposal.project} to the specification folder’s specs, so the code sees them at a
                    fixed place. The only thing written into the project.
                  </span>
                </span>
              </label>
            )}
            {choices.length > 1 ? (
              <label>
                Draft specs with
                <select aria-label="Draft specs with" value={chosenAgent?.id ?? ""} onChange={(e) => chooseAgent(e.target.value)}>
                  {choices.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : chosenAgent ? (
              <p className="hint">
                {chosenAgent.label} drafts proposed specs for {drafted === 1 ? "the folder" : `${drafted} folders`} in the
                background, one at a time.
              </p>
            ) : (
              <p className="hint">
                No agent is set up here to draft specs. The folders are made; switch an agent on in Settings → Plugins
                in the new folder to draft them.
              </p>
            )}
            {chosenAgent && (
              <label>
                Model
                <ModelSelect ariaLabel="Model" models={menu} value={model} fallback={offered?.model ?? null} onChange={setModel} />
              </label>
            )}
            {badModel && <p className="hint">{badModel}</p>}
            {chosenAgent && drafted > 0 && tests && (
              <label className="choice">
                <input
                  type="checkbox"
                  checked={canLink && linkTests}
                  disabled={!canLink}
                  onChange={(e) => setLinkTests(e.target.checked)}
                />
                <span className="choice-label">
                  <span>Link the project’s tests to the scenarios</span>
                  <span className="hint">
                    {tests.problem
                      ? `${tests.problem}.`
                      : `Once the specs are drafted, ${chosenAgent.label} matches each feature’s scenarios to the project’s tests (${tests.files} test file${tests.files === 1 ? "" : "s"}) and links them to ${tests.repo} on GitHub — one more turn for each feature. Left unticked, it can be done later with “Link tests to specs…”.`}
                  </span>
                </span>
              </label>
            )}
            {error && (
              <p className="error">
                {error}{" "}
                {existing && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setExistingFolder(existing);
                      setInto("existing");
                      setError(null);
                      setExisting(null);
                    }}
                  >
                    Add to it instead
                  </button>
                )}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy !== null}
                onClick={() => setStep(showsPrompt ? "prompt" : "review")}
              >
                Back
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  busy !== null || Boolean(badModel) || (toExisting ? !existingFolder.trim() : nameProblem !== null || blocked)
                }
              >
                {busy === "create" ? (toExisting ? "Adding…" : "Creating…") : toExisting ? "Add and open" : "Create and open"}
              </button>
            </div>
          </form>
        )}
        {step !== "project" && !analysis && <p className="hint">Reading the project…</p>}
      </div>
    </div>
  );
}

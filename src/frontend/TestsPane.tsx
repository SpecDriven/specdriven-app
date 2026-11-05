// The test management pane (specs/app/tests.feature.md): the whole
// main column while the Tests tab is open — the plan list, the case library,
// one case's editor, one plan with its cases and runs, and the runner that
// records a result per case. Reads the module store (src/frontend/testing.ts)
// and navigates through App's `onNavigate`, so App.tsx holds only which view
// is open. The sidebar's Tests panel (TestsSidebar) lives here too, since it
// lists the same plans and cases. Small presentational pieces are exported
// for the static-markup tests (tests/testsPane.test.tsx).

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useSpellCheck } from "./spellCheckPref";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  FileText,
  FlaskConical,
  Link,
  Pencil,
  Play,
  Plus,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import type { FeatureListing } from "../server/features";
import type { ProjectMember } from "../server/members";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";
import { MarkdownEditor } from "./MarkdownEditor";
import { Menu, type MenuItem } from "./Menu";
import type { ConfirmOptions, PromptOptions } from "./ModalPrompts";
import { Popover } from "./Popover";
import { StatusIcon } from "./StatusIcon";
import { shareUrl } from "./shareLink";
import { cleanLine, cleanText } from "../server/text";
import { SaveIndicator, toast } from "./Toasts";
import { Tooltip } from "./Tooltip";
import { ClipboardPlus, ListPlus } from "lucide-react";
import { SectionAction, SidebarSection } from "./SidebarSection";
import { listKeyDown, useRevealActive } from "./sidebarList";
import { isTypingTarget } from "./shortcuts";
import { testsPath, type TestsRoute } from "../plugins/builtin/tests/route";
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  RESULT_KEYS,
  RESULT_LABEL,
  RESULT_ORDER,
  assignableMembers,
  executionProgress,
  executionsOf,
  formatWhen,
  latestResultFor,
  planRollup,
  progressSummary,
  refHref,
  refKeyOf,
  refLabel,
  testing,
  testingState,
  useTesting,
  type CasePriority,
  type Progress,
  type ResultStatus,
  type SpecRef,
  type TestCase,
  type TestPlan,
  type TestPlanExecution,
  type TestingStore,
} from "./testing";

export type Navigate = (view: TestsRoute, opts?: { push?: boolean }) => void;
type Prompt = (opts: PromptOptions) => Promise<string | null>;
type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

/** Handle a link in-app on a plain click; modified clicks keep the browser's. */
function spaClick(e: MouseEvent, go: () => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go();
}

/** Two-letter initials for an assignee chip (App.tsx's twin). */
function initialsOf(name: string): string {
  return (
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .map((w) => w[0]!)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

// --- Flows shared by the pane and the sidebar ------------------------------------

export async function newPlanFlow(prompt: Prompt, go: Navigate): Promise<void> {
  const name = await prompt({
    title: "New test plan",
    hint: "A release, a sprint, a regression pass — whatever the run is for.",
    placeholder: "Release 1.2",
    confirmLabel: "Create",
  });
  if (!name || !cleanLine(name)) return;
  const plan = await testing.createPlan({ name: cleanLine(name) });
  if (plan) go({ kind: "plan", id: plan.id }, { push: true });
}

export async function newCaseFlow(prompt: Prompt, go: Navigate, planId?: string): Promise<void> {
  const title = await prompt({
    title: "New test case",
    hint: "What the tester checks, in a line; the steps go in the case body.",
    placeholder: "Quote total includes the discount",
    confirmLabel: "Create",
  });
  if (!title || !cleanLine(title)) return;
  const c = await testing.createCase({ title: cleanLine(title) });
  if (!c) return;
  if (planId) {
    const plan = testingState().plans.find((p) => p.id === planId);
    if (plan) await testing.updatePlan(planId, { caseIds: [...plan.caseIds, c.id] });
  }
  go({ kind: "case", id: c.id }, { push: true });
}

async function renamePlanFlow(plan: TestPlan, prompt: Prompt): Promise<void> {
  const name = await prompt({ title: "Rename test plan", initial: plan.name, confirmLabel: "Rename" });
  const cleaned = cleanLine(name ?? "");
  if (cleaned && cleaned !== plan.name) await testing.updatePlan(plan.id, { name: cleaned });
}

async function renameCaseFlow(c: TestCase, prompt: Prompt): Promise<void> {
  const title = await prompt({ title: "Rename test case", initial: c.title, confirmLabel: "Rename" });
  const cleaned = cleanLine(title ?? "");
  if (cleaned && cleaned !== c.title) await testing.updateCase(c.id, { title: cleaned });
}

async function renameRunFlow(run: TestPlanExecution, prompt: Prompt): Promise<void> {
  const name = await prompt({ title: "Rename run", initial: run.name, confirmLabel: "Rename" });
  const cleaned = cleanLine(name ?? "");
  if (cleaned && cleaned !== run.name) await testing.updateExecution(run.id, { name: cleaned });
}

async function deletePlanFlow(plan: TestPlan, confirm: Confirm, go: Navigate, open: TestsRoute): Promise<void> {
  const runs = executionsOf(plan.id, testingState().executions).length;
  const ok = await confirm({
    title: `Delete “${plan.name}”?`,
    body: runs
      ? `Its ${runs} run(s) stay in the run history, listed under a deleted plan. This cannot be undone once synced.`
      : "This cannot be undone once synced.",
    confirmLabel: "Delete",
  });
  if (!ok) return;
  if (await testing.deletePlan(plan.id)) {
    toast.success(`Deleted “${plan.name}”.`);
    if (open.kind === "plan" && open.id === plan.id) go({ kind: "plans" }, { push: true });
  }
}

async function deleteCaseFlow(c: TestCase, confirm: Confirm, go: Navigate, open: TestsRoute): Promise<void> {
  const inPlans = testingState().plans.filter((p) => p.caseIds.includes(c.id)).length;
  const ok = await confirm({
    title: `Delete “${c.title}”?`,
    body: `${inPlans ? `It leaves ${inPlans} plan(s); ` : ""}results already recorded for it stay in their runs. This cannot be undone once synced.`,
    confirmLabel: "Delete",
  });
  if (!ok) return;
  if (await testing.deleteCase(c.id)) {
    toast.success(`Deleted “${c.title}”.`);
    if (open.kind === "case" && open.id === c.id) go({ kind: "cases" }, { push: true });
  }
}

async function deleteRunFlow(run: TestPlanExecution, confirm: Confirm, go: Navigate, open: TestsRoute): Promise<void> {
  const ok = await confirm({
    title: `Delete “${run.name}”?`,
    body: "Every result recorded in this run goes with it. This cannot be undone once synced.",
    confirmLabel: "Delete",
  });
  if (!ok) return;
  if (await testing.deleteExecution(run.id)) {
    toast.success(`Deleted “${run.name}”.`);
    if (open.kind === "run" && open.id === run.id) {
      go(testingState().plans.some((p) => p.id === run.planId) ? { kind: "plan", id: run.planId } : { kind: "plans" }, { push: true });
    }
  }
}

/** Absolute url for "Copy link" — the same rule as the app's copyLink. */
async function copyTestsLink(view: TestsRoute): Promise<void> {
  const path = testsPath(view);
  const url = shareUrl(path);
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied.");
  } catch {
    toast.error("Could not copy the link.");
  }
}

// --- Presentational pieces --------------------------------------------------------

/** A result as a coloured word — the runner's and the tables' vocabulary. */
export function ResultBadge({ status, muted = false }: { status: ResultStatus; muted?: boolean }) {
  return (
    <span className={`result-badge ${status}${muted ? " muted" : ""}`}>{RESULT_LABEL[status]}</span>
  );
}

/** A run's progress as a stacked bar: passed, failed, blocked, skipped, untested. */
export function ProgressBar({ progress, label }: { progress: Progress; label?: string }) {
  const text = label ?? progressSummary(progress);
  return (
    <span className="progress" title={text}>
      <span className="progress-bar" role="img" aria-label={text}>
        {RESULT_ORDER.filter((s) => s !== "untested").map((s) =>
          progress[s] > 0 ? (
            <span
              key={s}
              className={`progress-seg ${s}`}
              style={{ flexGrow: progress[s] }}
            />
          ) : null,
        )}
        {progress.untested > 0 && (
          <span className="progress-seg untested" style={{ flexGrow: progress.untested }} />
        )}
      </span>
      <span className="progress-text">{text}</span>
    </span>
  );
}

export function PriorityChip({ priority }: { priority: CasePriority }) {
  return <span className={`priority-chip ${priority}`}>{PRIORITY_LABEL[priority]}</span>;
}

/** One spec reference: a link to the feature or scenario, with an optional ✕. */
export function RefChip({
  spec,
  features,
  onRemove,
}: {
  spec: SpecRef;
  features: FeatureListing[];
  onRemove?: () => void;
}) {
  const feature = features.find((f) => f.fileName === spec.fileName);
  const status = spec.scenario
    ? feature?.scenarios.find(
        (s) => s.name === spec.scenario!.name && s.version === spec.scenario!.version,
      )?.status
    : undefined;
  return (
    <span className="chip ref-chip" title={spec.fileName}>
      {spec.scenario ? (
        <StatusIcon status={status ?? "proposed"} size={12} />
      ) : (
        <FileText size={12} aria-hidden="true" />
      )}
      <a href={refHref(spec)}>{refLabel(spec, features)}</a>
      {onRemove && (
        <button type="button" className="chip-x" aria-label="Remove reference" onClick={onRemove}>
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

function AssigneeChip({
  assigned,
  members,
  disabled,
  onPick,
}: {
  assigned?: string;
  members: ProjectMember[];
  disabled?: boolean;
  onPick: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="chip-anchor tests-assignee-anchor">
      <button
        type="button"
        className={`chip${assigned ? "" : " muted"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Assigned: ${assigned ?? "nobody"}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {assigned ? (
          <span className="avatar chip-avatar" aria-hidden="true">
            {initialsOf(assigned)}
          </span>
        ) : (
          <UserRound size={14} aria-hidden="true" />
        )}
        {assigned ?? "Unassigned"}
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        label="Assigned member"
        className="chip-menu"
        containerSelector=".tests-assignee-anchor"
        items={[
          { id: "", label: "Unassigned", checked: !assigned, onSelect: () => onPick("") },
          ...assignableMembers(members, assigned).map((m) => ({
            id: m.name,
            label: m.name,
            checked: assigned === m.name,
            icon: (
              <span className="avatar chip-avatar" aria-hidden="true">
                {initialsOf(m.name)}
              </span>
            ),
            onSelect: () => onPick(m.name),
          })),
        ]}
      />
    </span>
  );
}

/** The ⋯ button and its menu, positioned inside its own anchor. */
function MoreMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="tree-row-menu tests-more">
      <Tooltip label="More actions">
        <button
          type="button"
          className="tree-menu-btn"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </button>
      </Tooltip>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        label={label}
        className="tree-menu"
        containerSelector=".tests-more"
        items={items}
      />
    </span>
  );
}

function PaneHeader({ crumbs, tail, actions }: { crumbs: Crumb[]; tail: ReactNode; actions?: ReactNode }) {
  return (
    <header className="editor-bar page-header">
      <Breadcrumbs items={crumbs} tail={<span className="crumb current plain">{tail}</span>} />
      <div className="editor-actions page-actions">{actions}</div>
    </header>
  );
}

// --- Autosave -----------------------------------------------------------------------------

/**
 * A markdown field autosaved on the scenario editor's interval, the README
 * editor's way: the draft is local, a tick saves it when it differs from what
 * last landed, and leaving the view flushes it. A refresh that brings a new
 * value is adopted only while nothing is unsaved here; meanwhile the store
 * knows the field is dirty, so the reload tick leaves the module alone.
 */
function useAutosave(
  key: string,
  value: string,
  seconds: number,
  save: (text: string) => Promise<unknown | null>,
) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  draftRef.current = draft;
  const saved = useRef(value);
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const keyRef = useRef(key);
  if (keyRef.current !== key) {
    // Another entity: start from its text, forgetting the old one's marks.
    keyRef.current = key;
    saved.current = value;
    draftRef.current = value;
    setDraft(value);
    setSavedAt(null);
  }
  // The text is saved cleaned (specs/ui/ui.feature.md "User-entered text is
  // cleaned up") while `saved` keeps what was typed: compared cleaned, the
  // server's copy of our own save is not news to adopt — adopting it would
  // take the newline just typed out from under the caret.
  useEffect(() => {
    const current = cleanText(saved.current);
    if (cleanText(draftRef.current) === current && cleanText(value) !== current) {
      saved.current = value;
      setDraft(value);
    }
  }, [value]);
  const tick = async () => {
    const text = draftRef.current;
    if (inFlight.current || cleanText(text) === cleanText(saved.current)) return;
    inFlight.current = true;
    setSaving(true);
    const ok = await save(cleanText(text));
    inFlight.current = false;
    setSaving(false);
    if (ok !== null) {
      saved.current = text;
      setSavedAt(Date.now());
    }
  };
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    const id = setInterval(() => void tickRef.current(), Math.max(1, seconds) * 1000);
    return () => {
      clearInterval(id);
      void tickRef.current();
    };
  }, [seconds, key]);
  const dirty = cleanText(draft) !== cleanText(saved.current);
  useEffect(() => {
    testing.setDirty(key, dirty);
    return () => testing.setDirty(key, false);
  }, [key, dirty]);
  return { draft, setDraft, saving, savedAt, dirty };
}

// --- The pane ---------------------------------------------------------------------------

export interface TestsPaneProps {
  view: TestsRoute;
  features: FeatureListing[];
  members: ProjectMember[];
  /** The Assignments setting: whether plans and runs show an "Assigned" chip. */
  assignments: boolean;
  repoCrumb: Crumb;
  autosaveSeconds: number;
  prompt: Prompt;
  confirm: Confirm;
  onNavigate: Navigate;
}

export function TestsPane(props: TestsPaneProps) {
  const store = useTesting();
  const { view, onNavigate } = props;
  if (store.error && !store.loaded) {
    return <p className="error">{store.error}</p>;
  }
  if (!store.loaded) return <p className="hint">Loading tests…</p>;
  switch (view.kind) {
    case "plans":
      return <PlansView {...props} store={store} />;
    case "cases":
      return <CasesView {...props} store={store} />;
    case "case": {
      const c = store.cases.find((x) => x.id === view.id);
      return c ? <CaseView {...props} store={store} testCase={c} /> : <Missing what="test case" go={onNavigate} to={{ kind: "cases" }} />;
    }
    case "plan": {
      const p = store.plans.find((x) => x.id === view.id);
      return p ? <PlanView {...props} store={store} plan={p} /> : <Missing what="test plan" go={onNavigate} to={{ kind: "plans" }} />;
    }
    case "run": {
      const e = store.executions.find((x) => x.id === view.id);
      return e ? <RunView {...props} store={store} run={e} /> : <Missing what="run" go={onNavigate} to={{ kind: "plans" }} />;
    }
  }
}

function Missing({ what, go, to }: { what: string; go: Navigate; to: TestsRoute }) {
  return (
    <div className="view-error">
      <p>This {what} was not found — it may have been deleted, or the link is stale.</p>
      <a href={testsPath(to)} onClick={(e) => spaClick(e, () => go(to, { push: true }))}>
        Back to the {to.kind === "cases" ? "test cases" : "test plans"}
      </a>
    </div>
  );
}

type ViewProps = TestsPaneProps & { store: TestingStore };

function testsCrumb(go: Navigate): Crumb {
  return {
    label: "Tests",
    href: "/tests",
    onClick: (e) => spaClick(e, () => go({ kind: "plans" }, { push: true })),
  };
}

function casesCrumb(go: Navigate): Crumb {
  return {
    label: "Cases",
    href: "/tests/cases",
    onClick: (e) => spaClick(e, () => go({ kind: "cases" }, { push: true })),
  };
}

function ViewLink({ to, go, className, children, ...rest }: { to: TestsRoute; go: Navigate; className?: string; children: ReactNode; title?: string }) {
  return (
    <a href={testsPath(to)} className={className} onClick={(e) => spaClick(e, () => go(to, { push: true }))} {...rest}>
      {children}
    </a>
  );
}

// --- Plans list ---------------------------------------------------------------------------

function PlansView({ store, repoCrumb, prompt, confirm, onNavigate, assignments }: ViewProps) {
  return (
    <>
      <PaneHeader
        crumbs={[repoCrumb, testsCrumb(onNavigate)]}
        tail="Test plans"
        actions={
          <>
            <ViewLink to={{ kind: "cases" }} go={onNavigate} className="tests-link">
              {store.cases.length} test case{store.cases.length === 1 ? "" : "s"}
            </ViewLink>
            <button type="button" className="primary-action" onClick={() => void newPlanFlow(prompt, onNavigate)}>
              <Plus size={14} aria-hidden="true" /> New plan
            </button>
          </>
        }
      />
      <div className="tests-body">
        {store.plans.length === 0 ? (
          <div className="tests-empty">
            <FlaskConical size={28} aria-hidden="true" />
            <p>No test plans yet.</p>
            <p className="hint">
              A plan groups test cases from the library; each run of it records a result per case.
            </p>
            <button type="button" onClick={() => void newPlanFlow(prompt, onNavigate)}>
              + New plan
            </button>
          </div>
        ) : (
          <table className="tests-table">
            <thead>
              <tr>
                <th>Plan</th>
                <th className="num">Cases</th>
                {assignments && <th>Assigned</th>}
                <th>Latest run</th>
                <th className="wide">Progress</th>
                <th className="actions" />
              </tr>
            </thead>
            <tbody>
              {store.plans.map((plan) => (
                <PlanRow
                  key={plan.id}
                  plan={plan}
                  executions={store.executions}
                  assignments={assignments}
                  go={onNavigate}
                  menu={
                    <MoreMenu
                      label={`Menu for ${plan.name}`}
                      items={[
                        { id: "rename", label: "Rename", icon: <Pencil size={13} />, onSelect: () => void renamePlanFlow(plan, prompt) },
                        { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => void copyTestsLink({ kind: "plan", id: plan.id }) },
                        { id: "delete", label: "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => void deletePlanFlow(plan, confirm, onNavigate, { kind: "plans" }) },
                      ]}
                    />
                  }
                />
              ))}
            </tbody>
          </table>
        )}
        {store.executions.length > 0 && (
          <section className="tests-section">
            <h3>Recent runs</h3>
            <table className="tests-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Plan</th>
                  <th>Started</th>
                  <th className="wide">Progress</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {store.executions.slice(0, 10).map((run) => (
                  <RunRow key={run.id} run={run} plan={store.plans.find((p) => p.id === run.planId) ?? null} go={onNavigate} showPlan />
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </>
  );
}

export function PlanRow({
  plan,
  executions,
  assignments,
  go,
  menu,
}: {
  plan: TestPlan;
  executions: TestPlanExecution[];
  assignments: boolean;
  go: Navigate;
  menu?: ReactNode;
}) {
  const { latest, progress, runs } = planRollup(plan, executions);
  return (
    <tr className="plan-row">
      <td>
        <ViewLink to={{ kind: "plan", id: plan.id }} go={go} className="tests-title">
          {plan.name}
        </ViewLink>
      </td>
      <td className="num">{plan.caseIds.length}</td>
      {assignments && <td className="muted">{plan.assigned ?? "—"}</td>}
      <td>
        {latest ? (
          <ViewLink to={{ kind: "run", id: latest.id }} go={go}>
            {latest.name}
          </ViewLink>
        ) : (
          <span className="muted">Never run</span>
        )}
        {runs > 1 && <span className="muted"> · {runs} runs</span>}
      </td>
      <td className="wide">{progress ? <ProgressBar progress={progress} /> : null}</td>
      <td className="actions">{menu}</td>
    </tr>
  );
}

export function RunRow({
  run,
  plan,
  go,
  showPlan = false,
  menu,
}: {
  run: TestPlanExecution;
  plan: TestPlan | null;
  go: Navigate;
  showPlan?: boolean;
  menu?: ReactNode;
}) {
  const progress = executionProgress(run);
  return (
    <tr className="run-row">
      <td>
        <ViewLink to={{ kind: "run", id: run.id }} go={go} className="tests-title">
          {run.name}
        </ViewLink>
      </td>
      {showPlan && (
        <td>
          {plan ? (
            <ViewLink to={{ kind: "plan", id: plan.id }} go={go}>
              {plan.name}
            </ViewLink>
          ) : (
            <span className="muted">Deleted plan</span>
          )}
        </td>
      )}
      <td className="muted">{formatWhen(run.startedAt)}</td>
      <td className="wide">
        <ProgressBar progress={progress} />
      </td>
      <td>
        <span className={`run-state${run.finishedAt ? " finished" : ""}`}>
          {run.finishedAt ? `Finished ${formatWhen(run.finishedAt)}` : "In progress"}
        </span>
      </td>
      {menu !== undefined && <td className="actions">{menu}</td>}
    </tr>
  );
}

// --- Case library ----------------------------------------------------------------------------

function CasesView({ store, features, repoCrumb, prompt, confirm, onNavigate }: ViewProps) {
  return (
    <>
      <PaneHeader
        crumbs={[repoCrumb, testsCrumb(onNavigate)]}
        tail="Test cases"
        actions={
          <button type="button" className="primary-action" onClick={() => void newCaseFlow(prompt, onNavigate)}>
            <Plus size={14} aria-hidden="true" /> New case
          </button>
        }
      />
      <div className="tests-body">
        {store.cases.length === 0 ? (
          <div className="tests-empty">
            <FlaskConical size={28} aria-hidden="true" />
            <p>No test cases yet.</p>
            <p className="hint">A case is what a tester checks; it can point at the features and scenarios it covers.</p>
            <button type="button" onClick={() => void newCaseFlow(prompt, onNavigate)}>
              + New case
            </button>
          </div>
        ) : (
          <table className="tests-table">
            <thead>
              <tr>
                <th>Test case</th>
                <th>Priority</th>
                <th>Covers</th>
                <th>Latest result</th>
                <th className="actions" />
              </tr>
            </thead>
            <tbody>
              {store.cases.map((c) => {
                const latest = latestResultFor(c.id, store.executions);
                return (
                  <tr key={c.id}>
                    <td>
                      <ViewLink to={{ kind: "case", id: c.id }} go={onNavigate} className="tests-title">
                        {c.title}
                      </ViewLink>
                    </td>
                    <td>
                      <PriorityChip priority={c.priority} />
                    </td>
                    <td className="refs-cell">
                      {c.refs.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        c.refs.map((r) => <RefChip key={refKeyOf(r)} spec={r} features={features} />)
                      )}
                    </td>
                    <td>
                      {latest ? (
                        <>
                          <ResultBadge status={latest.result.status} />{" "}
                          <ViewLink to={{ kind: "run", id: latest.execution.id }} go={onNavigate} className="muted">
                            {latest.execution.name}
                          </ViewLink>
                        </>
                      ) : (
                        <ResultBadge status="untested" muted />
                      )}
                    </td>
                    <td className="actions">
                      <MoreMenu
                        label={`Menu for ${c.title}`}
                        items={[
                          { id: "rename", label: "Rename", icon: <Pencil size={13} />, onSelect: () => void renameCaseFlow(c, prompt) },
                          { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => void copyTestsLink({ kind: "case", id: c.id }) },
                          { id: "delete", label: "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => void deleteCaseFlow(c, confirm, onNavigate, { kind: "cases" }) },
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// --- One case --------------------------------------------------------------------------------

function CaseView({ store, testCase: c, features, repoCrumb, autosaveSeconds, prompt, confirm, onNavigate }: ViewProps & { testCase: TestCase }) {
  const body = useAutosave(`case:${c.id}`, c.body, autosaveSeconds, (text) =>
    testing.updateCase(c.id, { body: text }),
  );
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [refsOpen, setRefsOpen] = useState(false);
  const inPlans = store.plans.filter((p) => p.caseIds.includes(c.id));
  const latest = latestResultFor(c.id, store.executions);
  const setRefs = (refs: SpecRef[]) => void testing.updateCase(c.id, { refs });
  return (
    <>
      <PaneHeader
        crumbs={[repoCrumb, testsCrumb(onNavigate), casesCrumb(onNavigate)]}
        tail={c.title}
        actions={
          <>
            <SaveIndicator saving={body.saving} savedAt={body.savedAt} dirty={body.dirty} />
            <span className="readme-hint">{`Autosaves every ${autosaveSeconds}s; the next sync pushes it.`}</span>
            <MoreMenu
              label={`Menu for ${c.title}`}
              items={[
                { id: "rename", label: "Rename", icon: <Pencil size={13} />, onSelect: () => void renameCaseFlow(c, prompt) },
                { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => void copyTestsLink({ kind: "case", id: c.id }) },
                { id: "delete", label: "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => void deleteCaseFlow(c, confirm, onNavigate, { kind: "case", id: c.id }) },
              ]}
            />
          </>
        }
      />
      <div className="props">
        <span className="chip-anchor tests-priority-anchor">
          <button
            type="button"
            className="chip"
            aria-haspopup="menu"
            aria-expanded={priorityOpen}
            aria-label={`Priority: ${PRIORITY_LABEL[c.priority]}`}
            onClick={() => setPriorityOpen((o) => !o)}
          >
            <PriorityChip priority={c.priority} />
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          <Menu
            open={priorityOpen}
            onClose={() => setPriorityOpen(false)}
            label="Priority"
            className="chip-menu"
            containerSelector=".tests-priority-anchor"
            items={PRIORITY_ORDER.map((p) => ({
              id: p,
              label: PRIORITY_LABEL[p],
              checked: c.priority === p,
              onSelect: () => void testing.updateCase(c.id, { priority: p }),
            }))}
          />
        </span>
        {latest && (
          <span className="chip" title={`Latest result, in ${latest.execution.name}`}>
            <ResultBadge status={latest.result.status} />
            <ViewLink to={{ kind: "run", id: latest.execution.id }} go={onNavigate} className="muted">
              {latest.execution.name}
            </ViewLink>
          </span>
        )}
        {inPlans.map((p) => (
          <ViewLink key={p.id} to={{ kind: "plan", id: p.id }} go={onNavigate} className="chip muted" title="In this plan">
            <FlaskConical size={12} aria-hidden="true" /> {p.name}
          </ViewLink>
        ))}
      </div>
      <div className="props refs-row">
        <span className="props-label">Covers</span>
        {c.refs.map((r) => (
          <RefChip
            key={refKeyOf(r)}
            spec={r}
            features={features}
            onRemove={() => setRefs(c.refs.filter((x) => refKeyOf(x) !== refKeyOf(r)))}
          />
        ))}
        <span className="chip-anchor tests-refs-anchor">
          <button type="button" className="chip muted" aria-haspopup="dialog" aria-expanded={refsOpen} onClick={() => setRefsOpen((o) => !o)}>
            <Plus size={12} aria-hidden="true" /> Add reference
          </button>
          <Popover open={refsOpen} onClose={() => setRefsOpen(false)} label="Add a feature or scenario" className="chip-popover ref-picker" containerSelector=".tests-refs-anchor">
            <RefPicker features={features} refs={c.refs} onChange={setRefs} />
          </Popover>
        </span>
      </div>
      <MarkdownEditor
        value={body.draft}
        onChange={body.setDraft}
        placeholder="Preconditions, steps and expected results, in Markdown…"
      />
    </>
  );
}

/** The reference picker: every feature, unfolding to its scenarios, with a filter. */
export function RefPicker({
  features,
  refs,
  onChange,
}: {
  features: FeatureListing[];
  refs: SpecRef[];
  onChange: (refs: SpecRef[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const [openFeature, setOpenFeature] = useState<string | null>(null);
  const keys = new Set(refs.map(refKeyOf));
  const toggle = (ref: SpecRef) => {
    const key = refKeyOf(ref);
    onChange(keys.has(key) ? refs.filter((r) => refKeyOf(r) !== key) : [...refs, ref]);
  };
  const q = filter.trim().toLowerCase();
  const shown = features.filter(
    (f) =>
      !q ||
      f.name.toLowerCase().includes(q) ||
      f.fileName.toLowerCase().includes(q) ||
      f.scenarios.some((s) => s.name.toLowerCase().includes(q)),
  );
  return (
    <div className="ref-picker-body">
      <input
        type="search"
        placeholder="Filter features and scenarios…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        aria-label="Filter features and scenarios"
      />
      <ul className="ref-picker-list">
        {shown.length === 0 && <li className="muted">No features match.</li>}
        {shown.map((f) => {
          const whole: SpecRef = { fileName: f.fileName };
          const unfolded = openFeature === f.fileName || Boolean(q);
          return (
            <li key={f.fileName}>
              <div className="ref-picker-row">
                <button
                  type="button"
                  className="ref-picker-twist"
                  aria-label={unfolded ? "Hide scenarios" : "Show scenarios"}
                  aria-expanded={unfolded}
                  onClick={() => setOpenFeature(unfolded ? null : f.fileName)}
                >
                  {unfolded ? <ChevronDown size={12} /> : <ChevronUp size={12} style={{ transform: "rotate(90deg)" }} />}
                </button>
                <label>
                  <input type="checkbox" checked={keys.has(refKeyOf(whole))} onChange={() => toggle(whole)} />
                  <FileText size={12} aria-hidden="true" /> {f.name}
                </label>
              </div>
              {unfolded && (
                <ul>
                  {f.scenarios
                    .filter((s) => !q || s.name.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
                    .map((s) => {
                      const ref: SpecRef = { fileName: f.fileName, scenario: { name: s.name, version: s.version } };
                      return (
                        <li key={`${s.name}@${s.version}`} className="ref-picker-row nested">
                          <label>
                            <input type="checkbox" checked={keys.has(refKeyOf(ref))} onChange={() => toggle(ref)} />
                            <StatusIcon status={s.status} size={12} /> {s.name}{" "}
                            <span className="muted">v{s.version}</span>
                          </label>
                        </li>
                      );
                    })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- One plan ---------------------------------------------------------------------------------

function PlanView({ store, plan, features, members, assignments, repoCrumb, autosaveSeconds, prompt, confirm, onNavigate }: ViewProps & { plan: TestPlan }) {
  const description = useAutosave(`plan:${plan.id}`, plan.description, autosaveSeconds, (text) =>
    testing.updatePlan(plan.id, { description: text }),
  );
  const [addOpen, setAddOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const runs = executionsOf(plan.id, store.executions);
  const cases = plan.caseIds
    .map((id) => store.cases.find((c) => c.id === id))
    .filter((c): c is TestCase => c !== undefined);
  const available = store.cases.filter((c) => !plan.caseIds.includes(c.id));
  const setCaseIds = (caseIds: string[]) => void testing.updatePlan(plan.id, { caseIds });
  const move = (id: string, delta: number) => {
    const ids = [...plan.caseIds];
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setCaseIds(ids);
  };
  const startRun = async () => {
    const run = await testing.startExecution(plan.id);
    if (run) onNavigate({ kind: "run", id: run.id }, { push: true });
  };
  return (
    <>
      <PaneHeader
        crumbs={[repoCrumb, testsCrumb(onNavigate)]}
        tail={plan.name}
        actions={
          <>
            <SaveIndicator saving={description.saving} savedAt={description.savedAt} dirty={description.dirty} />
            <button type="button" className="primary-action" disabled={plan.caseIds.length === 0} title={plan.caseIds.length === 0 ? "Add test cases first" : "Start a run of this plan"} onClick={() => void startRun()}>
              <Play size={14} aria-hidden="true" /> Start run
            </button>
            <MoreMenu
              label={`Menu for ${plan.name}`}
              items={[
                { id: "rename", label: "Rename", icon: <Pencil size={13} />, onSelect: () => void renamePlanFlow(plan, prompt) },
                { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => void copyTestsLink({ kind: "plan", id: plan.id }) },
                { id: "delete", label: "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => void deletePlanFlow(plan, confirm, onNavigate, { kind: "plan", id: plan.id }) },
              ]}
            />
          </>
        }
      />
      <div className="props">
        {assignments && (
          <AssigneeChip
            assigned={plan.assigned}
            members={members}
            disabled={assigning}
            onPick={(name) => {
              setAssigning(true);
              void testing.updatePlan(plan.id, { assigned: name || null }).finally(() => setAssigning(false));
            }}
          />
        )}
        <span className="chip muted">
          {plan.caseIds.length} case{plan.caseIds.length === 1 ? "" : "s"}
        </span>
        {runs[0] && (
          <span className="chip" title="Latest run">
            <ProgressBar progress={executionProgress(runs[0])} />
          </span>
        )}
      </div>
      <div className="tests-body">
        <section className="tests-section">
          <MarkdownEditor
            value={description.draft}
            onChange={description.setDraft}
            placeholder="What this plan covers, scope, environment… (Markdown)"
          />
        </section>
        <section className="tests-section">
          <div className="tests-section-head">
            <h3>Test cases</h3>
            <span className="chip-anchor tests-add-anchor">
              <button type="button" className="secondary" aria-haspopup="dialog" aria-expanded={addOpen} onClick={() => setAddOpen((o) => !o)}>
                <Plus size={13} aria-hidden="true" /> Add cases
              </button>
              <Popover open={addOpen} onClose={() => setAddOpen(false)} label="Add test cases" className="chip-popover case-picker" containerSelector=".tests-add-anchor">
                <CasePicker
                  cases={available}
                  onAdd={(id) => setCaseIds([...plan.caseIds, id])}
                  onNew={() => {
                    setAddOpen(false);
                    void newCaseFlow(prompt, onNavigate, plan.id);
                  }}
                />
              </Popover>
            </span>
          </div>
          {cases.length === 0 ? (
            <p className="empty">No test cases in this plan yet — add some from the library.</p>
          ) : (
            <table className="tests-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Test case</th>
                  <th>Priority</th>
                  <th>Covers</th>
                  <th>Latest result</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {cases.map((c, i) => {
                  const latest = latestResultFor(c.id, store.executions, plan.id);
                  return (
                    <tr key={c.id}>
                      <td className="num muted">{i + 1}</td>
                      <td>
                        <ViewLink to={{ kind: "case", id: c.id }} go={onNavigate} className="tests-title">
                          {c.title}
                        </ViewLink>
                      </td>
                      <td>
                        <PriorityChip priority={c.priority} />
                      </td>
                      <td className="refs-cell">
                        {c.refs.map((r) => (
                          <RefChip key={refKeyOf(r)} spec={r} features={features} />
                        ))}
                      </td>
                      <td>{latest ? <ResultBadge status={latest.result.status} /> : <ResultBadge status="untested" muted />}</td>
                      <td className="actions row-tools">
                        <button type="button" className="ibtn" aria-label="Move up" disabled={i === 0} onClick={() => move(c.id, -1)}>
                          <ChevronUp size={13} aria-hidden="true" />
                        </button>
                        <button type="button" className="ibtn" aria-label="Move down" disabled={i === cases.length - 1} onClick={() => move(c.id, 1)}>
                          <ChevronDown size={13} aria-hidden="true" />
                        </button>
                        <button type="button" className="ibtn" aria-label={`Remove ${c.title} from the plan`} onClick={() => setCaseIds(plan.caseIds.filter((x) => x !== c.id))}>
                          <X size={13} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
        <section className="tests-section">
          <div className="tests-section-head">
            <h3>Runs</h3>
          </div>
          {runs.length === 0 ? (
            <p className="empty">Not run yet.</p>
          ) : (
            <table className="tests-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Started</th>
                  <th className="wide">Progress</th>
                  <th>State</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    plan={plan}
                    go={onNavigate}
                    menu={
                      <MoreMenu
                        label={`Menu for ${run.name}`}
                        items={[
                          { id: "rename", label: "Rename", icon: <Pencil size={13} />, onSelect: () => void renameRunFlow(run, prompt) },
                          { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => void copyTestsLink({ kind: "run", id: run.id }) },
                          { id: "delete", label: "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => void deleteRunFlow(run, confirm, onNavigate, { kind: "plan", id: plan.id }) },
                        ]}
                      />
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

/** The library's cases not yet in the plan; a click adds one. */
export function CasePicker({ cases, onAdd, onNew }: { cases: TestCase[]; onAdd: (id: string) => void; onNew: () => void }) {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = cases.filter((c) => !q || c.title.toLowerCase().includes(q));
  return (
    <div className="ref-picker-body">
      <input type="search" placeholder="Filter test cases…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter test cases" />
      <ul className="ref-picker-list">
        {shown.length === 0 && (
          <li className="muted">
            {cases.length === 0 ? "No test cases left to add — create one below." : "No cases match."}
          </li>
        )}
        {shown.map((c) => (
          <li key={c.id} className="ref-picker-row">
            <button type="button" className="case-pick" onClick={() => onAdd(c.id)}>
              <Plus size={12} aria-hidden="true" /> {c.title} <PriorityChip priority={c.priority} />
            </button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onNew}>
          + New case in this plan
        </button>
      </div>
    </div>
  );
}

// --- The runner --------------------------------------------------------------------------------

function RunView({ store, run, features, members, assignments, repoCrumb, prompt, confirm, onNavigate }: ViewProps & { run: TestPlanExecution }) {
  const plan = store.plans.find((p) => p.id === run.planId) ?? null;
  const progress = executionProgress(run);
  const [assigning, setAssigning] = useState(false);
  const finish = async () => {
    if (progress.untested > 0) {
      const ok = await confirm({
        title: "Finish the run?",
        body: `${progress.untested} case(s) are still untested. They stay untested in this run.`,
        confirmLabel: "Finish",
      });
      if (!ok) return;
    }
    await testing.updateExecution(run.id, { finish: true });
  };
  const planCrumb: Crumb = plan
    ? { label: plan.name, href: testsPath({ kind: "plan", id: plan.id }), onClick: (e) => spaClick(e, () => onNavigate({ kind: "plan", id: plan.id }, { push: true })) }
    : { label: "Deleted plan" };
  return (
    <>
      <PaneHeader
        crumbs={[repoCrumb, testsCrumb(onNavigate), planCrumb]}
        tail={run.name}
        actions={
          <>
            {run.finishedAt ? (
              <button type="button" className="secondary" onClick={() => void testing.updateExecution(run.id, { finish: false })}>
                Reopen
              </button>
            ) : (
              <button type="button" className="primary-action" onClick={() => void finish()}>
                <Check size={14} aria-hidden="true" /> Finish run
              </button>
            )}
            <MoreMenu
              label={`Menu for ${run.name}`}
              items={[
                { id: "rename", label: "Rename", icon: <Pencil size={13} />, onSelect: () => void renameRunFlow(run, prompt) },
                { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => void copyTestsLink({ kind: "run", id: run.id }) },
                { id: "delete", label: "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => void deleteRunFlow(run, confirm, onNavigate, { kind: "run", id: run.id }) },
              ]}
            />
          </>
        }
      />
      <div className="props">
        {assignments && (
          <AssigneeChip
            assigned={run.assigned}
            members={members}
            disabled={assigning}
            onPick={(name) => {
              setAssigning(true);
              void testing.updateExecution(run.id, { assigned: name || null }).finally(() => setAssigning(false));
            }}
          />
        )}
        <span className="chip">
          <ProgressBar progress={progress} />
        </span>
        <span className={`chip muted run-state${run.finishedAt ? " finished" : ""}`}>
          {run.finishedAt ? `Finished ${formatWhen(run.finishedAt)}` : `Started ${formatWhen(run.startedAt)}`}
        </span>
      </div>
      <div className="tests-body">
        <p className="hint runner-hint">
          Record a verdict per case. With a row focused, <kbd>p</kbd> passed, <kbd>f</kbd> failed, <kbd>b</kbd> blocked, <kbd>s</kbd> skipped, <kbd>u</kbd> untested.
        </p>
        <table className="tests-table runner">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Test case</th>
              <th>Verdict</th>
              <th className="wide">Comment</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            {run.caseIds.map((caseId, i) => (
              <ResultRow
                key={caseId}
                index={i}
                run={run}
                caseId={caseId}
                testCase={store.cases.find((c) => c.id === caseId) ?? null}
                features={features}
                go={onNavigate}
                readOnly={run.finishedAt !== undefined}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ResultRow({
  index,
  run,
  caseId,
  testCase,
  features,
  go,
  readOnly,
}: {
  index: number;
  run: TestPlanExecution;
  caseId: string;
  testCase: TestCase | null;
  features: FeatureListing[];
  go: Navigate;
  readOnly: boolean;
}) {
  const result = run.results[caseId] ?? { status: "untested" as ResultStatus, comment: "" };
  const [comment, setComment] = useState(result.comment);
  const spellCheck = useSpellCheck();
  const commentKey = useRef(result.comment);
  if (commentKey.current !== result.comment) {
    // A result landed (ours, or a teammate's): the field follows it.
    commentKey.current = result.comment;
    setComment(result.comment);
  }
  const record = (status: ResultStatus, text = comment) => {
    if (readOnly) return;
    void testing.setResult(run.id, caseId, { status, comment: cleanLine(text) });
  };
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (readOnly || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const status = RESULT_KEYS[e.key.toLowerCase()];
    if (!status) return;
    e.preventDefault();
    record(status);
  };
  return (
    <tr className={`result-row ${result.status}`} tabIndex={0} onKeyDown={onKey}>
      <td className="num muted">{index + 1}</td>
      <td>
        {testCase ? (
          <>
            <ViewLink to={{ kind: "case", id: testCase.id }} go={go} className="tests-title">
              {testCase.title}
            </ViewLink>
            {testCase.refs.length > 0 && (
              <div className="refs-cell">
                {testCase.refs.map((r) => (
                  <RefChip key={refKeyOf(r)} spec={r} features={features} />
                ))}
              </div>
            )}
          </>
        ) : (
          <span className="muted">(deleted case)</span>
        )}
      </td>
      <td>
        <div className="result-seg" role="radiogroup" aria-label="Verdict">
          {RESULT_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={result.status === s}
              className={`result-opt ${s}${result.status === s ? " on" : ""}`}
              disabled={readOnly}
              title={RESULT_LABEL[s]}
              onClick={() => record(s)}
            >
              {RESULT_LABEL[s]}
            </button>
          ))}
        </div>
      </td>
      <td className="wide">
        <input
          type="text"
          className="result-comment"
          placeholder={readOnly ? "" : "Notes, defect link…"}
          value={comment}
          readOnly={readOnly}
          spellCheck={spellCheck}
          onChange={(e) => setComment(e.target.value)}
          onBlur={() => {
            // Saved cleaned (specs/ui/ui.feature.md "User-entered text is
            // cleaned up"): a stray space is no change, and the field shows
            // what was kept.
            const cleaned = cleanLine(comment);
            if (cleaned !== result.comment) record(result.status, cleaned);
            else setComment(cleaned);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-label={`Comment for ${testCase?.title ?? "case"}`}
        />
      </td>
      <td className="muted small">
        {result.at ? (
          <>
            {result.by ? `${result.by} · ` : ""}
            {formatWhen(result.at)}
          </>
        ) : (
          ""
        )}
      </td>
    </tr>
  );
}

// --- The sidebar panel ----------------------------------------------------------------------

export function TestsSidebar({ view, prompt, confirm, onNavigate, readOnly = false }: { view: TestsRoute | null; prompt: Prompt; confirm: Confirm; onNavigate: Navigate; readOnly?: boolean }) {
  const store = useTesting();
  const [menu, setMenu] = useState<string | null>(null);
  const activeId = view && "id" in view ? view.id : null;
  /** The list: the open row is revealed in it, and keys walk its rows. */
  const listRef = useRef<HTMLDivElement>(null);
  useRevealActive(listRef, activeId);
  const row = (
    key: string,
    to: TestsRoute,
    label: ReactNode,
    title: string,
    items: MenuItem[],
    extra?: ReactNode,
  ) => (
    <div key={key} className="page-row">
      <a
        href={testsPath(to)}
        className={`page-entry${activeId === key ? " active" : ""}`}
        title={title}
        role="treeitem"
        aria-level={1}
        data-menu={key}
        aria-current={activeId === key ? "page" : undefined}
        onClick={(e) => spaClick(e, () => onNavigate(to, { push: true }))}
      >
        {label}
        {extra}
      </a>
      {!readOnly && (
      <span className="tree-row-menu">
        <Tooltip label="More actions">
          <button
            type="button"
            className="tree-menu-btn"
            aria-label={`Menu for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menu === key}
            onClick={() => setMenu((m) => (m === key ? null : key))}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </button>
        </Tooltip>
        <Menu open={menu === key} onClose={() => setMenu(null)} label={`Menu for ${title}`} className="tree-menu" containerSelector=".tree-row-menu" items={items} />
      </span>
      )}
    </div>
  );
  const open = view ?? { kind: "plans" as const };
  return (
    <div className="side-panel page-list" role="tabpanel" id="side-panel-tests" aria-labelledby="side-tab-tests">
      {/* The tab's head (src/frontend/SidebarSection.tsx): its name is the
          overview link, and the "new" actions are icons — none on the
          read-only site (src/server/readOnlyMode.ts). */}
      <SidebarSection
        label={
          <a
            href="/tests"
            className={view?.kind === "plans" ? "active" : undefined}
            onClick={(e) => spaClick(e, () => onNavigate({ kind: "plans" }, { push: true }))}
          >
            Tests
          </a>
        }
        actions={
          !readOnly && (
            <>
              <SectionAction label="New plan" icon={<ClipboardPlus size={15} />} onClick={() => void newPlanFlow(prompt, onNavigate)} />
              <SectionAction label="New case" keys="c" icon={<ListPlus size={15} />} onClick={() => void newCaseFlow(prompt, onNavigate)} />
            </>
          )
        }
      />
      <div className="page-rows" role="tree" aria-label="Tests" ref={listRef} onKeyDown={(e) => listKeyDown(e, setMenu)}>
        <div className="page-group">Plans</div>
        {store.plans.map((plan) => {
          const { progress } = planRollup(plan, store.executions);
          return row(
            plan.id,
            { kind: "plan", id: plan.id },
            plan.name,
            plan.name,
            [
              { id: "rename", label: "Rename", icon: <Pencil size={13} />, onSelect: () => void renamePlanFlow(plan, prompt) },
              { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => void copyTestsLink({ kind: "plan", id: plan.id }) },
              { id: "delete", label: "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => void deletePlanFlow(plan, confirm, onNavigate, open) },
            ],
            progress ? (
              <span className="page-entry-meta" aria-label={progressSummary(progress)}>
                {progress.done}/{progress.total}
              </span>
            ) : undefined,
          );
        })}
        {store.plans.length === 0 && <p className="empty">No test plans yet</p>}
        <div className="page-group">
          <a
            href="/tests/cases"
            className={view?.kind === "cases" ? "active" : undefined}
            onClick={(e) => spaClick(e, () => onNavigate({ kind: "cases" }, { push: true }))}
          >
            Cases
          </a>
        </div>
        {store.cases.map((c) =>
          row(
            c.id,
            { kind: "case", id: c.id },
            c.title,
            c.title,
            [
              { id: "rename", label: "Rename", icon: <Pencil size={13} />, onSelect: () => void renameCaseFlow(c, prompt) },
              { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => void copyTestsLink({ kind: "case", id: c.id }) },
              { id: "delete", label: "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => void deleteCaseFlow(c, confirm, onNavigate, open) },
            ],
          ),
        )}
        {store.cases.length === 0 && <p className="empty">No test cases yet</p>}
      </div>
    </div>
  );
}

// The GitHub issues pane (specs/app/github-issues.feature.md): the whole
// main column while the Issues tab is open — the issue list with its
// open/closed filter, the new-issue form, and one issue with its comments,
// where the title and body are edited, the issue closed or reopened, and a
// comment added. Reads the module store (src/frontend/issues.ts) and
// navigates through App's `onNavigate`, so App.tsx holds only which view is
// open. The sidebar's Issues panel (IssuesSidebar) lives here too, since it
// lists the same issues. Small presentational pieces are exported for the
// static-markup tests (tests/issuesPane.test.tsx).

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useSpellCheck } from "./spellCheckPref";
import {
  Bug,
  CircleCheck,
  CircleDot,
  CircleSlash,
  Ellipsis,
  ExternalLink,
  Link,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
} from "lucide-react";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";
import { MarkdownEditor } from "./MarkdownEditor";
import { Menu, type MenuItem } from "./Menu";
import type { ConfirmOptions, PromptOptions } from "./ModalPrompts";
import { renderMarkdown } from "./markdown";
import { shareUrl } from "./shareLink";
import { toast } from "./Toasts";
import { Tooltip } from "./Tooltip";
import { issuesPath, type IssuesRoute } from "../plugins/builtin/issues/route";
import { formatWhen } from "./testing";
import { cleanLine, cleanText } from "../server/text";
import {
  issues,
  labelStyle,
  useIssues,
  type Issue,
  type IssueComment,
  type IssueState,
  type IssuesStore,
} from "./issues";

export type Navigate = (view: IssuesRoute, opts?: { push?: boolean }) => void;
type Prompt = (opts: PromptOptions) => Promise<string | null>;
type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

/** Handle a link in-app on a plain click; modified clicks keep the browser's. */
function spaClick(e: MouseEvent, go: () => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go();
}

// --- Flows shared by the pane and the sidebar ------------------------------------

export async function renameIssueFlow(issue: Issue, prompt: Prompt): Promise<void> {
  const title = await prompt({ title: "Edit the issue title", initial: issue.title, confirmLabel: "Save" });
  const cleaned = cleanLine(title ?? "");
  if (cleaned && cleaned !== issue.title) await issues.update(issue.number, { title: cleaned });
}

export async function closeIssueFlow(
  issue: Issue,
  confirm: Confirm,
  reason: "completed" | "not_planned" = "completed",
): Promise<void> {
  const ok = await confirm({
    title: `Close #${issue.number}?`,
    body:
      reason === "not_planned"
        ? "The issue is closed as not planned. It can be reopened on GitHub or here."
        : "The issue is closed as completed. It can be reopened on GitHub or here.",
    confirmLabel: reason === "not_planned" ? "Close as not planned" : "Close issue",
  });
  if (!ok) return;
  if (await issues.close(issue.number, reason)) toast.success(`Closed #${issue.number}.`);
}

export async function reopenIssueFlow(issue: Issue): Promise<void> {
  if (await issues.reopen(issue.number)) toast.success(`Reopened #${issue.number}.`);
}

async function copyIssuesLink(view: IssuesRoute): Promise<void> {
  const path = issuesPath(view);
  const url = shareUrl(path);
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied.");
  } catch {
    toast.error("Could not copy the link.");
  }
}

/** The ⋯ menu's items for one issue, the same in the list, the sidebar and the pane.
    Read-only (the demo) keeps the two that only read: the link and GitHub. */
function issueMenuItems(issue: Issue, prompt: Prompt, confirm: Confirm, readOnly = false): MenuItem[] {
  const reading: MenuItem[] = [
    { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => void copyIssuesLink({ kind: "issue", number: issue.number }) },
    { id: "github", label: "Open on GitHub", icon: <ExternalLink size={13} />, onSelect: () => window.open(issue.url, "_blank", "noopener") },
  ];
  if (readOnly) return reading;
  return [
    { id: "rename", label: "Edit title", icon: <Pencil size={13} />, onSelect: () => void renameIssueFlow(issue, prompt) },
    ...reading,
    ...(issue.state === "open"
      ? [
          { id: "close", label: "Close as completed", icon: <CircleCheck size={13} />, onSelect: () => void closeIssueFlow(issue, confirm) },
          { id: "close-np", label: "Close as not planned", icon: <CircleSlash size={13} />, onSelect: () => void closeIssueFlow(issue, confirm, "not_planned") },
        ]
      : [{ id: "reopen", label: "Reopen", icon: <RotateCcw size={13} />, onSelect: () => void reopenIssueFlow(issue) }]),
  ];
}

// --- Small pieces --------------------------------------------------------------------

/** Open (green dot), closed as completed (purple check) or not planned (grey slash). */
export function StateBadge({ issue }: { issue: Pick<Issue, "state" | "stateReason"> }) {
  const closed = issue.state === "closed";
  const notPlanned = closed && issue.stateReason === "not_planned";
  const label = closed ? (notPlanned ? "Closed as not planned" : "Closed") : "Open";
  const Icon = closed ? (notPlanned ? CircleSlash : CircleCheck) : CircleDot;
  return (
    <span className={`issue-state ${closed ? (notPlanned ? "not-planned" : "closed") : "open"}`} title={label}>
      <Icon size={13} aria-hidden="true" /> {label}
    </span>
  );
}

export function LabelChip({ label }: { label: { name: string; color: string } }) {
  return (
    <span className="issue-label" style={labelStyle(label.color)}>
      {label.name}
    </span>
  );
}

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
      <Menu open={open} onClose={() => setOpen(false)} label={label} className="tree-menu" containerSelector=".tests-more" items={items} />
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

function ViewLink({ to, go, className, children, ...rest }: { to: IssuesRoute; go: Navigate; className?: string; children: ReactNode; title?: string }) {
  return (
    <a href={issuesPath(to)} className={className} onClick={(e) => spaClick(e, () => go(to, { push: true }))} {...rest}>
      {children}
    </a>
  );
}

function issuesCrumb(go: Navigate): Crumb {
  return {
    label: "Issues",
    href: "/issues",
    onClick: (e) => spaClick(e, () => go({ kind: "list" }, { push: true })),
  };
}

/** The list's Open / Closed / All switch; picking one reloads the list. */
export function StateFilter({ filter, onChange, compact = false }: { filter: IssueState; onChange: (s: IssueState) => void; compact?: boolean }) {
  const states: IssueState[] = compact ? ["open", "closed"] : ["open", "closed", "all"];
  return (
    <div className={`issue-filter${compact ? " compact" : ""}`} role="radiogroup" aria-label="Show issues">
      {states.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={filter === s}
          className={filter === s ? "active" : ""}
          onClick={() => onChange(s)}
        >
          {s === "open" ? "Open" : s === "closed" ? "Closed" : "All"}
        </button>
      ))}
    </div>
  );
}

/**
 * What the pane shows when GitHub could not be reached: the reason, and —
 * when the reason is a missing sign-in — the way to Settings, where the
 * GitHub sign-in lives.
 */
export function IssuesError({ error, onOpenSettings, onRetry }: { error: string; onOpenSettings: () => void; onRetry: () => void }) {
  const needsSignIn = /sign in/i.test(error);
  return (
    <div className="view-error issues-error">
      <Bug size={28} aria-hidden="true" />
      <p>{error}</p>
      <div className="view-error-actions">
        {needsSignIn && (
          <button type="button" onClick={onOpenSettings}>
            <Settings size={14} aria-hidden="true" /> Open Settings
          </button>
        )}
        <button type="button" className="secondary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

// --- The pane ---------------------------------------------------------------------------

export interface IssuesPaneProps {
  view: IssuesRoute;
  repoCrumb: Crumb;
  prompt: Prompt;
  confirm: Confirm;
  onNavigate: Navigate;
  /** Opens the Settings dialog, where the GitHub sign-in lives. */
  onOpenSettings: () => void;
}

export function IssuesPane(props: IssuesPaneProps) {
  const store = useIssues();
  const { view } = props;
  switch (view.kind) {
    case "list":
      return <ListView {...props} store={store} />;
    case "new":
      return <NewView {...props} store={store} />;
    case "issue":
      return <IssueView {...props} store={store} number={view.number} />;
  }
}

type ViewProps = IssuesPaneProps & { store: IssuesStore };

/** A link to the repository on GitHub, for the header. */
function RepoLink({ store, tail = "" }: { store: IssuesStore; tail?: string }) {
  if (!store.repo) return null;
  return (
    <a className="tests-link" href={`${store.repo.url}/issues${tail}`} target="_blank" rel="noopener noreferrer" title="Open on GitHub">
      {store.repo.owner}/{store.repo.name} <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

// --- Issue list ---------------------------------------------------------------------------

function ListView({ store, repoCrumb, prompt, confirm, onNavigate, onOpenSettings }: ViewProps) {
  const filterLabel = store.filter === "open" ? "Open issues" : store.filter === "closed" ? "Closed issues" : "All issues";
  return (
    <>
      <PaneHeader
        crumbs={[repoCrumb, issuesCrumb(onNavigate)]}
        tail={filterLabel}
        actions={
          <>
            <RepoLink store={store} />
            <StateFilter filter={store.filter} onChange={(s) => void issues.load(s)} />
            {!store.readOnly && (
              <button type="button" className="primary-action" onClick={() => onNavigate({ kind: "new" }, { push: true })}>
                <Plus size={14} aria-hidden="true" /> New issue
              </button>
            )}
          </>
        }
      />
      <div className="tests-body">
        {store.error && !store.loading ? (
          <IssuesError error={store.error} onOpenSettings={onOpenSettings} onRetry={() => void issues.load()} />
        ) : !store.loaded ? (
          <p className="hint">Loading issues from GitHub…</p>
        ) : store.issues.length === 0 ? (
          <div className="tests-empty">
            <Bug size={28} aria-hidden="true" />
            <p>No {store.filter === "all" ? "" : store.filter + " "}issues.</p>
            <p className="hint">
              Issues live on GitHub, in {store.repo ? `${store.repo.owner}/${store.repo.name}` : "the code repo"}
              {store.readOnly
                ? "; the demo shows them as they are there, and changes none of them."
                : "; what is created here shows up there at once."}
            </p>
            {!store.readOnly && (
              <button type="button" onClick={() => onNavigate({ kind: "new" }, { push: true })}>
                + New issue
              </button>
            )}
          </div>
        ) : (
          <table className="tests-table issues-table" aria-busy={store.loading || undefined}>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Issue</th>
                <th>State</th>
                <th>Opened</th>
                <th>Assigned</th>
                <th className="num" aria-label="Comments">
                  <MessageSquare size={12} aria-hidden="true" />
                </th>
                <th className="actions" />
              </tr>
            </thead>
            <tbody>
              {store.issues.map((issue) => (
                <IssueRow
                  key={issue.number}
                  issue={issue}
                  go={onNavigate}
                  menu={<MoreMenu label={`Menu for #${issue.number}`} items={issueMenuItems(issue, prompt, confirm, store.readOnly)} />}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function IssueRow({ issue, go, menu }: { issue: Issue; go: Navigate; menu?: ReactNode }) {
  const to: IssuesRoute = { kind: "issue", number: issue.number };
  return (
    <tr>
      <td className="num muted">{issue.number}</td>
      <td>
        <ViewLink to={to} go={go} className="tests-title">
          {issue.title}
        </ViewLink>
        {issue.labels.length > 0 && (
          <span className="issue-labels">
            {issue.labels.map((l) => (
              <LabelChip key={l.name} label={l} />
            ))}
          </span>
        )}
      </td>
      <td>
        <StateBadge issue={issue} />
      </td>
      <td className="muted small">
        {formatWhen(issue.createdAt)}
        {issue.author ? ` by ${issue.author}` : ""}
      </td>
      <td className="muted small">{issue.assignees.join(", ") || "—"}</td>
      <td className="num muted small">{issue.comments > 0 ? issue.comments : ""}</td>
      <td className="actions">{menu}</td>
    </tr>
  );
}

// --- New issue ----------------------------------------------------------------------------

function NewView({ repoCrumb, onNavigate, store }: ViewProps) {
  const [title, setTitle] = useState("");
  const spellCheck = useSpellCheck();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = title.trim() !== "" || body.trim() !== "";
  // Read-only (the demo) takes the New issue buttons off the screen, but the
  // url stays typeable — say why rather than offer a form the server refuses.
  const readOnly = store.readOnly;
  useEffect(() => {
    issues.setDirty("new", dirty);
    return () => issues.setDirty("new", false);
  }, [dirty]);
  if (readOnly) {
    return (
      <div className="view-error">
        <p>The demo shows this repository's issues; it does not create them.</p>
        <div className="view-error-actions">
          <ViewLink to={{ kind: "list" }} go={onNavigate}>
            Back to the issues
          </ViewLink>
        </div>
      </div>
    );
  }
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const issue = await issues.create({ title: cleanLine(title), body: cleanText(body) });
    setBusy(false);
    if (issue) {
      toast.success(`Created #${issue.number}.`);
      setTitle("");
      setBody("");
      onNavigate({ kind: "issue", number: issue.number }, { push: true });
    }
  };
  return (
    <>
      <PaneHeader
        crumbs={[repoCrumb, issuesCrumb(onNavigate)]}
        tail="New issue"
        actions={
          <>
            <RepoLink store={store} tail="/new" />
            <button type="button" className="secondary" onClick={() => onNavigate({ kind: "list" }, { push: true })}>
              Cancel
            </button>
            <button type="button" className="primary-action" disabled={!title.trim() || busy} onClick={() => void submit()}>
              <Plus size={14} aria-hidden="true" /> {busy ? "Creating…" : "Create issue"}
            </button>
          </>
        }
      />
      <div className="tests-body issue-form">
        <input
          className="issue-title-input"
          type="text"
          value={title}
          placeholder="Title"
          aria-label="Issue title"
          autoFocus
          spellCheck={spellCheck}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <MarkdownEditor value={body} onChange={setBody} placeholder="Describe the bug: what happened, what you expected, how to reproduce it…" />
      </div>
    </>
  );
}

// --- One issue ----------------------------------------------------------------------------

function IssueView({ store, number, repoCrumb, prompt, confirm, onNavigate, onOpenSettings }: ViewProps & { number: number }) {
  const detail = store.details[number];
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    // A number the list knows already shows at once; the comments follow.
    let live = true;
    setError(null);
    setLoading(true);
    void issues.open(number, { quiet: true }).then((d) => {
      if (!live) return;
      setLoading(false);
      if (!d) setError(`Issue #${number} could not be loaded from GitHub.`);
    });
    return () => {
      live = false;
    };
  }, [number]);
  const listed = store.issues.find((i) => i.number === number);
  const issue = detail?.issue ?? listed;
  if (!issue) {
    if (loading) return <p className="hint">Loading issue #{number} from GitHub…</p>;
    return (
      <div className="view-error">
        <p>{error ?? `Issue #${number} was not found.`}</p>
        <div className="view-error-actions">
          {/sign in/i.test(store.error ?? "") && (
            <button type="button" onClick={onOpenSettings}>
              Open Settings
            </button>
          )}
          <ViewLink to={{ kind: "list" }} go={onNavigate}>
            Back to the issues
          </ViewLink>
        </div>
      </div>
    );
  }
  return (
    <IssueDetailView
      issue={issue}
      comments={detail?.comments ?? null}
      repoCrumb={repoCrumb}
      prompt={prompt}
      confirm={confirm}
      onNavigate={onNavigate}
    />
  );
}

function IssueDetailView({ issue, comments, repoCrumb, prompt, confirm, onNavigate }: {
  issue: Issue;
  /** Null while the comments are still on their way. */
  comments: IssueComment[] | null;
  repoCrumb: Crumb;
  prompt: Prompt;
  confirm: Confirm;
  onNavigate: Navigate;
}) {
  const store = useIssues();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.body);
  const [saving, setSaving] = useState(false);
  const [comment, setComment] = useState("");
  const [commenting, setCommenting] = useState(false);
  const dirty = (editing && draft !== issue.body) || comment.trim() !== "";
  useEffect(() => {
    issues.setDirty(`issue:${issue.number}`, dirty);
    return () => issues.setDirty(`issue:${issue.number}`, false);
  }, [issue.number, dirty]);
  const startEdit = () => {
    setDraft(issue.body);
    setEditing(true);
  };
  const saveBody = async () => {
    setSaving(true);
    const saved = await issues.update(issue.number, { body: cleanText(draft) });
    setSaving(false);
    if (saved) setEditing(false);
  };
  const addComment = async () => {
    if (!comment.trim() || commenting) return;
    setCommenting(true);
    const added = await issues.comment(issue.number, cleanText(comment));
    setCommenting(false);
    if (added) setComment("");
  };
  const open = issue.state === "open";
  return (
    <>
      <PaneHeader
        crumbs={[repoCrumb, issuesCrumb(onNavigate)]}
        tail={
          <>
            <span className="muted issue-crumb-number">#{issue.number}</span>
            {issue.title}
          </>
        }
        actions={
          <>
            <a className="tests-link" href={issue.url} target="_blank" rel="noopener noreferrer" title="Open on GitHub">
              GitHub <ExternalLink size={11} aria-hidden="true" />
            </a>
            {store.readOnly ? null : open ? (
              <button type="button" className="secondary" onClick={() => void closeIssueFlow(issue, confirm)}>
                <CircleCheck size={14} aria-hidden="true" /> Close issue
              </button>
            ) : (
              <button type="button" className="secondary" onClick={() => void reopenIssueFlow(issue)}>
                <RotateCcw size={14} aria-hidden="true" /> Reopen
              </button>
            )}
            <MoreMenu label={`Menu for #${issue.number}`} items={issueMenuItems(issue, prompt, confirm, store.readOnly)} />
          </>
        }
      />
      <div className="tests-body issue-view">
        <div className="props">
          <StateBadge issue={issue} />
          <span className="chip muted" title={issue.createdAt}>
            {issue.author ? `${issue.author} opened ` : "Opened "}
            {formatWhen(issue.createdAt)}
          </span>
          {issue.closedAt && (
            <span className="chip muted" title={issue.closedAt}>
              Closed {formatWhen(issue.closedAt)}
            </span>
          )}
          {issue.assignees.length > 0 && (
            <span className="chip muted" title="Assigned on GitHub">
              Assigned: {issue.assignees.join(", ")}
            </span>
          )}
          {issue.labels.map((l) => (
            <LabelChip key={l.name} label={l} />
          ))}
        </div>
        <section className="issue-body">
          <div className="tests-section-head">
            <h3 className="issue-section-title">Description</h3>
            {!editing && !store.readOnly && (
              <button type="button" className="ibtn issue-edit" aria-label="Edit description" onClick={startEdit}>
                <Pencil size={13} aria-hidden="true" /> Edit
              </button>
            )}
          </div>
          {editing ? (
            <>
              <MarkdownEditor value={draft} onChange={setDraft} placeholder="Describe the issue in Markdown…" />
              <div className="issue-form-actions">
                <button type="button" className="secondary" disabled={saving} onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button type="button" className="primary-action" disabled={saving || draft === issue.body} onClick={() => void saveBody()}>
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          ) : issue.body.trim() ? (
            <div className="md-preview issue-markdown">{renderMarkdown(issue.body)}</div>
          ) : (
            <p className="hint">No description.</p>
          )}
        </section>
        <section className="issue-comments">
          <h3 className="issue-section-title">
            {comments === null ? "Comments" : `${comments.length} comment${comments.length === 1 ? "" : "s"}`}
          </h3>
          {comments === null ? (
            <p className="hint">Loading comments…</p>
          ) : (
            comments.map((c) => <CommentCard key={c.id} comment={c} />)
          )}
          {!store.readOnly && (
            <div className="issue-comment-form">
              <MarkdownEditor value={comment} onChange={setComment} placeholder="Leave a comment…" />
              <div className="issue-form-actions">
                <button type="button" className="primary-action" disabled={!comment.trim() || commenting} onClick={() => void addComment()}>
                  <MessageSquare size={14} aria-hidden="true" /> {commenting ? "Commenting…" : "Comment"}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

export function CommentCard({ comment }: { comment: IssueComment }) {
  return (
    <article className="issue-comment">
      <header className="issue-comment-head">
        <span className="issue-comment-author">{comment.author ?? "someone"}</span>
        <a className="muted small" href={comment.url} target="_blank" rel="noopener noreferrer" title={comment.createdAt}>
          {formatWhen(comment.createdAt)}
        </a>
      </header>
      <div className="md-preview issue-markdown">{renderMarkdown(comment.body)}</div>
    </article>
  );
}

// --- The sidebar's Issues panel --------------------------------------------------------

export function IssuesSidebar({ view, prompt, confirm, onNavigate }: { view: IssuesRoute | null; prompt: Prompt; confirm: Confirm; onNavigate: Navigate }) {
  const store = useIssues();
  const [menu, setMenu] = useState<number | null>(null);
  const activeNumber = view?.kind === "issue" ? view.number : null;
  return (
    <div className="side-panel page-list" role="tabpanel" id="side-panel-issues" aria-labelledby="side-tab-issues">
      {!store.readOnly && (
        <div className="sidebar-actions">
          <button type="button" onClick={() => onNavigate({ kind: "new" }, { push: true })}>+ New issue</button>
        </div>
      )}
      <div className="page-rows">
        <a
          href="/issues"
          className={`page-entry tests-root${view?.kind === "list" ? " active" : ""}`}
          onClick={(e) => spaClick(e, () => onNavigate({ kind: "list" }, { push: true }))}
        >
          <Bug size={13} aria-hidden="true" /> All issues
        </a>
        <div className="page-group issue-group">
          <StateFilter filter={store.filter} onChange={(s) => void issues.load(s)} compact />
        </div>
        {store.issues.map((issue) => (
          <div key={issue.number} className="page-row">
            <a
              href={issuesPath({ kind: "issue", number: issue.number })}
              className={`page-entry${activeNumber === issue.number ? " active" : ""}`}
              title={`#${issue.number} ${issue.title}`}
              aria-current={activeNumber === issue.number ? "page" : undefined}
              onClick={(e) => spaClick(e, () => onNavigate({ kind: "issue", number: issue.number }, { push: true }))}
            >
              <span className="issue-number">#{issue.number}</span> {issue.title}
            </a>
            <span className="tree-row-menu">
              <Tooltip label="More actions">
                <button
                  type="button"
                  className="tree-menu-btn"
                  aria-label={`Menu for #${issue.number}`}
                  aria-haspopup="menu"
                  aria-expanded={menu === issue.number}
                  onClick={() => setMenu((m) => (m === issue.number ? null : issue.number))}
                >
                  <Ellipsis size={14} aria-hidden="true" />
                </button>
              </Tooltip>
              <Menu
                open={menu === issue.number}
                onClose={() => setMenu(null)}
                label={`Menu for #${issue.number}`}
                className="tree-menu"
                containerSelector=".tree-row-menu"
                items={issueMenuItems(issue, prompt, confirm, store.readOnly)}
              />
            </span>
          </div>
        ))}
        {store.error && !store.loading && <p className="empty">{store.error}</p>}
        {store.loaded && !store.error && store.issues.length === 0 && (
          <p className="empty">No {store.filter === "all" ? "" : store.filter + " "}issues</p>
        )}
        {!store.loaded && !store.error && <p className="empty">Loading…</p>}
      </div>
    </div>
  );
}

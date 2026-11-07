// The source-check dialog (specs/agents/agent-plugins.feature.md "A coding
// session should check that source is up to date"): before a session starts in
// a code repo, it shows how the branch stands against its remote of record and
// offers to refresh it — a merge or a rebase — or to start as it is. Offline,
// or with no remote, it shows the local state and only asks whether to proceed.
//
// The summary and the button set are pure and exported so bun test can check
// each state without a DOM (tests/sourceCheckDialog.test.tsx).

import { useState } from "react";
import { backdropDismiss } from "./backdropDismiss";
import { useFocusTrap } from "./useFocusTrap";
import type { RefreshMode, SourceStatus } from "./agentChat";

/** One line describing where the branch stands, for the dialog's body. */
export function sourceSummary(s: SourceStatus): string {
  const where = s.branch ? `on ${s.branch}` : "with a detached HEAD";
  if (s.detached) return `The repository is ${where} — new work has no branch to start from.`;
  if (!s.hasRemote) return `The branch ${s.branch ?? ""} is local only — it has no remote to compare against.`.trim();
  const parts: string[] = [];
  if (s.behind > 0) parts.push(`${s.behind} behind`);
  if (s.ahead > 0) parts.push(`${s.ahead} ahead of`);
  const rel = parts.length ? `${parts.join(" and ")} ${s.upstream}` : `up to date with ${s.upstream}`;
  const live = s.online ? "" : " (last known — the remote could not be reached)";
  const dirty = s.dirty ? " There are uncommitted changes." : "";
  return `${s.branch} is ${rel}${live}.${dirty}`;
}

/** Whether a refresh can run now: only when there is a remote and a clean tree. */
export function canRefresh(s: SourceStatus): boolean {
  return s.hasRemote && !s.detached && !s.dirty && s.online;
}

/** Why a refresh is off, when it is — shown under the actions. */
export function refreshHint(s: SourceStatus): string | null {
  if (!s.hasRemote || s.detached) return null;
  if (s.dirty) return "Commit or stash the uncommitted changes to refresh before starting.";
  if (!s.online) return "The remote could not be reached, so the branch cannot be refreshed now.";
  return null;
}

export interface SourceCheckDialogProps {
  status: SourceStatus;
  /** Run the refresh, then start; rejects when the refresh fails. */
  onRefresh: (mode: RefreshMode) => void;
  /** Start the session without refreshing. */
  onStartAnyway: () => void;
  onCancel: () => void;
  /** While a refresh is running, the actions are disabled. */
  busy?: boolean;
}

/** The dialog's body — rendered inside the modal, exported for tests. */
export function SourceCheckFields({ status, onRefresh, onStartAnyway, onCancel, busy }: SourceCheckDialogProps) {
  const refreshable = canRefresh(status);
  const hint = refreshHint(status);
  return (
    <>
      <h3>Start from up-to-date source</h3>
      <p className="hint">{sourceSummary(status)}</p>
      {hint && <p className="hint start-off">{hint}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-secondary" onClick={onStartAnyway} disabled={busy}>
          Start anyway
        </button>
        {refreshable && (
          <>
            <button type="button" className="btn btn-secondary" onClick={() => onRefresh("rebase")} disabled={busy}>
              Rebase &amp; start
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onRefresh("merge")} disabled={busy}>
              Update &amp; start
            </button>
          </>
        )}
      </div>
    </>
  );
}

export interface SourceCheckModalProps {
  status: SourceStatus;
  /** Run the refresh (awaited by the caller); resolves true to start, false to stay open. */
  onRefresh: (mode: RefreshMode) => Promise<boolean>;
  onStartAnyway: () => void;
  onClose: () => void;
}

export function SourceCheckDialog({ status, onRefresh, onStartAnyway, onClose }: SourceCheckModalProps) {
  const trapRef = useFocusTrap(true);
  const [busy, setBusy] = useState(false);
  const refresh = (mode: RefreshMode) => {
    setBusy(true);
    void onRefresh(mode).then((started) => {
      if (!started) setBusy(false);
    });
  };
  return (
    <div
      className="dialog-backdrop"
      {...backdropDismiss(onClose)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="dialog modal-dialog start-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Start from up-to-date source"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <SourceCheckFields
          status={status}
          busy={busy}
          onRefresh={refresh}
          onStartAnyway={onStartAnyway}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}

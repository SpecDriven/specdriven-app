// The dialog that says a spec folder opened read only (git-operations.md
// "a spec folder that cannot be pushed to opens read only", issue #467):
// why — no remote, or the remote turned this computer down, in git's own
// words — what is still possible, and the way back: Check again once a
// remote is added or access granted, or Settings for a sign-in problem.
// Shown once when a folder is found read only, and again from the sidebar's
// "Read only" chip.

import { useState } from "react";
import { backdropDismiss } from "./backdropDismiss";
import { fixedInSettings, remoteLabel } from "./repoReadOnly";
import type { RepoReadOnly } from "./repoReadOnly";
import { useFocusTrap } from "./useFocusTrap";

export function ReadOnlyRepoDialog({
  why,
  folder,
  onClose,
  onCheckAgain,
  onOpenSettings,
}: {
  why: RepoReadOnly;
  /** The folder's display name. */
  folder: string;
  onClose: () => void;
  /** Ask the remote again; resolves to the new answer, null once the folder may be edited. */
  onCheckAgain: () => Promise<RepoReadOnly | null>;
  /** Absent where Settings cannot help — the hosted app's sign-in lives elsewhere. */
  onOpenSettings?: () => void;
}) {
  const trapRef = useFocusTrap(true);
  const [checking, setChecking] = useState(false);
  const [stillReadOnly, setStillReadOnly] = useState(false);

  const checkAgain = async () => {
    setChecking(true);
    setStillReadOnly(false);
    try {
      const next = await onCheckAgain();
      if (next === null) onClose();
      else setStillReadOnly(true);
    } finally {
      setChecking(false);
    }
  };

  const settingsHelp = onOpenSettings && why.kind === "denied";
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
        className="dialog modal-dialog read-only-repo-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="This folder is read only"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>This folder is read only</h3>
        {why.kind === "no-remote" ? (
          <p className="modal-body">
            The git repository of <strong>{folder}</strong> has no remote, so nothing saved here would ever reach
            anyone else. You can read its specs, but not change them. To edit them, add a remote the repository can
            push to — <code>git remote add origin &lt;url&gt;</code> — then check again.
          </p>
        ) : (
          <>
            <p className="modal-body">
              You cannot push to <strong>{remoteLabel(why.remote) || "the remote"}</strong>, so nothing saved in{" "}
              <strong>{folder}</strong> would reach it. You can read the specs, and syncing keeps them up to date, but
              you cannot change them. To edit them, ask the repository's owner for write access, or sign in with an
              account that has it, then check again.
            </p>
            {why.reason && (
              <div className="read-only-reason">
                <span className="hint">What the remote said</span>
                <pre>{why.reason}</pre>
              </div>
            )}
          </>
        )}
        {stillReadOnly && (
          <p className="hint" role="status">
            Checked again: still read only.
          </p>
        )}
        <div className="dialog-actions">
          {settingsHelp && (
            <button
              type="button"
              className={fixedInSettings(why) ? "btn btn-secondary" : "btn btn-ghost"}
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
            >
              Open Settings
            </button>
          )}
          <button type="button" className="btn btn-secondary" disabled={checking} onClick={() => void checkAgain()}>
            {checking ? "Checking…" : "Check again"}
          </button>
          <button type="button" className="btn btn-primary" autoFocus onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

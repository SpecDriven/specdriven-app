// Spec folders (specs/app/spec-folders.feature.md): the app keeps a list of
// the specification folders it has opened — "data directory" in the rest of
// the UI — and this file holds the two dialogs around that list. Both are
// plain views: App.tsx owns the state and the requests, so the markup here
// can be checked on its own (tests/specFolders.test.tsx).

import { FolderOpen, Trash2 } from "lucide-react";
import { backdropDismiss } from "./backdropDismiss";
import type { KeyboardEvent, RefObject } from "react";
import { repoDisplayName } from "./route";

/**
 * "Switch spec folder": what the switch is doing right now. Saving comes
 * first — an open README, scenario, page or model belongs to the folder it
 * was typed in and lands there before anything else happens — then the
 * server opens the folder (a GitHub url is cloned on first use), then the
 * new folder's features and pages load.
 */
export type SwitchStep = "saving" | "opening" | "loading";

export const SWITCH_STEPS: ReadonlyArray<{ id: SwitchStep; label: string }> = [
  { id: "saving", label: "Saving open work in the current folder" },
  { id: "opening", label: "Opening the folder" },
  { id: "loading", label: "Loading features and pages" },
];

/**
 * The modal that covers the app while a spec folder switch runs
 * (specs/app/spec-folders.feature.md "Switch spec folder"). It has no
 * buttons and nothing closes it: the backdrop swallows clicks, ESC is
 * ignored, and the shortcut registry goes quiet while it is up (App.tsx
 * counts it among the open dialogs). It goes away when the switch finishes,
 * one way or the other.
 */
export function FolderSwitchDialog({
  folder,
  step,
  trapRef,
}: {
  folder: string;
  step: SwitchStep;
  trapRef?: RefObject<HTMLDivElement | null>;
}) {
  const at = SWITCH_STEPS.findIndex((s) => s.id === step);
  const current = SWITCH_STEPS[at]?.label ?? "";
  const swallow = (e: KeyboardEvent<HTMLDivElement>) => {
    // Nothing here to act on a key — and nothing behind it may either.
    e.stopPropagation();
    if (e.key === "Escape") e.preventDefault();
  };
  return (
    <div className="dialog-backdrop switch-backdrop" onKeyDown={swallow}>
      <div
        className="dialog switch-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy="true"
        aria-label="Switching spec folder"
        aria-describedby="switch-step"
        tabIndex={-1}
        ref={trapRef}
      >
        <h3>Switching spec folder</h3>
        <p className="switch-target">
          <FolderOpen size={14} aria-hidden="true" />
          <strong>{repoDisplayName(folder)}</strong>
          <span className="switch-path" title={folder}>
            {folder}
          </span>
        </p>
        <ol className="switch-steps" aria-label="Progress">
          {SWITCH_STEPS.map((s, i) => {
            const state = i < at ? "done" : i === at ? "current" : "pending";
            return (
              <li key={s.id} className={`switch-step ${state}`} aria-current={i === at ? "step" : undefined}>
                <span className="switch-mark" aria-hidden="true" />
                {s.label}
                {state === "current" && <span className="switch-ellipsis">…</span>}
              </li>
            );
          })}
        </ol>
        <div
          className="switch-progress"
          role="progressbar"
          aria-label="Loading the folder"
          aria-valuetext={current}
        >
          <i />
        </div>
        <p id="switch-step" className="hint">
          Everything else waits until the folder has loaded.
        </p>
      </div>
    </div>
  );
}

/**
 * "Manage specification folders": the folders the app knows, with the open
 * one marked. A folder can be opened from here, or taken off the list — the
 * list entry only; nothing on disk is deleted — and a new one picked from
 * the file system through the same prompt as the pencil beside the folder
 * name. The open folder stays: switch away from it before removing it.
 */
export function SpecFoldersDialog({
  folders,
  current,
  dirs = {},
  busy = false,
  onOpen,
  onRemove,
  onAdd,
  onClose,
  trapRef,
}: {
  /** Most recent first, the current folder included. */
  folders: string[];
  current: string | null;
  /** Where each GitHub url among `folders` is cloned on this computer. */
  dirs?: Record<string, string>;
  /** A request is in flight: the buttons wait for it. */
  busy?: boolean;
  onOpen: (folder: string) => void;
  onRemove: (folder: string) => void;
  /** Pick another folder from the file system (the Data directory prompt). */
  onAdd: () => void;
  onClose: () => void;
  trapRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div
        className="dialog spec-folders-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Spec folders"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h3>Spec folders</h3>
        <p className="hint">
          The specification folders this app has opened, most recent first. Removing one only
          takes it off this list — the folder stays on disk.
        </p>
        {folders.length === 0 ? (
          <p className="modal-body">No folders yet.</p>
        ) : (
          <ul className="spec-folders" aria-label="Spec folders">
            {folders.map((folder) => {
              const name = repoDisplayName(folder);
              const isCurrent = folder === current;
              return (
                <li key={folder} className={`spec-folder${isCurrent ? " current" : ""}`}>
                  <div className="spec-folder-text">
                    <span className="spec-folder-name">
                      {name}
                      {isCurrent && <span className="spec-folder-badge">open</span>}
                    </span>
                    <span className="spec-folder-path" title={folder}>
                      {folder}
                    </span>
                    {dirs[folder] && (
                      <span className="spec-folder-path spec-folder-clone" title={dirs[folder]}>
                        Cloned to {dirs[folder]}
                      </span>
                    )}
                  </div>
                  <div className="spec-folder-actions">
                    {!isCurrent && (
                      <button
                        type="button"
                        className="link"
                        disabled={busy}
                        title={`Open ${folder}`}
                        onClick={() => onOpen(folder)}
                      >
                        Open
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button spec-folder-remove"
                      disabled={busy || isCurrent}
                      aria-label={`Remove ${name} from the list`}
                      title={
                        isCurrent
                          ? "The open folder stays on the list — switch to another folder first"
                          : "Remove from the list — the folder itself stays on disk"
                      }
                      onClick={() => onRemove(folder)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onAdd}>
            Open another folder…
          </button>
          <button type="button" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

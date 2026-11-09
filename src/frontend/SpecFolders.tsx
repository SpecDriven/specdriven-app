// Spec folders (specs/app/spec-folders.feature.md): the app keeps a list of
// the specification folders it has opened — "data directory" in the rest of
// the UI — and this file holds the two dialogs around that list. Both are
// plain views: App.tsx owns the state and the requests, so the markup here
// can be checked on its own (tests/specFolders.test.tsx).

import { BookText, CodeXml, FolderOpen, Trash2 } from "lucide-react";
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

/** The two kinds of folder the app opens (src/server/state.ts FolderKind). */
export type FolderKind = "spec" | "code";

/** One entry on the folder list: a path (or GitHub url) and its kind. */
export interface FolderEntry {
  path: string;
  kind: FolderKind;
}

export const FOLDER_KIND_LABEL: Record<FolderKind, string> = {
  spec: "Specification folder",
  code: "Code repository",
};

/** Takes the server's recentFolders field, dropping anything malformed. */
export function parseRecentFolders(value: unknown): FolderEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e): FolderEntry[] =>
    e && typeof e === "object" && typeof e.path === "string" && (e.kind === "spec" || e.kind === "code")
      ? [{ path: e.path, kind: e.kind }]
      : [],
  );
}

/**
 * What kind of folder an entry is, as an icon (specs/app/spec-folders
 * .feature.md "Manage specification folders"): a book for a specification
 * folder, code brackets (</>) for a code repository. The kind is its
 * accessible name and tooltip.
 */
export function FolderKindIcon({ kind, size = 14 }: { kind: FolderKind; size?: number }) {
  const Icon = kind === "code" ? CodeXml : BookText;
  return (
    <span className={`folder-kind folder-kind-${kind}`} role="img" aria-label={FOLDER_KIND_LABEL[kind]} title={FOLDER_KIND_LABEL[kind]}>
      <Icon size={size} aria-hidden="true" />
    </span>
  );
}

const sameEntry = (a: FolderEntry | null, b: FolderEntry) => a !== null && a.kind === b.kind && a.path === b.path;

/**
 * "Manage specification folders": every folder the app knows — spec folders
 * and, where they can be opened (specs/app/code-repo-mode.feature.md "Open a
 * code repository"), code repositories — on one list, newest first, each
 * marked by an icon for its kind and the open one badged. A folder can be
 * opened from here, or taken off the list — the list entry only; nothing on
 * disk is deleted — and a new one picked from the file system through the
 * same prompt as the pencil beside the folder name. The open folder stays:
 * switch away from it before removing it.
 */
export function SpecFoldersDialog({
  folders,
  current,
  dirs = {},
  busy = false,
  onOpen,
  onRemove,
  onAdd,
  onAddCodeRepo,
  onClose,
  trapRef,
}: {
  /** Most recent first, the open folder included. */
  folders: FolderEntry[];
  /** The folder open now, or null. */
  current: FolderEntry | null;
  /** Where each GitHub url among the spec folders is cloned on this computer. */
  dirs?: Record<string, string>;
  /** A request is in flight: the buttons wait for it. */
  busy?: boolean;
  onOpen: (folder: FolderEntry) => void;
  onRemove: (folder: FolderEntry) => void;
  /** Pick another folder from the file system (the Data directory prompt). */
  onAdd: () => void;
  /** Pick a code repository to open; absent where none can be opened. */
  onAddCodeRepo?: () => void;
  onClose: () => void;
  trapRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div
        className="dialog spec-folders-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Folders"
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
        <h3>Folders</h3>
        <p className="hint">
          {onAddCodeRepo
            ? "The specification folders and code repositories this app has opened, most recent first. "
            : "The specification folders this app has opened, most recent first. "}
          Removing one only takes it off this list — the folder stays on disk.
        </p>
        {folders.length === 0 ? (
          <p className="modal-body">No folders yet.</p>
        ) : (
          <ul className="spec-folders" aria-label="Folders">
            {folders.map((folder) => {
              const name = repoDisplayName(folder.path);
              const isCurrent = sameEntry(current, folder);
              const clone = folder.kind === "spec" ? dirs[folder.path] : undefined;
              return (
                <li
                  key={`${folder.kind}:${folder.path}`}
                  className={`spec-folder spec-folder-${folder.kind}${isCurrent ? " current" : ""}`}
                >
                  <FolderKindIcon kind={folder.kind} />
                  <div className="spec-folder-text">
                    <span className="spec-folder-name">
                      {name}
                      {isCurrent && <span className="spec-folder-badge">open</span>}
                    </span>
                    <span className="spec-folder-path" title={folder.path}>
                      {folder.path}
                    </span>
                    {clone && (
                      <span className="spec-folder-path spec-folder-clone" title={clone}>
                        Cloned to {clone}
                      </span>
                    )}
                  </div>
                  <div className="spec-folder-actions">
                    {!isCurrent && (
                      <button
                        type="button"
                        className="link"
                        disabled={busy}
                        title={`Open ${folder.path}`}
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
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onAdd}>
            Open another folder…
          </button>
          {onAddCodeRepo && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onAddCodeRepo}>
              Open a code repository…
            </button>
          )}
          <button type="button" className="btn btn-primary" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

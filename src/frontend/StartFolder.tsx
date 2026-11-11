// The first-run screen's folder field (specs/ui/app-start.feature.md "one
// field opens a specification folder or a code repository"): one path field
// for both kinds of folder, with the folders opened before in a drop-down
// beside it. The server says which kind a path is (src/server/folderKind.ts);
// this file holds the view and the small decisions around it. App.tsx owns
// the state and the requests, so the markup can be checked on its own
// (tests/startFolder.test.tsx).

import { ChevronDown } from "lucide-react";
import { useState, type RefObject } from "react";
import { Menu, type MenuItem } from "./Menu";
import { repoDisplayName } from "./route";
import { FOLDER_KIND_LABEL, FolderKindIcon, type FolderEntry, type FolderKind } from "./SpecFolders";

/** What POST /api/folder-kind answers (src/server/folderKind.ts FolderKindResult). */
export interface FolderVerdict {
  kind: "url" | "spec" | "code" | "empty-specs" | "unknown" | "missing" | "not-a-folder";
  /** What to open: the input as typed, a leading `~` expanded. */
  open: string;
  /** The folder's absolute path. */
  path: string;
  /** The folder's own name. */
  name: string;
  buildTool?: string;
}

/** Takes the server's answer, or null when it is not one. */
export function parseFolderVerdict(value: unknown): FolderVerdict | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const kinds = ["url", "spec", "code", "empty-specs", "unknown", "missing", "not-a-folder"];
  if (typeof v.kind !== "string" || !kinds.includes(v.kind)) return null;
  if (typeof v.open !== "string" || typeof v.path !== "string" || typeof v.name !== "string") return null;
  return {
    kind: v.kind as FolderVerdict["kind"],
    open: v.open,
    path: v.path,
    name: v.name,
    ...(typeof v.buildTool === "string" ? { buildTool: v.buildTool } : {}),
  };
}

/**
 * What the screen does with a verdict:
 * - "spec": open `open` as a specification folder (a url is cloned first;
 *   a missing folder is asked about before it is made)
 * - "code": open `path` as a code repository
 * - "confirm-specs": an empty `specs-…` folder — ask whether it is a
 *   specification folder, and set it up on a yes
 * - "ask": the folder is neither — ask which kind it is
 * - "refuse": the path names something that is not a folder
 */
export type StartFolderStep = "spec" | "code" | "confirm-specs" | "ask" | "refuse";

export function startFolderStep(verdict: FolderVerdict): StartFolderStep {
  switch (verdict.kind) {
    case "url":
    case "spec":
    case "missing":
      return "spec";
    case "code":
      return "code";
    case "empty-specs":
      return "confirm-specs";
    case "unknown":
      return "ask";
    case "not-a-folder":
      return "refuse";
  }
}

/**
 * The kind a typed path was opened as before, when the folder list knows it
 * as exactly one kind — then nothing needs detecting. Null when the list
 * has no such path, or has it as both.
 */
export function recentKindOf(recent: readonly FolderEntry[], path: string): FolderKind | null {
  const kinds = new Set(recent.filter((f) => f.path === path).map((f) => f.kind));
  return kinds.size === 1 ? [...kinds][0]! : null;
}

/** A folder that is neither kind by its contents: the screen asks which. */
export interface KindQuestion {
  /** What to open as a specification folder. */
  open: string;
  /** What to open as a code repository: the absolute path. */
  path: string;
  name: string;
}

/**
 * The folder field of the first-run screen, inside the screen's form: the
 * path, the recent folders behind a ▾ on the field, Browse… where there is
 * a native chooser, and the one button that opens the folder. When a folder
 * cannot be told apart, the question — a specification folder, or a code
 * repository — takes the place of the button's hint.
 */
export function StartFolderField({
  inputRef,
  recent,
  busy,
  error,
  question,
  onPickRecent,
  onEdit,
  onBrowse,
  onAnswer,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  /** The folders opened before, newest first. */
  recent: readonly FolderEntry[];
  busy: boolean;
  error: string | null;
  question: KindQuestion | null;
  /** A recent folder was picked: the field is already filled with its path. */
  onPickRecent: (folder: FolderEntry) => void;
  /** The path was edited by hand: any question about the old one is moot. */
  onEdit: () => void;
  /** The native folder chooser, where there is one. */
  onBrowse?: () => void;
  onAnswer: (kind: FolderKind) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const items = recent.slice(0, 10).map(
    (folder): MenuItem => ({
      id: `${folder.kind}:${folder.path}`,
      label: repoDisplayName(folder.path),
      description: folder.path,
      icon: <FolderKindIcon kind={folder.kind} size={13} />,
      title: `${FOLDER_KIND_LABEL[folder.kind]} — ${folder.path}`,
      onSelect: () => {
        const input = inputRef.current;
        if (input) {
          input.value = folder.path;
          input.focus();
        }
        onPickRecent(folder);
      },
    }),
  );
  return (
    <>
      <p>Enter the path to a specification folder or a code repository:</p>
      <div className="input-row">
        <div className={`start-folder${items.length > 0 ? " has-recent" : ""}`}>
          <input
            ref={inputRef}
            name="repo"
            placeholder="/path/to/folder"
            aria-label="Folder path"
            autoFocus
            onInput={onEdit}
          />
          {items.length > 0 && (
            <>
              <button
                type="button"
                className="ibtn start-recent-toggle"
                title="Recent folders"
                aria-label="Recent folders"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={busy}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              <Menu
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                label="Recent folders"
                className="start-recent-menu"
                containerSelector=".start-folder"
                items={items}
              />
            </>
          )}
        </div>
        {onBrowse && (
          <button type="button" className="browse" onClick={onBrowse}>
            Browse…
          </button>
        )}
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? "Opening…" : "Open this folder"}
      </button>
      {question ? (
        <div className="start-kind-question" role="group" aria-label="What kind of folder this is">
          <p>
            Can't tell what <strong>{question.name}</strong> is: it has no <code>.specdriven</code> and{" "}
            <code>specs</code> folders, and no build file. Open it as:
          </p>
          <div className="start-kind-answers">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              title="Adds a .specdriven folder and a specs folder inside it"
              onClick={() => onAnswer("spec")}
            >
              <FolderKindIcon kind="spec" size={13} /> A specification folder
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onAnswer("code")}>
              <FolderKindIcon kind="code" size={13} /> A code repository
            </button>
          </div>
          <p className="hint">
            A specification folder gets a <code>.specdriven</code> and a <code>specs</code> folder added. A code
            repository is left as it is.
          </p>
        </div>
      ) : (
        <p className="hint">
          A folder with <code>.specdriven</code> and <code>specs</code> inside opens as specifications; one with
          a build file (Maven, npm, Gradle…) opens as a code repository.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}

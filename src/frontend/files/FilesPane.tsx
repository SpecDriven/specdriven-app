// The Files tab's pane (specs/app/code-repo-mode.feature.md "A file opens in
// a plain text editor", "Open the file in IntelliJ IDEA"): the file's path
// as a trail, whether it is saved, the "Open in IntelliJ" button, and the
// plain editor. Edits save on the autosave interval, at once on ⌘S, and
// when the file is left; a file changed on disk is not overwritten — the
// pane asks whether to reload it or save over it.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink } from "lucide-react";
import { Breadcrumbs, type Crumb } from "../Breadcrumbs";
import { toast } from "../Toasts";
import { Tooltip } from "../Tooltip";
import { useVimMode } from "../vimPref";
import { CodeEditor } from "./CodeEditor";
import { files, isDirty, type FilesState, type OpenFile } from "./filesStore";
import { baseName } from "./route";

/** The pane's status words for the open file. */
export function saveStatus(open: OpenFile): string {
  if (open.status === "loading") return "Opening…";
  if (open.status === "error") return "";
  if (open.conflict) return "Changed on disk";
  if (open.saving) return "Saving…";
  if (open.error) return "Not saved";
  return isDirty(open) ? "Unsaved" : "Saved";
}

/**
 * Ask the server to open a file in IntelliJ IDEA; null on success, else the
 * message for the toast (with the symlink to make when `idea` is missing).
 */
export async function openFileInIdea(path: string, line?: number): Promise<string | null> {
  try {
    const res = await fetch("/api/files/open-in-idea", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(line === undefined ? { path } : { path, line }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error : `Could not open IntelliJ (${res.status})`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** The repository's README at its top, if the listing has one. */
export function readmeOf(state: FilesState): string | null {
  const top = state.dirs[""];
  if (!top || "error" in top) return null;
  return top.entries.find((e) => e.kind === "file" && /^readme\.md$/i.test(e.name))?.path ?? null;
}

/** The trail's folders: one crumb per folder the file sits in. */
function folderCrumbs(path: string): Crumb[] {
  return path
    .split("/")
    .slice(0, -1)
    .map((name) => ({ label: name }));
}

export function FilesPane({
  path,
  repoCrumb,
  autosaveSeconds,
  canOpenInIdea,
}: {
  /** The file to show, or null for home with no README. */
  path: string | null;
  repoCrumb: Crumb;
  autosaveSeconds: number;
  /** Whether the IntelliJ button is offered (not on a shared server). */
  canOpenInIdea: boolean;
}) {
  const state = useSyncExternalStore(files.subscribe, files.getState, files.getState);
  const vim = useVimMode();
  const line = useRef(1);
  const [opening, setOpening] = useState(false);

  // The file the view names: opened (saving the one it replaces), its
  // folders opened in the tree; and saved when the view leaves it.
  const shown = useRef(path);
  shown.current = path;
  useEffect(() => {
    if (path === null) return;
    line.current = 1;
    void files.reveal(path);
    void files.open(path);
  }, [path]);
  useEffect(() => () => void files.close(shown.current ?? undefined), []);

  // Autosave (specs/editor/editor-autosave.feature.md): a tick saves what
  // changed; a file in conflict waits for the user's choice.
  useEffect(() => {
    const id = setInterval(() => void files.save(), autosaveSeconds * 1000);
    return () => clearInterval(id);
  }, [autosaveSeconds]);

  if (path === null) {
    return (
      <>
        <header className="editor-bar page-header">
          <Breadcrumbs items={[repoCrumb]} />
        </header>
        <p className="empty files-empty">Pick a file in the Files tab.</p>
      </>
    );
  }

  const open = state.open?.path === path ? state.open : null;
  const openInIdea = async () => {
    setOpening(true);
    const error = await openFileInIdea(path, open?.status === "ready" ? line.current : undefined);
    setOpening(false);
    if (error) toast.error(error);
  };
  const status = open ? saveStatus(open) : "";

  return (
    <>
      <header className="editor-bar page-header files-head">
        <Breadcrumbs
          items={[repoCrumb, ...folderCrumbs(path)]}
          tail={<span className="crumb current plain">{baseName(path)}</span>}
        />
        <div className="editor-actions page-actions">
          {status && (
            <span className={`save-indicator${open && (isDirty(open) || open.conflict || open.error) && !open.saving ? " unsaved" : ""}`}>
              {status}
            </span>
          )}
          {canOpenInIdea && (
            <Tooltip label="Open this file in IntelliJ IDEA, at the cursor's line">
              <button type="button" className="btn btn-ghost files-idea" disabled={opening} onClick={() => void openInIdea()}>
                <ExternalLink size={14} aria-hidden="true" /> Open in IntelliJ
              </button>
            </Tooltip>
          )}
        </div>
      </header>
      {open?.conflict && (
        <div className="files-notice" role="alert">
          <span>This file changed on disk since it was opened. Your edits are not saved yet.</span>
          <button type="button" className="btn btn-secondary" onClick={() => void files.reload()}>
            Reload from disk
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void files.save({ force: true })}>
            Save over it
          </button>
        </div>
      )}
      {open && !open.conflict && open.status === "ready" && open.error && (
        <div className="files-notice" role="alert">
          <span>{open.error}</span>
        </div>
      )}
      {!open || open.status === "loading" ? (
        <p className="empty files-empty">Opening…</p>
      ) : open.status === "error" ? (
        <p className="empty files-empty">
          {open.error}
          {(open.errorStatus === 413 || open.errorStatus === 415) && canOpenInIdea && " — it can still be opened in IntelliJ."}
        </p>
      ) : (
        <div className="md-editor files-editor">
          <CodeEditor
            path={path}
            value={open.content}
            vim={vim}
            onChange={(text) => files.edit(text)}
            onSave={() => void files.save()}
            onCaretLine={(n) => {
              line.current = n;
            }}
            goto={state.goto?.path === path ? state.goto : null}
            onWentTo={(seq) => files.wentTo(seq)}
          />
        </div>
      )}
    </>
  );
}

import { useRef, useState } from "react";
import { Download, Pencil, RefreshCw, Upload, X } from "lucide-react";
import type { ScenarioFile } from "../server/parser";
import { fileDisplayName, formatFileSize } from "../server/scenarioFileList";

/** Where a stored file downloads from, under the name the scenario lists it by. */
export function scenarioFileUrl(f: ScenarioFile): string {
  return `/api/scenario-files/${encodeURIComponent(f.file)}?name=${encodeURIComponent(f.name)}`;
}

/**
 * Why a file can't be renamed to `draft`, or null when it can: the name
 * must be usable and not another listed file's.
 */
export function renameError(files: ScenarioFile[], from: string, draft: string): string | null {
  const name = fileDisplayName(draft);
  if (name === null) return "The file needs a name.";
  if (name !== from && files.some((f) => f.name === name)) return `"${name}" is already listed.`;
  return null;
}

/** The list of files on a scenario card: each a download link with its size. */
export function ScenarioFileList({ files }: { files: ScenarioFile[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="pr-list file-list">
      {files.map((f) => (
        <li key={f.name}>
          <a href={scenarioFileUrl(f)} download={f.name} title={`Download ${f.name}`} data-file-link="">
            {f.name}
          </a>
          <span className="file-size">{formatFileSize(f.size)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The "Files" field of the scenario editor pane
 * (specs/editor/store-associated-files.feature.md "CRUD on files for each
 * scenario"): the scenario's files, each downloadable, renamable,
 * replaceable with new contents and removable, and an Upload button that
 * opens the system's file picker for more. Every change goes straight to
 * the parent — `onUpload` for new bytes, `onChange` for the list — which
 * saves it to the document; there is nothing to autosave.
 */
export function ScenarioFilesField({
  files,
  onUpload,
  onChange,
  disabled = false,
  disabledHint,
}: {
  files: ScenarioFile[];
  /** New files chosen; `replacing` names the listed file they replace. */
  onUpload: (chosen: File[], replacing?: string) => void | Promise<void>;
  onChange: (next: ScenarioFile[]) => void | Promise<void>;
  /** The scenario is not in the document yet — nothing to attach to. */
  disabled?: boolean;
  disabledHint?: string;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const replacer = useRef<HTMLInputElement>(null);
  /** The listed file whose contents the replace picker is choosing. */
  const [replacing, setReplacing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (chosen: File[], replace?: string) => {
    if (chosen.length === 0) return;
    setBusy(true);
    try {
      await onUpload(chosen, replace);
    } finally {
      setBusy(false);
    }
  };

  const commitRename = () => {
    if (renaming === null) return;
    const problem = renameError(files, renaming, draft);
    if (problem) {
      setError(problem);
      return;
    }
    const name = fileDisplayName(draft)!;
    if (name !== renaming) {
      void onChange(files.map((f) => (f.name === renaming ? { ...f, name } : f)));
    }
    setRenaming(null);
    setError(null);
  };

  const off = disabled || busy;

  return (
    <div className="prs-field files-field">
      {files.length > 0 && (
        <ul className="pr-list pr-edit-list file-list">
          {files.map((f) =>
            renaming === f.name ? (
              <li key={f.name}>
                <form
                  className="pr-add file-rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitRename();
                  }}
                >
                  <input
                    value={draft}
                    aria-label={`New name for ${f.name}`}
                    spellCheck={false}
                    autoFocus
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setRenaming(null);
                        setError(null);
                      }
                    }}
                  />
                  <button type="submit" className="link">
                    Rename
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setRenaming(null);
                      setError(null);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              </li>
            ) : (
              <li key={f.name}>
                <a href={scenarioFileUrl(f)} download={f.name} title={`Download ${f.name}`} data-file-link="">
                  {f.name}
                </a>
                <span className="file-size">{formatFileSize(f.size)}</span>
                <span className="file-actions">
                  <a
                    className="link"
                    href={scenarioFileUrl(f)}
                    download={f.name}
                    title={`Download ${f.name}`}
                    aria-label={`Download ${f.name}`}
                  >
                    <Download size={12} aria-hidden="true" />
                  </a>
                  <button
                    type="button"
                    className="link"
                    title={`Rename ${f.name}`}
                    aria-label={`Rename ${f.name}`}
                    disabled={off}
                    onClick={() => {
                      setRenaming(f.name);
                      setDraft(f.name);
                      setError(null);
                    }}
                  >
                    <Pencil size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="link"
                    title={`Replace the contents of ${f.name}`}
                    aria-label={`Replace ${f.name}`}
                    disabled={off}
                    onClick={() => {
                      setReplacing(f.name);
                      replacer.current?.click();
                    }}
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="link"
                    title={`Remove ${f.name}`}
                    aria-label={`Remove ${f.name}`}
                    disabled={off}
                    onClick={() => void onChange(files.filter((g) => g.name !== f.name))}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
      <div className="pr-add">
        <button
          type="button"
          className="link file-upload"
          disabled={off}
          onClick={() => picker.current?.click()}
        >
          <Upload size={12} aria-hidden="true" /> {busy ? "Uploading…" : "Upload files"}
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="Files to upload"
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            e.target.value = "";
            void upload(chosen);
          }}
        />
        <input
          ref={replacer}
          type="file"
          hidden
          aria-label="Replacement file"
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            e.target.value = "";
            const target = replacing;
            setReplacing(null);
            if (target !== null) void upload(chosen.slice(0, 1), target);
          }}
        />
      </div>
      {error && <p className="error">{error}</p>}
      {disabled && disabledHint && <p className="pr-hint">{disabledHint}</p>}
    </div>
  );
}

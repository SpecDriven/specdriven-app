import { useEffect, useState, type Ref } from "react";
import { backdropDismiss } from "./backdropDismiss";

// "Import from OpenSpec…" beside "New feature" (specs/external-links/
// openspec-import.feature.md): the code repository to read — one of the
// project's code repos, or another folder typed in — the capabilities its
// openspec/specs folder holds, ticked to import, and Import. Each becomes a
// feature in the folder the dialog was opened for; one already imported is
// shown and left alone. openspec/changes is never read.

/** One code repo the project's settings name. */
export interface OpenSpecRepo {
  path: string;
  dir: string;
  isDefault: boolean;
}

/** One capability's spec, as GET /api/openspec/specs lists it. */
export interface OpenSpecSpec {
  capability: string;
  path: string;
  /** The feature's name. */
  name: string;
  /** Where it lands in the data repo. */
  fileName: string;
  /** Whether that file is already there — imported before. */
  exists: boolean;
  requirements: number;
  scenarios: number;
  /** Why the spec cannot be read. */
  error?: string;
}

export interface OpenSpecListing {
  repos: OpenSpecRepo[];
  repo: string | null;
  specs: OpenSpecSpec[];
  problem?: string;
}

/** What the import route answers. */
export interface OpenSpecImportResult {
  created: { capability: string; fileName: string; title: string; scenarios: number }[];
  skipped: { capability: string; fileName: string }[];
  failed: { capability: string; error: string }[];
}

const OTHER = "__other__";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The one line the toast (or the dialog, when nothing was written) says about an import. */
export function importSummary(result: OpenSpecImportResult): string {
  const parts: string[] = [];
  if (result.created.length) {
    const scenarios = result.created.reduce((n, c) => n + c.scenarios, 0);
    parts.push(
      result.created.length === 1
        ? `Imported “${result.created[0]!.title}” with ${plural(scenarios, "scenario")}`
        : `Imported ${plural(result.created.length, "feature")} with ${plural(scenarios, "scenario")}`,
    );
  }
  if (result.skipped.length) parts.push(`${plural(result.skipped.length, "spec")} already imported`);
  if (result.failed.length) {
    parts.push(
      `${result.failed.length} not imported: ${result.failed.map((f) => `${f.capability} (${f.error})`).join("; ")}`,
    );
  }
  return parts.join(" · ") || "Nothing imported";
}

/** The capabilities ticked when a listing arrives: every one not imported yet and readable. */
export function initialSelection(specs: OpenSpecSpec[]): Set<string> {
  return new Set(specs.filter((s) => !s.exists && !s.error).map((s) => s.capability));
}

/** The checklist of capabilities: presentational, so it renders without a server. */
export function OpenSpecSpecList({
  specs,
  selected,
  onToggle,
}: {
  specs: OpenSpecSpec[];
  selected: Set<string>;
  onToggle: (capability: string) => void;
}) {
  return (
    <ul className="import-scenarios" aria-label="OpenSpec specs">
      {specs.map((s) => {
        const blocked = s.exists || Boolean(s.error);
        const note = s.error
          ? s.error
          : s.exists
            ? `already imported as ${s.fileName}`
            : `${plural(s.requirements, "requirement")}, ${plural(s.scenarios, "scenario")}`;
        return (
          <li key={s.capability} className={blocked ? "dropped" : ""}>
            <label className="import-scenario-row">
              <input
                type="checkbox"
                aria-label={`Import ${s.capability}`}
                checked={!blocked && selected.has(s.capability)}
                disabled={blocked}
                onChange={() => onToggle(s.capability)}
              />
              <span className="import-scenario-name">{s.name}</span>
              <span className="import-kind" title={s.path}>
                {s.capability}
              </span>
            </label>
            <p className={s.error ? "error openspec-note" : "hint openspec-note"}>{note}</p>
          </li>
        );
      })}
    </ul>
  );
}

export function OpenSpecImportDialog({
  folder,
  trapRef,
  onImported,
  onClose,
}: {
  /** The folder the features land in, or null for the top level. */
  folder: string | null;
  trapRef?: Ref<HTMLDivElement>;
  onImported: (result: OpenSpecImportResult) => void;
  onClose: () => void;
}) {
  /** The repo asked for: "" for the default, a code repo's dir, or a typed folder. */
  const [repo, setRepo] = useState("");
  const [other, setOther] = useState(false);
  const [typed, setTyped] = useState("");
  const [listing, setListing] = useState<OpenSpecListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (repo) params.set("repo", repo);
    if (folder) params.set("folder", folder);
    void fetch(`/api/openspec/specs?${params}`)
      .then(async (res) => {
        const data = (await res.json()) as OpenSpecListing & { error?: string };
        if (!live) return;
        if (!res.ok) {
          setListing(null);
          setError(data.error ?? `Reading the specs failed (HTTP ${res.status})`);
          return;
        }
        setListing(data);
        setSelected(initialSelection(data.specs));
      })
      .catch(() => {
        if (live) setError("Could not reach the server — is it running?");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [repo, folder]);

  const toggle = (capability: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(capability)) next.delete(capability);
      else next.add(capability);
      return next;
    });

  const specs = listing?.specs ?? [];
  const importable = specs.filter((s) => !s.exists && !s.error);
  const chosen = importable.filter((s) => selected.has(s.capability));
  const repos = listing?.repos ?? [];
  const shownRepo = other ? OTHER : (repos.find((r) => r.dir === (repo || listing?.repo))?.dir ?? (repo ? OTHER : ""));

  const importNow = async () => {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/openspec/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: listing?.repo ?? repo, folder, capabilities: chosen.map((s) => s.capability) }),
      });
      const data = (await res.json()) as OpenSpecImportResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Importing failed (HTTP ${res.status})`);
        return;
      }
      if (data.created.length === 0) {
        setError(importSummary(data));
        return;
      }
      onImported(data);
    } catch {
      setError("Could not reach the server — is it running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div
        className="dialog modal-dialog confluence-dialog import-dialog openspec-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import from OpenSpec"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          className="modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void importNow();
          }}
        >
          <h3>Import from OpenSpec</h3>
          <p>
            Each capability in the repository’s <code>openspec/specs</code> becomes a new feature{" "}
            {folder ? (
              <>
                in <strong>{folder}</strong>
              </>
            ) : (
              "at the top level"
            )}
            , its scenarios proposed. Changes in <code>openspec/changes</code> are not imported.
          </p>
          <label>
            Read from
            <select
              aria-label="Repository"
              value={shownRepo}
              onChange={(e) => {
                if (e.target.value === OTHER) {
                  setOther(true);
                  return;
                }
                setOther(false);
                setRepo(e.target.value);
              }}
            >
              {repos.length === 0 && !other && <option value="">No code repository in Project settings</option>}
              {repos.map((r) => (
                <option key={r.dir} value={r.dir}>
                  {r.path}
                  {r.isDefault && repos.length > 1 ? " (default)" : ""}
                </option>
              ))}
              <option value={OTHER}>Another folder…</option>
            </select>
          </label>
          {shownRepo === OTHER && (
            <div className="import-add">
              <input
                aria-label="Folder to read"
                placeholder="/path/to/code-repo"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (typed.trim()) setRepo(typed.trim());
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!typed.trim()}
                onClick={() => setRepo(typed.trim())}
              >
                Look
              </button>
            </div>
          )}
          {loading ? (
            <p className="hint">Looking for specs…</p>
          ) : listing?.problem ? (
            <p className="hint">{listing.problem}</p>
          ) : (
            specs.length > 0 && (
              <>
                <OpenSpecSpecList specs={specs} selected={selected} onToggle={toggle} />
                <p className="hint">
                  {importable.length === 0
                    ? "Every spec here is imported already."
                    : `${chosen.length} of ${importable.length} selected`}
                </p>
              </>
            )
          )}
          {error && <p className="error">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || loading || chosen.length === 0}>
              {busy ? "Importing…" : chosen.length > 1 ? `Import ${chosen.length}` : "Import"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

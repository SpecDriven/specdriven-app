// "View settings file…" from the User info dialog
// (specs/app/user-info-settings.feature.md "view the settings file"): the
// user's ~/.specdriven/settings.json, read-only, as labelled sections
// (src/frontend/settingsFileView.ts) rather than JSON. App.tsx fetches
// GET /api/settings-file and owns the open state.

import { useState, type Ref } from "react";
import { backdropDismiss } from "./backdropDismiss";
import { settingsFileSections, settingsFileText, tildePath, type SettingsRow, type SettingsValue } from "./settingsFileView";

/** What GET /api/settings-file answers (src/server/state.ts SettingsFileView). */
export interface SettingsFile {
  path: string;
  home: string;
  exists: boolean;
  settings: Record<string, unknown>;
  activePath?: string;
  error?: string;
}

function Value({ value }: { value: SettingsValue }) {
  if (value.kind === "text") return <span className={value.muted ? "unset" : undefined}>{value.text}</span>;
  if (value.kind === "list") {
    return (
      <ul className="settings-file-list">
        {value.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
  }
  return <Rows rows={value.rows} nested />;
}

function Rows({ rows, nested = false }: { rows: SettingsRow[]; nested?: boolean }) {
  return (
    <dl className={nested ? "settings-file settings-file-nested" : "settings-file"}>
      {rows.map((row) => (
        <div className={row.value.kind === "rows" ? "settings-file-row has-rows" : "settings-file-row"} key={row.key}>
          <dt>
            {row.label}
            {row.deprecated && <span className="settings-file-tag">no longer used</span>}
          </dt>
          <dd>
            <Value value={row.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SettingsFileDialog({
  file,
  loadError,
  trapRef,
  onClose,
}: {
  /** null while loading. */
  file: SettingsFile | null;
  loadError?: string | null;
  trapRef?: Ref<HTMLDivElement>;
  onClose: () => void;
}) {
  // Which copy just landed, for a moment: the path or the whole view.
  const [copied, setCopied] = useState<"path" | "contents" | null>(null);
  const sections = file && file.exists && !file.error ? settingsFileSections(file.settings, file.home) : [];
  const shownPath = file ? tildePath(file.path, file.home) : "~/.specdriven/settings.json";
  const copy = async (what: "path" | "contents") => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(what === "path" ? file.path : settingsFileText(shownPath, sections));
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // No clipboard access: everything stays on screen to select by hand.
    }
  };
  return (
    <div className="dialog-backdrop" {...backdropDismiss(onClose)}>
      <div
        className="dialog settings-file-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings file"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Settings file</h3>
        <div className="settings-file-path">
          <code>{shownPath}</code>
          {file && (
            <button type="button" className="btn btn-ghost" onClick={() => copy("path")}>
              {copied === "path" ? "Copied" : "Copy path"}
            </button>
          )}
        </div>
        {file?.activePath && (
          <p className="hint">The app is currently reading {tildePath(file.activePath, file.home)} instead.</p>
        )}
        {loadError ? (
          <p className="error">Could not read the settings file: {loadError}</p>
        ) : !file ? (
          <p className="hint">Loading…</p>
        ) : !file.exists ? (
          <p className="hint">No settings file yet — the app writes one the first time a setting changes.</p>
        ) : file.error ? (
          <p className="error">{file.error}</p>
        ) : sections.length === 0 ? (
          <p className="hint">The file holds no settings.</p>
        ) : (
          <div className="settings-file-sections">
            {sections.map((section) => (
              <section className="settings-file-section" key={section.title} aria-label={section.title}>
                <h4>{section.title}</h4>
                <Rows rows={section.rows} />
              </section>
            ))}
          </div>
        )}
        {file?.exists && !file.error && (
          <p className="hint">Settings not in the file use their defaults. Change them on the Settings page.</p>
        )}
        <div className="dialog-actions">
          {sections.length > 0 && (
            <button type="button" className="btn btn-secondary" onClick={() => copy("contents")}>
              {copied === "contents" ? "Copied" : "Copy contents"}
            </button>
          )}
          <button autoFocus type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

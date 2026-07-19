import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { parseFeature, serializeFeature } from "../server/parser";
import type { Feature, Scenario } from "../server/parser";
import { MarkdownEditor } from "./MarkdownEditor";
import { renderMarkdown } from "./markdown";

interface Conflict {
  ours: string;
  theirs: string;
  message: string;
}

/** index === null means a new scenario being added. */
interface EditState {
  index: number | null;
  scenario: Scenario;
}

export function App() {
  const [dataRepo, setDataRepo] = useState<string | null>(null);
  const [needsRepo, setNeedsRepo] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [settingRepo, setSettingRepo] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [feature, setFeature] = useState<Feature | null>(null);
  const [selectedScenario, setSelectedScenario] = useState<number | null>(null);
  const scenarioRefs = useRef<(HTMLElement | null)[]>([]);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [conflictDraft, setConflictDraft] = useState("");
  const [status, setStatus] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reloadSeconds, setReloadSeconds] = useState(60);
  const [previewLines, setPreviewLines] = useState(8);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState("60");
  const [settingsLinesDraft, setSettingsLinesDraft] = useState("8");
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const loadFeatures = useCallback(async () => {
    const res = await fetch("/api/features");
    const data = await res.json();
    if (res.ok) {
      setFeatures(data.features);
      setLoadError(null);
    } else {
      setLoadError(data.error ?? "Could not load features");
    }
  }, []);

  useEffect(() => {
    (async () => {
      const state = await (await fetch("/api/state")).json();
      setDataRepo(state.dataRepo);
      setNeedsRepo(state.needsDataRepo);
      if (typeof state.reloadFrequencySeconds === "number") {
        setReloadSeconds(state.reloadFrequencySeconds);
      }
      if (typeof state.scenarioPreviewLines === "number") {
        setPreviewLines(state.scenarioPreviewLines);
      }
      if (!state.needsDataRepo) await loadFeatures();
      setLoading(false);
    })();
  }, [loadFeatures]);

  // Mirror the server's cron reload (specs/crud-feature.spec.md): refresh the
  // feature list on the same cadence so pulled changes show up, without
  // clobbering an in-progress edit or conflict resolution.
  useEffect(() => {
    if (loading || needsRepo || reloadSeconds <= 0) return;
    const id = setInterval(() => {
      void loadFeatures();
      if (selected && !dirty && !editing && !conflict) void openFeature(selected);
    }, reloadSeconds * 1000);
    return () => clearInterval(id);
  }, [loading, needsRepo, reloadSeconds, selected, dirty, editing, conflict, loadFeatures]);

  // specs/ui.spec.md "Select scenarios via up and down keys": arrow keys move a
  // highlight through the scenario cards, Enter opens the highlighted one in
  // the dialog. Inert while a dialog is open or while typing in a field.
  useEffect(() => {
    if (!feature || feature.scenarios.length === 0 || editing || settingsOpen) return;
    const count = feature.scenarios.length;
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      )
        return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        // Steal focus from a clicked button (e.g. the feature just opened in
        // the sidebar) so a following Enter edits the highlighted scenario
        // instead of re-activating that button.
        if (t instanceof HTMLElement) t.blur();
        setSelectedScenario((i) => {
          if (e.key === "ArrowDown") return i === null ? 0 : Math.min(i + 1, count - 1);
          return i === null ? count - 1 : Math.max(i - 1, 0);
        });
      } else if (e.key === "Enter" && selectedScenario !== null) {
        // A focused button keeps its native Enter activation.
        if (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement) return;
        const s = feature.scenarios[selectedScenario];
        if (s) setEditing({ index: selectedScenario, scenario: { ...s } });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [feature, editing, settingsOpen, selectedScenario]);

  // specs/ui.spec.md "Scenario edit dialog": ESC returns to the scenario
  // screen — same as Cancel/Close, and it works while a dialog field has focus.
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setEditing(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  useEffect(() => {
    if (selectedScenario !== null)
      scenarioRefs.current[selectedScenario]?.scrollIntoView({ block: "nearest" });
  }, [selectedScenario]);

  const saveRepo = async (repo: string) => {
    setSettingRepo(true);
    setRepoError(null);
    try {
      const res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataRepo: repo }),
      });
      const state = await res.json();
      if (res.ok) {
        setDataRepo(state.dataRepo);
        setNeedsRepo(false);
        await loadFeatures();
      } else {
        setRepoError(state.error ?? "Could not use this repo");
      }
    } finally {
      setSettingRepo(false);
    }
  };

  const openFeature = async (file: string) => {
    const res = await fetch(`/api/features/${encodeURIComponent(file)}`);
    if (res.ok) {
      const data = await res.json();
      const parsed = parseFeature(data.content);
      setSelected(file);
      setFeature(parsed);
      // Keep the keyboard highlight across a same-file refresh (sync, cron);
      // drop it when switching files or when the list shrank past it.
      setSelectedScenario((prev) =>
        file === selected && prev !== null && prev < parsed.scenarios.length ? prev : null,
      );
      setDirty(false);
      setEditing(null);
      setConflict(null);
      setStatus("");
    } else {
      // The file is gone — deleted, or renamed by the `.feature.md` migration.
      // Drop a stale selection rather than re-fetching it on every reload tick.
      if (file === selected) {
        setSelected(null);
        setFeature(null);
        setSelectedScenario(null);
        setStatus("");
      }
      await loadFeatures();
    }
  };

  const createFeature = async () => {
    const name = window.prompt("Feature name:");
    if (!name) return;
    const res = await fetch("/api/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (res.ok) {
      await loadFeatures();
      await openFeature(data.fileName);
    } else {
      setStatus(data.error);
    }
  };

  // Publish button (specs/ui.spec.md "Main page"): same style and behavior as
  // Sync — disabled with a progress label while running, no "Published" status
  // line at the bottom of the page.
  const publish = async () => {
    if (!selected || !feature) return;
    setPublishing(true);
    try {
      const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: serializeFeature(feature) }),
      });
      const data = await res.json();
      if (res.status === 409 && data.status === "conflict") {
        setConflict({ ours: data.ours, theirs: data.theirs, message: data.message });
        setConflictDraft(data.ours);
        setStatus("Merge conflict — choose a resolution below.");
      } else if (res.ok) {
        await openFeature(selected);
      } else {
        setStatus(data.error ?? "Publish failed");
      }
    } catch {
      setStatus("Publish failed — is the server running?");
    } finally {
      setPublishing(false);
    }
  };

  // Sync button (specs/ui.spec.md "Main page"): immediate data reload — the
  // server runs one reload tick (pull + push saved), then the view refreshes.
  // Like the cron mirror above, an in-progress edit or conflict is not clobbered.
  // Progress shows only on the button — no status line at the bottom of the page.
  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/reload", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.error ?? "Sync failed");
        return;
      }
      await loadFeatures();
      if (selected && !dirty && !editing && !conflict) await openFeature(selected);
    } catch {
      setStatus("Sync failed — is the server running?");
    } finally {
      setSyncing(false);
    }
  };

  const resolveWith = async (resolved: string) => {
    if (!selected) return;
    setStatus("Publishing resolution…");
    const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: resolved, resolveConflict: true }),
    });
    const data = await res.json();
    if (res.ok) {
      await openFeature(selected);
    } else {
      setStatus(data.error ?? "Publish failed");
    }
  };

  // specs/crud-feature.spec.md ("Scenario is automatically saved locally and
  // pushed to GitHub"): show 'Saved' on the top banner for 2 sec.
  const flashSaved = () => {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 2000);
  };

  /**
   * Saving the dialog auto-saves the whole feature locally (marked [saved],
   * so no data is lost); the server's reload cron commits and pushes it.
   */
  const saveScenario = async () => {
    if (!editing || !feature || !selected) return;
    const s = editing.scenario;
    const next: Feature = {
      ...feature,
      scenarios:
        editing.index === null
          ? [...feature.scenarios, s]
          : feature.scenarios.map((sc, i) => (i === editing.index ? s : sc)),
    };
    setFeature(next);
    setEditing(null);
    const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: serializeFeature(next), save: true }),
    });
    const data = await res.json();
    if (res.ok) {
      setFeature(parseFeature(data.content));
      setDirty(false);
      setStatus("Saved — press Publish to mark scenarios published.");
      flashSaved();
    } else {
      setDirty(true);
      setStatus(data.error ?? "Save failed");
    }
  };

  const openSettings = () => {
    setSettingsDraft(String(reloadSeconds));
    setSettingsLinesDraft(String(previewLines));
    setSettingsError(null);
    setSettingsOpen(true);
  };

  // Settings are saved to .specdriven (specs/ui.spec.md).
  const saveSettings = async () => {
    const n = Number(settingsDraft);
    if (!Number.isFinite(n) || n < 0) {
      setSettingsError("Enter a number of seconds (0 disables automatic reload).");
      return;
    }
    const lines = Number(settingsLinesDraft);
    if (!Number.isFinite(lines) || lines < 1) {
      setSettingsError("Enter how many preview lines to show per scenario (at least 1).");
      return;
    }
    const res = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reloadFrequencySeconds: Math.floor(n),
        scenarioPreviewLines: Math.floor(lines),
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setReloadSeconds(data.reloadFrequencySeconds);
      setPreviewLines(data.scenarioPreviewLines);
      setSettingsOpen(false);
    } else {
      setSettingsError(data.error ?? "Could not save settings");
    }
  };

  /** Draft the next version of a published scenario as a new, editable scenario. */
  const newVersion = (i: number) => {
    if (!feature) return;
    const src = feature.scenarios[i]!;
    const maxVersion = Math.max(
      ...feature.scenarios.filter((s) => s.name === src.name).map((s) => s.version),
    );
    setEditing({
      index: null,
      scenario: { ...src, version: maxVersion + 1, published: false, saved: false },
    });
  };

  if (loading) return <main className="centered">Loading…</main>;

  if (needsRepo) {
    return (
      <main className="centered">
        <form
          className="repo-prompt"
          onSubmit={(e) => {
            e.preventDefault();
            const input = new FormData(e.currentTarget).get("repo") as string;
            if (input.trim()) saveRepo(input.trim());
          }}
        >
          <h1>SpecDriven</h1>
          <p>No data repo configured yet. Enter the GitHub url of the data repo (or a local path):</p>
          <input name="repo" placeholder="https://github.com/SpecDriven/data-insurance" autoFocus />
          <button type="submit" disabled={settingRepo}>
            {settingRepo ? "Checking access…" : "Use this repo"}
          </button>
          {repoError && <p className="error">{repoError}</p>}
        </form>
      </main>
    );
  }

  const editingPublished = editing?.scenario.published ?? false;
  const hasSaved = feature?.scenarios.some((s) => s.saved && !s.published) ?? false;

  return (
    <main className="layout">
      {savedFlash && <div className="saved-banner">Saved</div>}
      <aside>
        <header>
          <h1>SpecDriven</h1>
          <span className="repo-name">{dataRepo}</span>
        </header>
        <button onClick={createFeature}>+ New feature</button>
        {loadError && <p className="error">{loadError}</p>}
        <ul>
          {features.map((f) => (
            <li key={f}>
              <button className={f === selected ? "active" : ""} onClick={() => openFeature(f)}>
                {f}
              </button>
            </li>
          ))}
          {features.length === 0 && <li className="empty">No feature files yet</li>}
        </ul>
        <button className="settings-btn" onClick={openSettings}>
          ⚙ Settings
        </button>
      </aside>
      <section className="editor">
        {selected && feature ? (
          <>
            <div className="editor-bar">
              <h2>{selected}</h2>
              <div className="editor-actions">
                <button className="secondary" onClick={syncNow} disabled={syncing}>
                  {syncing ? "Syncing…" : "Sync"}
                </button>
                <button className="secondary" onClick={publish} disabled={publishing}>
                  {publishing ? "Publishing…" : dirty || hasSaved ? "Publish *" : "Publish"}
                </button>
              </div>
            </div>
            <h3 className="feature-name">Feature: {feature.name}</h3>
            {feature.description && <pre className="feature-desc">{feature.description}</pre>}
            {/* specs/ui.spec.md "Scenario List": each card renders its body as
                a Markdown preview, clamped to n lines (n set in Settings). */}
            <div
              className="scenarios"
              style={{ "--preview-lines": previewLines } as CSSProperties}
            >
              {feature.scenarios.map((s, i) => (
                <article
                  key={i}
                  ref={(el) => {
                    scenarioRefs.current[i] = el;
                  }}
                  className={`scenario-card${s.published ? " published" : ""}${
                    i === selectedScenario ? " selected" : ""
                  }`}
                >
                  <header>
                    <span className="scenario-title">
                      {s.name} <span className="version">v{s.version}</span>
                      {s.published && <span className="badge">published</span>}
                      {!s.published && s.saved && <span className="badge saved">saved</span>}
                    </span>
                    <span className="card-actions">
                      {s.published && (
                        <button className="link" onClick={() => newVersion(i)}>
                          New version
                        </button>
                      )}
                      <button
                        className="link"
                        onClick={() => setEditing({ index: i, scenario: { ...s } })}
                      >
                        {s.published ? "View" : "Edit"}
                      </button>
                    </span>
                  </header>
                  {s.body && (
                    <div className="md-preview scenario-body">{renderMarkdown(s.body)}</div>
                  )}
                </article>
              ))}
              {feature.scenarios.length === 0 && <p className="empty">No scenarios yet.</p>}
            </div>
            <div>
              <button
                className="add-scenario"
                onClick={() =>
                  setEditing({
                    index: null,
                    scenario: { name: "", version: 1, published: false, saved: false, body: "" },
                  })
                }
              >
                + Add scenario
              </button>
            </div>
            {status && <p className="status">{status}</p>}
            {conflict && (
              <div className="conflict">
                <h3>Merge conflict</h3>
                <div className="conflict-panes">
                  <div>
                    <h4>Yours</h4>
                    <pre>{conflict.ours}</pre>
                  </div>
                  <div>
                    <h4>Theirs</h4>
                    <pre>{conflict.theirs}</pre>
                  </div>
                </div>
                <textarea
                  className="conflict-draft"
                  value={conflictDraft}
                  onChange={(e) => setConflictDraft(e.target.value)}
                  spellCheck={false}
                />
                <div className="conflict-actions">
                  <button onClick={() => resolveWith(conflict.ours)}>Accept yours</button>
                  <button onClick={() => resolveWith(conflict.theirs)}>Accept theirs</button>
                  <button onClick={() => resolveWith(conflictDraft)}>Publish manual edit</button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="empty">Select a feature file or create a new one.</p>
        )}
      </section>
      {settingsOpen && (
        <div className="dialog-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Settings</h3>
            <label>
              Data reload frequency (seconds)
              <input
                type="number"
                min={0}
                autoFocus
                value={settingsDraft}
                onChange={(e) => setSettingsDraft(e.target.value)}
              />
            </label>
            <p className="hint">
              The data repo is git-pulled automatically at this interval. Use 0 to disable
              automatic reload.
            </p>
            <label>
              Scenario preview lines
              <input
                type="number"
                min={1}
                value={settingsLinesDraft}
                onChange={(e) => setSettingsLinesDraft(e.target.value)}
              />
            </label>
            <p className="hint">
              How many lines of the rendered Markdown body each scenario shows in the list.
              Settings are saved to .specdriven.
            </p>
            {settingsError && <p className="error">{settingsError}</p>}
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
              <button onClick={saveSettings}>Save settings</button>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <div className="dialog-backdrop" onClick={() => setEditing(null)}>
          {/* specs/ui.spec.md "Scenario edit dialog": the scenario name is the
              dialog title (an editable title unless published), the dialog is
              resizable, and the body is an embedded markdown editor. */}
          <div className="dialog scenario-dialog" onClick={(e) => e.stopPropagation()}>
            {editingPublished ? (
              <h3 className="dialog-title">
                {editing.scenario.name} <span className="version">v{editing.scenario.version}</span>
                <span className="badge">published</span>
              </h3>
            ) : (
              <input
                className="dialog-title-input"
                value={editing.scenario.name}
                placeholder="Scenario name"
                aria-label="Scenario name"
                autoFocus
                onChange={(e) =>
                  setEditing({ ...editing, scenario: { ...editing.scenario, name: e.target.value } })
                }
              />
            )}
            {!editingPublished && (
              <label className="version-field">
                Version
                <input
                  type="number"
                  min={1}
                  value={editing.scenario.version}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      scenario: { ...editing.scenario, version: Math.max(1, Number(e.target.value) || 1) },
                    })
                  }
                />
              </label>
            )}
            <div className="body-field">
              <span className="field-label">Body</span>
              <MarkdownEditor
                value={editing.scenario.body}
                readOnly={editingPublished}
                placeholder="Describe the scenario in Markdown…"
                onChange={(body) =>
                  setEditing({ ...editing, scenario: { ...editing.scenario, body } })
                }
              />
            </div>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setEditing(null)}>
                {editingPublished ? "Close" : "Cancel"}
              </button>
              {!editingPublished && (
                <button onClick={saveScenario} disabled={!editing.scenario.name.trim()}>
                  Save scenario
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

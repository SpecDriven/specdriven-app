import { useCallback, useEffect, useState } from "react";
import { parseFeature, serializeFeature } from "../server/parser";
import type { Feature, Scenario } from "../server/parser";

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
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [conflictDraft, setConflictDraft] = useState("");
  const [status, setStatus] = useState("");

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
      if (!state.needsDataRepo) await loadFeatures();
      setLoading(false);
    })();
  }, [loadFeatures]);

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
      setSelected(file);
      setFeature(parseFeature(data.content));
      setDirty(false);
      setEditing(null);
      setConflict(null);
      setStatus("");
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

  const publish = async () => {
    if (!selected || !feature) return;
    setStatus("Publishing…");
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
      setStatus(`Published. ${data.message}`);
    } else {
      setStatus(data.error ?? "Publish failed");
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
      setStatus(`Published. ${data.message}`);
    } else {
      setStatus(data.error ?? "Publish failed");
    }
  };

  const saveScenario = () => {
    if (!editing || !feature) return;
    const s = editing.scenario;
    setFeature({
      ...feature,
      scenarios:
        editing.index === null
          ? [...feature.scenarios, s]
          : feature.scenarios.map((sc, i) => (i === editing.index ? s : sc)),
    });
    setDirty(true);
    setEditing(null);
    setStatus("Unpublished changes — press Publish to commit and push.");
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
      scenario: { ...src, version: maxVersion + 1, published: false },
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

  return (
    <main className="layout">
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
      </aside>
      <section className="editor">
        {selected && feature ? (
          <>
            <div className="editor-bar">
              <h2>{selected}</h2>
              <button onClick={publish}>{dirty ? "Publish *" : "Publish"}</button>
            </div>
            <h3 className="feature-name">Feature: {feature.name}</h3>
            <div className="scenarios">
              {feature.scenarios.map((s, i) => (
                <article key={i} className={`scenario-card${s.published ? " published" : ""}`}>
                  <header>
                    <span className="scenario-title">
                      {s.name} <span className="version">@v{s.version}</span>
                      {s.published && <span className="badge">published</span>}
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
                  {s.body && <pre className="scenario-body">{s.body}</pre>}
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
                    scenario: { name: "", version: 1, published: false, body: "" },
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
      {editing && (
        <div className="dialog-backdrop" onClick={() => setEditing(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>
              {editing.index === null
                ? "New scenario"
                : editingPublished
                  ? "Published scenario (immutable)"
                  : "Edit scenario"}
            </h3>
            <label>
              Name
              <input
                value={editing.scenario.name}
                disabled={editingPublished}
                autoFocus={!editingPublished}
                onChange={(e) =>
                  setEditing({ ...editing, scenario: { ...editing.scenario, name: e.target.value } })
                }
              />
            </label>
            <label>
              Version
              <input
                type="number"
                min={1}
                value={editing.scenario.version}
                disabled={editingPublished}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    scenario: { ...editing.scenario, version: Math.max(1, Number(e.target.value) || 1) },
                  })
                }
              />
            </label>
            <label>
              Body
              <textarea
                value={editing.scenario.body}
                disabled={editingPublished}
                spellCheck={false}
                onChange={(e) =>
                  setEditing({ ...editing, scenario: { ...editing.scenario, body: e.target.value } })
                }
              />
            </label>
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

import { useCallback, useEffect, useState } from "react";

interface Conflict {
  ours: string;
  theirs: string;
  message: string;
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
  const [content, setContent] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [mergePending, setMergePending] = useState(false);
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
      setContent(data.content);
      setConflict(null);
      setMergePending(false);
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

  const save = async () => {
    if (!selected) return;
    setStatus("Saving…");
    const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, resolveConflict: mergePending }),
    });
    const data = await res.json();
    if (res.status === 409 && data.status === "conflict") {
      setConflict({ ours: data.ours, theirs: data.theirs, message: data.message });
      setMergePending(true);
      setStatus("Merge conflict — choose a resolution below.");
    } else if (res.ok) {
      setConflict(null);
      setMergePending(false);
      setStatus(`Saved. ${data.message}`);
    } else {
      setStatus(data.error ?? "Save failed");
    }
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
        {selected ? (
          <>
            <div className="editor-bar">
              <h2>{selected}</h2>
              <button onClick={() => save()}>Save</button>
            </div>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
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
                <div className="conflict-actions">
                  <button
                    onClick={() => {
                      setContent(conflict.ours);
                      setConflict(null);
                      void saveWith(conflict.ours);
                    }}
                  >
                    Accept yours
                  </button>
                  <button
                    onClick={() => {
                      setContent(conflict.theirs);
                      setConflict(null);
                      void saveWith(conflict.theirs);
                    }}
                  >
                    Accept theirs
                  </button>
                  <button onClick={() => setStatus("Edit the text above, then Save to resolve.")}>
                    Manual edit
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="empty">Select a feature file or create a new one.</p>
        )}
      </section>
    </main>
  );

  async function saveWith(resolved: string) {
    if (!selected) return;
    setContent(resolved);
    const res = await fetch(`/api/features/${encodeURIComponent(selected)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: resolved, resolveConflict: true }),
    });
    const data = await res.json();
    if (res.ok) setMergePending(false);
    setStatus(res.ok ? `Saved. ${data.message}` : (data.error ?? "Save failed"));
  }
}

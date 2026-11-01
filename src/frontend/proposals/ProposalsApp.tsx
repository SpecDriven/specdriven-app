// The spec-proposals page (specs/app/spec-proposals.feature.md): browse the
// spec repo read-only, sign in with GitHub, and propose a scenario on a
// feature or a new feature with its first scenario. Everything lands as
// `@v1 [proposed]`; the server builds the markdown from the name and text
// given here (src/server/proposals/service.ts).
//
// The parts that show something are plain views over props (ProposalsView,
// QuotaChip, …) so they render the same in tests; ProposalsApp holds the
// state and talks to /api/proposals.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { renderMarkdown } from "../markdown";
import { useSpellCheck } from "../spellCheckPref";

export interface Quota {
  used: number;
  /** Null for a contributor, who has no daily limit. */
  limit: number | null;
  resetsAt: number;
}

export interface Session {
  signedIn: boolean;
  user?: { login: string; name: string | null };
  contributor?: boolean;
  banned?: boolean;
  quota?: Quota;
  perDay: number;
  repo: { owner: string; name: string; url: string };
  sourceUrl: string;
}

export interface FeatureListing {
  fileName: string;
  name: string;
  scenarios: { name: string; version: number; status: string }[];
}

export interface Listing {
  features: FeatureListing[];
  folders: string[];
}

/** One proposed scenario's starting text: the shape every scenario in the repo has. */
export const SCENARIO_TEMPLATE = "- Given: \n- When: \n- Then: ";

/** What the quota chip says. */
export function quotaLabel(quota: Quota): string {
  if (quota.limit === null) return "Contributor — no daily limit";
  const left = Math.max(0, quota.limit - quota.used);
  return `${left} of ${quota.limit} proposals left today`;
}

/** Whether the account can propose right now. */
export function canPropose(session: Session): boolean {
  if (!session.signedIn || session.banned || !session.quota) return false;
  return session.quota.limit === null || session.quota.used < session.quota.limit;
}

/** A feature's folder, as the tree groups it: `specs/app/x.feature.md` → `specs/app`. */
export function folderOf(fileName: string): string {
  return fileName.slice(0, fileName.lastIndexOf("/"));
}

/** The features grouped by folder, folders in order, features by name. */
export function groupByFolder(features: FeatureListing[], filter = ""): [string, FeatureListing[]][] {
  const q = filter.trim().toLowerCase();
  const groups = new Map<string, FeatureListing[]>();
  for (const f of features) {
    if (q && !f.name.toLowerCase().includes(q) && !f.fileName.toLowerCase().includes(q)) continue;
    const folder = folderOf(f.fileName);
    groups.set(folder, [...(groups.get(folder) ?? []), f]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, list]) => [folder, list.sort((x, y) => x.name.localeCompare(y.name))]);
}

/** Why the sign-in came back without a session, from `?signin=`. */
export function signInProblem(code: string | null): string | null {
  switch (code) {
    case null:
    case "":
      return null;
    case "denied":
      return "Sign-in was cancelled on GitHub.";
    case "expired":
      return "That sign-in link expired — try again.";
    default:
      return "Sign-in didn't work — try again.";
  }
}

export function QuotaChip({ quota }: { quota: Quota }) {
  const spent = quota.limit !== null && quota.used >= quota.limit;
  return (
    <span className={`proposals-chip${spent ? " spent" : ""}`} title="Resets at 00:00 UTC">
      {quotaLabel(quota)}
    </span>
  );
}

export function AccountBar({ session, onSignOut }: { session: Session; onSignOut?: () => void }) {
  if (!session.signedIn) {
    return (
      <a className="proposals-button primary" href="/api/proposals/auth/start">
        Sign in with GitHub
      </a>
    );
  }
  return (
    <div className="proposals-account">
      {session.quota && <QuotaChip quota={session.quota} />}
      <span className="proposals-login">@{session.user?.login}</span>
      <button className="proposals-button" type="button" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

export function FeatureView({ content }: { content: string }) {
  return <div className="proposals-feature markdown">{renderMarkdown(content)}</div>;
}

export interface ScenarioFormProps {
  name: string;
  body: string;
  busy: boolean;
  disabled: boolean;
  onName(v: string): void;
  onBody(v: string): void;
  onSubmit(): void;
}

export function ScenarioFields(p: Omit<ScenarioFormProps, "busy" | "onSubmit">) {
  const spellCheck = useSpellCheck();
  return (
    <>
      <label>
        Scenario name
        <input
          value={p.name}
          maxLength={120}
          required
          disabled={p.disabled}
          placeholder="Export the open feature as PDF"
          onChange={(e) => p.onName(e.target.value)}
        />
      </label>
      <label>
        Steps
        <textarea
          value={p.body}
          rows={6}
          required
          spellCheck={spellCheck}
          disabled={p.disabled}
          onChange={(e) => p.onBody(e.target.value)}
        />
      </label>
    </>
  );
}

export function ScenarioForm(p: ScenarioFormProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    p.onSubmit();
  };
  return (
    <form className="proposals-form" onSubmit={submit}>
      <h3>Propose a scenario</h3>
      <ScenarioFields {...p} />
      <button className="proposals-button primary" type="submit" disabled={p.disabled || p.busy}>
        {p.busy ? "Proposing…" : "Propose scenario"}
      </button>
    </form>
  );
}

export function Footer({ session }: { session: Session }) {
  return (
    <footer className="proposals-footer">
      <p>
        Proposals are committed to{" "}
        <a href={session.repo.url} target="_blank" rel="noreferrer">
          {session.repo.owner}/{session.repo.name}
        </a>{" "}
        as <code>[proposed]</code>, authored by your GitHub account; we decide which ones to build. By proposing you
        agree your text is published there under that repository's license. We don't accept pull requests.
      </p>
      <p>
        SpecDriven is open source under the Apache-2.0 license ·{" "}
        <a href={session.sourceUrl} target="_blank" rel="noreferrer">
          Source code
        </a>
      </p>
    </footer>
  );
}

export function ProposalsApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"scenario" | "feature">("scenario");
  const [scenarioName, setScenarioName] = useState("");
  const [scenarioBody, setScenarioBody] = useState(SCENARIO_TEMPLATE);
  const [featureName, setFeatureName] = useState("");
  const [featureFolder, setFeatureFolder] = useState("specs");
  const [description, setDescription] = useState("");
  const spellCheck = useSpellCheck();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string; href?: string } | null>(() => {
    const problem = signInProblem(new URLSearchParams(window.location.search).get("signin"));
    return problem ? { kind: "error", text: problem } : null;
  });

  const loadSession = useCallback(async () => {
    const res = await fetch("/api/proposals/session");
    setSession((await res.json()) as Session);
  }, []);
  const loadListing = useCallback(async () => {
    const res = await fetch("/api/proposals/features");
    if (res.ok) setListing((await res.json()) as Listing);
  }, []);

  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", "/");
    void loadSession();
    void loadListing();
  }, [loadSession, loadListing]);

  useEffect(() => {
    if (!selected) return setContent(null);
    let live = true;
    void fetch(`/api/proposals/features/${encodeURIComponent(selected)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { content?: string } | null) => live && setContent(d?.content ?? null));
    return () => {
      live = false;
    };
  }, [selected]);

  const groups = useMemo(() => groupByFolder(listing?.features ?? [], filter), [listing, filter]);
  const folders = useMemo(() => ["specs", ...(listing?.folders ?? [])], [listing]);

  const signOut = async () => {
    await fetch("/api/proposals/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await loadSession();
  };

  const submit = async () => {
    if (!session) return;
    setBusy(true);
    setNotice(null);
    const scenario = { name: scenarioName, body: scenarioBody };
    const [url, payload] =
      mode === "scenario" && selected
        ? [`/api/proposals/features/${encodeURIComponent(selected)}/scenarios`, scenario]
        : ["/api/proposals/features", { folder: featureFolder, name: featureName, description, scenario }];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string; file?: string; commit?: string; quota?: Quota };
      if (!res.ok) {
        setNotice({ kind: "error", text: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setNotice({
        kind: "ok",
        text: `Proposed "${scenarioName.trim()}" — thank you!`,
        href: data.commit ? `${session.repo.url}/commit/${data.commit}` : undefined,
      });
      if (data.quota) setSession({ ...session, quota: data.quota });
      setScenarioName("");
      setScenarioBody(SCENARIO_TEMPLATE);
      setFeatureName("");
      setDescription("");
      await loadListing();
      if (data.file) {
        setMode("scenario");
        setSelected(data.file);
        // The same file again: refetch its content.
        const r = await fetch(`/api/proposals/features/${encodeURIComponent(data.file)}`);
        if (r.ok) setContent(((await r.json()) as { content: string }).content);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!session) return <div className="proposals-loading">Loading…</div>;
  const allowed = canPropose(session);

  return (
    <div className="proposals">
      <header className="proposals-header">
        <div>
          <h1>Propose a spec</h1>
          <p className="proposals-sub">
            for{" "}
            <a href={session.repo.url} target="_blank" rel="noreferrer">
              {session.repo.owner}/{session.repo.name}
            </a>
          </p>
        </div>
        <AccountBar session={session} onSignOut={() => void signOut()} />
      </header>
      {notice && (
        <div className={`proposals-notice ${notice.kind}`} role="status">
          {notice.text}{" "}
          {notice.href && (
            <a href={notice.href} target="_blank" rel="noreferrer">
              See the commit
            </a>
          )}
        </div>
      )}
      {session.banned && <div className="proposals-notice error">This account cannot propose specs.</div>}
      <div className="proposals-main">
        <nav className="proposals-tree" aria-label="Features">
          <input
            className="proposals-filter"
            placeholder="Filter features"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            className={`proposals-button new${mode === "feature" ? " active" : ""}`}
            onClick={() => {
              setMode("feature");
              setSelected(null);
            }}
          >
            + New feature
          </button>
          {groups.map(([folder, list]) => (
            <section key={folder}>
              <h2>{folder}</h2>
              <ul>
                {list.map((f) => (
                  <li key={f.fileName}>
                    <button
                      type="button"
                      className={selected === f.fileName ? "active" : ""}
                      onClick={() => {
                        setMode("scenario");
                        setSelected(f.fileName);
                      }}
                    >
                      {f.name}
                      <span className="count">{f.scenarios.length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <main className="proposals-pane">
          {mode === "feature" ? (
            <form
              className="proposals-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <h3>Propose a new feature</h3>
              <label>
                Folder
                <select value={featureFolder} disabled={!allowed} onChange={(e) => setFeatureFolder(e.target.value)}>
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Feature name
                <input
                  value={featureName}
                  maxLength={120}
                  required
                  disabled={!allowed}
                  onChange={(e) => setFeatureName(e.target.value)}
                />
              </label>
              <label>
                Description <span className="hint">(optional — who it is for and why)</span>
                <textarea
                  value={description}
                  rows={3}
                  disabled={!allowed}
                  spellCheck={spellCheck}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <ScenarioFields
                name={scenarioName}
                body={scenarioBody}
                disabled={!allowed}
                onName={setScenarioName}
                onBody={setScenarioBody}
              />
              <button className="proposals-button primary" type="submit" disabled={!allowed || busy}>
                {busy ? "Proposing…" : "Propose feature"}
              </button>
              {!session.signedIn && <p className="hint">Sign in with GitHub to propose.</p>}
            </form>
          ) : selected ? (
            <>
              {content === null ? <p className="hint">Loading…</p> : <FeatureView content={content} />}
              <ScenarioForm
                name={scenarioName}
                body={scenarioBody}
                busy={busy}
                disabled={!allowed}
                onName={setScenarioName}
                onBody={setScenarioBody}
                onSubmit={() => void submit()}
              />
              {!session.signedIn && <p className="hint">Sign in with GitHub to propose.</p>}
            </>
          ) : (
            <div className="proposals-welcome">
              <h2>What should SpecDriven do next?</h2>
              <p>
                Pick a feature to read its scenarios and propose another, or start a new feature. Write each scenario
                as Given / When / Then steps. Every GitHub account can make {session.perDay} proposals a day.
              </p>
            </div>
          )}
        </main>
      </div>
      <Footer session={session} />
    </div>
  );
}

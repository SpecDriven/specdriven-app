import { useState } from "react";
import { normalizeJiraBase } from "../server/jiraUrl";

// Settings → Jira (specs/external-links/jira-wiki-import.feature.md "A Jira
// token is kept per site on this device"): the Jira sites this device holds
// a personal access token for, and a form to add one. The server checks a
// token against the site before keeping it and never sends one back — the
// list shows the site and who the token signs in as.

/** A Jira site with a token on this device. */
export interface JiraSite {
  base: string;
  user: string;
}

export async function fetchJiraTokens(): Promise<JiraSite[]> {
  try {
    const res = await fetch("/api/jira/tokens");
    if (!res.ok) return [];
    const data = (await res.json()) as { tokens?: JiraSite[] };
    return data.tokens ?? [];
  } catch {
    return [];
  }
}

export async function postJiraToken(base: string, token: string): Promise<{ site: JiraSite } | { error: string }> {
  try {
    const res = await fetch("/api/jira/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base, token }),
    });
    const data = (await res.json()) as { base?: string; user?: string; error?: string };
    if (!res.ok || !data.base) return { error: data.error ?? "Jira did not accept this token" };
    return { site: { base: data.base, user: data.user ?? "" } };
  } catch {
    return { error: "Could not save the token — is the server running?" };
  }
}

export async function deleteJiraToken(base: string): Promise<JiraSite[] | null> {
  try {
    const res = await fetch("/api/jira/tokens", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { tokens?: JiraSite[] }).tokens ?? [];
  } catch {
    return null;
  }
}

/** The saved sites, each with Remove, and the form that adds one. */
export function JiraTokens({ sites, onChange }: { sites: JiraSite[]; onChange: (sites: JiraSite[]) => void }) {
  const [base, setBase] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cleanBase = normalizeJiraBase(base);

  const save = async () => {
    if (!token.trim() || !cleanBase) return;
    setBusy(true);
    setStatus(null);
    const result = await postJiraToken(cleanBase, token.trim());
    setBusy(false);
    if ("error" in result) {
      setStatus(result.error);
      return;
    }
    setToken("");
    setBase("");
    onChange([...sites.filter((s) => s.base.toLowerCase() !== result.site.base.toLowerCase()), result.site]);
  };

  const remove = async (site: JiraSite) => {
    const next = await deleteJiraToken(site.base);
    if (next === null) setStatus(`Could not remove the token for ${site.base}`);
    else onChange(next);
  };

  return (
    <div className="paste-token confluence-tokens jira-tokens">
      {sites.length > 0 && (
        <ul className="confluence-wikis jira-sites">
          {sites.map((s) => (
            <li key={s.base}>
              <span>
                <strong>{s.base}</strong>
                {s.user && <span className="hint"> — as {s.user}</span>}
              </span>
              <button className="link" onClick={() => void remove(s)} aria-label={`Remove the token for ${s.base}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <span className="settings-row-hint">
        {sites.length > 0 ? "Add another Jira site" : "Add a Jira site"} — its url and a personal access token:
      </span>
      <div className="auth-row">
        <input
          aria-label="Jira url"
          className="paste-token-host"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="https://jira.acme.com"
        />
        <input
          aria-label="Jira personal access token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="Personal access token"
        />
        <button className="secondary" disabled={busy || !token.trim() || !cleanBase} onClick={() => void save()}>
          {busy ? "Checking…" : "Save token"}
        </button>
      </div>
      <span className="hint">
        Create the token in Jira under your profile → Personal Access Tokens. It is checked against the site and kept
        on this device only; nothing is ever written to Jira.
      </span>
      {status && <p className="error">{status}</p>}
    </div>
  );
}

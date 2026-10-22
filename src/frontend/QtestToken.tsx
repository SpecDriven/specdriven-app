import { useState } from "react";
import { normalizeQtestBase } from "../server/qtestUrl";

// Settings → qTest (specs/external-links/qtest-test-cases.feature.md "A qTest
// token is kept per site on this device"): the qTest sites this device holds
// an API token for, and a form to add one. The server checks a token against
// the site before keeping it and never sends one back — the list shows the
// site and what the token reaches.

/** A qTest site with a token on this device. */
export interface QtestSite {
  base: string;
  user: string;
}

export async function fetchQtestTokens(): Promise<QtestSite[]> {
  try {
    const res = await fetch("/api/qtest/tokens");
    if (!res.ok) return [];
    const data = (await res.json()) as { tokens?: QtestSite[] };
    return data.tokens ?? [];
  } catch {
    return [];
  }
}

export async function postQtestToken(base: string, token: string): Promise<{ site: QtestSite } | { error: string }> {
  try {
    const res = await fetch("/api/qtest/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base, token }),
    });
    const data = (await res.json()) as { base?: string; user?: string; error?: string };
    if (!res.ok || !data.base) return { error: data.error ?? "qTest did not accept this token" };
    return { site: { base: data.base, user: data.user ?? "" } };
  } catch {
    return { error: "Could not save the token — is the server running?" };
  }
}

export async function deleteQtestToken(base: string): Promise<QtestSite[] | null> {
  try {
    const res = await fetch("/api/qtest/tokens", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { tokens?: QtestSite[] }).tokens ?? [];
  } catch {
    return null;
  }
}

/** The saved sites, each with Remove, and the form that adds one. */
export function QtestTokens({ sites, onChange }: { sites: QtestSite[]; onChange: (sites: QtestSite[]) => void }) {
  const [base, setBase] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cleanBase = normalizeQtestBase(base);

  const save = async () => {
    if (!token.trim() || !cleanBase) return;
    setBusy(true);
    setStatus(null);
    const result = await postQtestToken(cleanBase, token.trim());
    setBusy(false);
    if ("error" in result) {
      setStatus(result.error);
      return;
    }
    setToken("");
    setBase("");
    onChange([...sites.filter((s) => s.base.toLowerCase() !== result.site.base.toLowerCase()), result.site]);
  };

  const remove = async (site: QtestSite) => {
    const next = await deleteQtestToken(site.base);
    if (next === null) setStatus(`Could not remove the token for ${site.base}`);
    else onChange(next);
  };

  return (
    <div className="paste-token confluence-tokens qtest-tokens">
      {sites.length > 0 && (
        <ul className="confluence-wikis qtest-sites">
          {sites.map((s) => (
            <li key={s.base}>
              <span>
                <strong>{s.base}</strong>
                {s.user && <span className="hint"> — {s.user}</span>}
              </span>
              <button className="link" onClick={() => void remove(s)} aria-label={`Remove the token for ${s.base}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <span className="settings-row-hint">
        {sites.length > 0 ? "Add another qTest site" : "Add a qTest site"} — its url and an API token:
      </span>
      <div className="auth-row">
        <input
          aria-label="qTest url"
          className="paste-token-host"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="https://acme.qtestnet.com"
        />
        <input
          aria-label="qTest API token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="API token"
        />
        <button className="secondary" disabled={busy || !token.trim() || !cleanBase} onClick={() => void save()}>
          {busy ? "Checking…" : "Save token"}
        </button>
      </div>
      <span className="hint">
        Copy the bearer token from qTest under your name → API &amp; SDK, as a user who can add test cases to the
        project. It is checked against the site and kept on this device only.
      </span>
      {status && <p className="error">{status}</p>}
    </div>
  );
}

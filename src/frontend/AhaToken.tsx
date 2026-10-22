import { useState } from "react";
import { normalizeAhaBase } from "../server/ahaUrl";

// Settings → Aha! (specs/external-links/aha-import.feature.md "An Aha! API
// key is kept per site on this device"): the Aha! sites this device holds an
// API key for, and a form to add one. The server checks a key against the
// site before keeping it and never sends one back — the list shows the site
// and who the key signs in as.

/** An Aha! site with an API key on this device. */
export interface AhaSite {
  base: string;
  user: string;
}

export async function fetchAhaTokens(): Promise<AhaSite[]> {
  try {
    const res = await fetch("/api/aha/tokens");
    if (!res.ok) return [];
    const data = (await res.json()) as { tokens?: AhaSite[] };
    return data.tokens ?? [];
  } catch {
    return [];
  }
}

export async function postAhaToken(base: string, token: string): Promise<{ site: AhaSite } | { error: string }> {
  try {
    const res = await fetch("/api/aha/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base, token }),
    });
    const data = (await res.json()) as { base?: string; user?: string; error?: string };
    if (!res.ok || !data.base) return { error: data.error ?? "Aha! did not accept this API key" };
    return { site: { base: data.base, user: data.user ?? "" } };
  } catch {
    return { error: "Could not save the key — is the server running?" };
  }
}

export async function deleteAhaToken(base: string): Promise<AhaSite[] | null> {
  try {
    const res = await fetch("/api/aha/tokens", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { tokens?: AhaSite[] }).tokens ?? [];
  } catch {
    return null;
  }
}

/** The saved sites, each with Remove, and the form that adds one. */
export function AhaTokens({ sites, onChange }: { sites: AhaSite[]; onChange: (sites: AhaSite[]) => void }) {
  const [base, setBase] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cleanBase = normalizeAhaBase(base);

  const save = async () => {
    if (!token.trim() || !cleanBase) return;
    setBusy(true);
    setStatus(null);
    const result = await postAhaToken(cleanBase, token.trim());
    setBusy(false);
    if ("error" in result) {
      setStatus(result.error);
      return;
    }
    setToken("");
    setBase("");
    onChange([...sites.filter((s) => s.base.toLowerCase() !== result.site.base.toLowerCase()), result.site]);
  };

  const remove = async (site: AhaSite) => {
    const next = await deleteAhaToken(site.base);
    if (next === null) setStatus(`Could not remove the key for ${site.base}`);
    else onChange(next);
  };

  return (
    <div className="paste-token confluence-tokens aha-tokens">
      {sites.length > 0 && (
        <ul className="confluence-wikis aha-sites">
          {sites.map((s) => (
            <li key={s.base}>
              <span>
                <strong>{s.base}</strong>
                {s.user && <span className="hint"> — as {s.user}</span>}
              </span>
              <button className="link" onClick={() => void remove(s)} aria-label={`Remove the key for ${s.base}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <span className="settings-row-hint">
        {sites.length > 0 ? "Add another Aha! site" : "Add an Aha! site"} — its url and an API key:
      </span>
      <div className="auth-row">
        <input
          aria-label="Aha! url"
          className="paste-token-host"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="https://acme.aha.io"
        />
        <input
          aria-label="Aha! API key"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="API key"
        />
        <button className="secondary" disabled={busy || !token.trim() || !cleanBase} onClick={() => void save()}>
          {busy ? "Checking…" : "Save key"}
        </button>
      </div>
      <span className="hint">
        Create the key in Aha! under your avatar → Settings → Personal → Developer → API keys. It is checked
        against the site and kept on this device only.
      </span>
      {status && <p className="error">{status}</p>}
    </div>
  );
}

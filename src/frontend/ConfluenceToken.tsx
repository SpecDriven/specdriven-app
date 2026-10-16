import { useState } from "react";
import { normalizeConfluenceBase } from "../server/confluenceUrl";

// Settings → Confluence (specs/external-links/confluence-wiki.feature.md):
// the wikis this device holds a personal access token for, and a form to
// add one. The server checks a token against the wiki before keeping it and
// never sends one back — the list shows the wiki and who the token signs in
// as.

/** A wiki with a token on this device. */
export interface ConfluenceWiki {
  base: string;
  user: string;
}

export async function fetchConfluenceTokens(): Promise<ConfluenceWiki[]> {
  try {
    const res = await fetch("/api/confluence/tokens");
    if (!res.ok) return [];
    const data = (await res.json()) as { tokens?: ConfluenceWiki[] };
    return data.tokens ?? [];
  } catch {
    return [];
  }
}

export async function postConfluenceToken(
  base: string,
  token: string,
): Promise<{ wiki: ConfluenceWiki } | { error: string }> {
  try {
    const res = await fetch("/api/confluence/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base, token }),
    });
    const data = (await res.json()) as { base?: string; user?: string; error?: string };
    if (!res.ok || !data.base) return { error: data.error ?? "Confluence did not accept this token" };
    return { wiki: { base: data.base, user: data.user ?? "" } };
  } catch {
    return { error: "Could not save the token — is the server running?" };
  }
}

export async function deleteConfluenceToken(base: string): Promise<ConfluenceWiki[] | null> {
  try {
    const res = await fetch("/api/confluence/tokens", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { tokens?: ConfluenceWiki[] }).tokens ?? [];
  } catch {
    return null;
  }
}

/** The saved wikis, each with Remove, and the form that adds one. */
export function ConfluenceTokens({
  wikis,
  onChange,
}: {
  wikis: ConfluenceWiki[];
  onChange: (wikis: ConfluenceWiki[]) => void;
}) {
  const [base, setBase] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cleanBase = normalizeConfluenceBase(base);

  const save = async () => {
    if (!token.trim() || !cleanBase) return;
    setBusy(true);
    setStatus(null);
    const result = await postConfluenceToken(cleanBase, token.trim());
    setBusy(false);
    if ("error" in result) {
      setStatus(result.error);
      return;
    }
    setToken("");
    setBase("");
    onChange([...wikis.filter((w) => w.base.toLowerCase() !== result.wiki.base.toLowerCase()), result.wiki]);
  };

  const remove = async (wiki: ConfluenceWiki) => {
    const next = await deleteConfluenceToken(wiki.base);
    if (next === null) setStatus(`Could not remove the token for ${wiki.base}`);
    else onChange(next);
  };

  return (
    <div className="paste-token confluence-tokens">
      {wikis.length > 0 && (
        <ul className="confluence-wikis">
          {wikis.map((w) => (
            <li key={w.base}>
              <span>
                <strong>{w.base}</strong>
                {w.user && <span className="hint"> — as {w.user}</span>}
              </span>
              <button className="link" onClick={() => void remove(w)} aria-label={`Remove the token for ${w.base}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <span className="settings-row-hint">
        {wikis.length > 0 ? "Add another wiki" : "Add a wiki"} — its url and a personal access token:
      </span>
      <div className="auth-row">
        <input
          aria-label="Confluence url"
          className="paste-token-host"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="https://wiki.acme.com"
        />
        <input
          aria-label="Confluence personal access token"
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
        Create the token in Confluence under your profile → Personal Access Tokens, as a user who can add
        pages to the space. It is checked against the wiki and kept on this device only.
      </span>
      {status && <p className="error">{status}</p>}
    </div>
  );
}

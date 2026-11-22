import { useState } from "react";
import { normalizeQtestBase } from "../server/qtestUrl";
import { FailureLine, type FailureDetails } from "./FailureDetails";

// Settings → qTest (specs/external-links/qtest-test-cases.feature.md "One
// qTest token is kept on this device"): the qTest site's url, a Bearer token
// and Save. The server checks a token against the site before keeping it,
// keeps one token only — saving replaces the last, whatever its site — and
// never sends one back: the url field shows the saved site and a line says
// what its token reaches. A token qTest refuses shows as one line; clicking
// it opens what qTest answered.

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

export async function postQtestToken(
  base: string,
  token: string,
): Promise<{ site: QtestSite } | { error: string; details?: FailureDetails }> {
  try {
    const res = await fetch("/api/qtest/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base, token }),
    });
    const data = (await res.json()) as { base?: string; user?: string; error?: string; details?: FailureDetails };
    if (!res.ok || !data.base) {
      return { error: data.error ?? "qTest did not accept this token", ...(data.details ? { details: data.details } : {}) };
    }
    return { site: { base: data.base, user: data.user ?? "" } };
  } catch {
    return { error: "Could not save the token — is the server running?" };
  }
}

/** The url and token fields and Save; the saved site fills the url. */
export function QtestTokens({ sites, onChange }: { sites: QtestSite[]; onChange: (sites: QtestSite[]) => void }) {
  const saved = sites[0] ?? null;
  const [base, setBase] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [details, setDetails] = useState<FailureDetails | null>(null);
  const [busy, setBusy] = useState(false);
  // Until the user types, the url field shows the saved site.
  const shownBase = base ?? saved?.base ?? "";
  const cleanBase = normalizeQtestBase(shownBase);

  const save = async () => {
    if (!token.trim() || !cleanBase) return;
    setBusy(true);
    setStatus(null);
    setDetails(null);
    const result = await postQtestToken(cleanBase, token.trim());
    setBusy(false);
    if ("error" in result) {
      setStatus(result.error);
      setDetails(result.details ?? null);
      return;
    }
    setToken("");
    setBase(null);
    onChange([result.site]);
  };

  return (
    <div className="paste-token confluence-tokens qtest-tokens">
      <div className="auth-row">
        <input
          aria-label="qTest url"
          className="paste-token-host"
          value={shownBase}
          onChange={(e) => setBase(e.target.value)}
          placeholder="https://acme.qtestnet.com"
        />
        <input
          aria-label="qTest Bearer token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder={saved ? "Paste to replace" : "Bearer token"}
        />
        <button type="button" className="btn btn-secondary" disabled={busy || !token.trim() || !cleanBase} onClick={() => void save()}>
          {busy ? "Checking…" : "Save"}
        </button>
      </div>
      <span className="hint">
        {saved && (
          <>
            Token saved{saved.user ? ` — it reaches ${saved.user}` : ""}.{" "}
          </>
        )}
        Copy the Bearer token from qTest under your name → API &amp; SDK, as a user who can add test cases to the
        project — with or without the leading "Bearer". It is checked against the site and kept on this device only.
      </span>
      {status && <FailureLine service="qTest" error={status} details={details} />}
    </div>
  );
}

// Personal access token sign-in (git-operations.md "Personal access token",
// specs/ui/app-start.feature.md "Clone from GitHub"): the first-run screen's
// clone form and the Settings form that pastes a token. Either posts the
// token to /api/auth/github/token, which checks it against the host's /user
// and keeps it as the app's GitHub sign-in — on github.com or a GitHub
// Enterprise host. The built-in git engine then clones and pushes with it,
// so nothing has to be installed.

import { useState } from "react";

export const GITHUB_HOST = "github.com";

/** The app's GitHub sign-in as /api/state and the token route report it. */
export interface TokenSignIn {
  signedIn: boolean;
  login?: string;
  name?: string | null;
  email?: string | null;
  /** Absent for github.com. */
  host?: string;
}

/**
 * The GitHub host a repository url names — github.com, or a GitHub
 * Enterprise host — or null when it is not a `https://<host>/<owner>/<repo>`
 * url. Mirrors parseGitHubUrl in src/server/repo.ts; the server decides.
 */
export function repoUrlHost(url: string): string | null {
  const trimmed = url.trim();
  if (/^git@github\.com:/i.test(trimmed) || /^(www\.)?github\.com\//i.test(trimmed)) return GITHUB_HOST;
  const m = trimmed.match(/^https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/[^/]+\/[^/]+?\/?$/);
  if (!m) return null;
  const host = m[1]!.toLowerCase().replace(/^www\.github\.com$/, GITHUB_HOST);
  return host;
}

/** Where a person makes a fine-grained personal access token on that host. */
export function newTokenUrl(host: string): string {
  return `https://${host}/settings/personal-access-tokens/new`;
}

/** Signed in to `host` (github.com when the sign-in names none)? */
export function signedInTo(auth: TokenSignIn | null, host: string): boolean {
  return Boolean(auth?.signedIn) && (auth?.host ?? GITHUB_HOST) === host;
}

/** POST the token; the sign-in on success, the server's message otherwise. */
export async function postGitHubToken(
  token: string,
  host: string,
): Promise<{ auth: TokenSignIn } | { error: string }> {
  try {
    const res = await fetch("/api/auth/github/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, host }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error ?? "GitHub did not accept this token" };
    return { auth: { ...data, ...(data.host === GITHUB_HOST ? { host: undefined } : {}) } };
  } catch {
    return { error: "Could not reach the app to check the token" };
  }
}

/** The hint under a token field: what kind of token, and where to make it. */
function TokenHint({ host }: { host: string }) {
  return (
    <p className="hint">
      <a href={newTokenUrl(host)} target="_blank" rel="noreferrer">
        Create a fine-grained token
      </a>{" "}
      on {host} with access to the specs repository and <strong>Contents: Read and write</strong>.
      It is stored on this computer only.
    </p>
  );
}

/**
 * First-run "Clone from GitHub": the repository url and a token. The token
 * may stay empty only when the app is already signed in to that url's host —
 * a clone without one could never push the edits back.
 */
export function CloneFromGitHub({
  auth,
  busy,
  error,
  onSignedIn,
  onClone,
}: {
  auth: TokenSignIn | null;
  busy: boolean;
  error: string | null;
  onSignedIn: (auth: TokenSignIn) => void;
  onClone: (url: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const host = repoUrlHost(url);
  const haveSignIn = host !== null && signedInTo(auth, host);

  const submit = async () => {
    setProblem(null);
    if (!host) {
      setProblem("Enter the repository's https url, like https://github.com/owner/specs");
      return;
    }
    if (token.trim()) {
      setChecking(true);
      const result = await postGitHubToken(token.trim(), host);
      setChecking(false);
      if ("error" in result) {
        setProblem(result.error);
        return;
      }
      onSignedIn(result.auth);
      setToken("");
    } else if (!haveSignIn) {
      setProblem(`Paste a token for ${host} — the app needs one to push your edits back.`);
      return;
    }
    await onClone(url.trim());
  };

  return (
    <div
      className="clone-form"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !busy && !checking) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <p>Enter the url of your specs repository on GitHub or GitHub Enterprise:</p>
      <input
        name="clone-url"
        aria-label="Repository url"
        placeholder="https://github.com/owner/specs"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        autoFocus
      />
      <input
        name="clone-token"
        type="password"
        autoComplete="off"
        aria-label="Personal access token"
        placeholder={
          haveSignIn ? `Signed in to ${host} as ${auth?.login} — leave empty to use it` : "Personal access token"
        }
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <TokenHint host={host ?? GITHUB_HOST} />
      <button type="button" disabled={busy || checking} onClick={() => void submit()}>
        {checking ? "Checking the token…" : busy ? "Cloning…" : "Clone and open"}
      </button>
      {(problem ?? error) && <p className="error">{problem ?? cloneError(error!)}</p>}
    </div>
  );
}

/** A failed clone in words about the token, when the token is the problem. */
function cloneError(error: string): string {
  return /authentication required|sign in with GitHub/i.test(error)
    ? "The token can't reach this repository — check that it was given access to it, with Contents: Read and write."
    : error;
}

/**
 * Settings → Git & GitHub: paste a token for github.com or a GitHub
 * Enterprise host, replacing whatever sign-in the app had.
 */
export function PasteToken({
  replacing,
  onSignedIn,
}: {
  /** Signed in already: the pasted token takes that sign-in's place. */
  replacing: boolean;
  onSignedIn: (auth: TokenSignIn) => void;
}) {
  const [host, setHost] = useState(GITHUB_HOST);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cleanHost = host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "") || GITHUB_HOST;

  const save = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setStatus(null);
    const result = await postGitHubToken(token.trim(), cleanHost);
    setBusy(false);
    if ("error" in result) {
      setStatus(result.error);
      return;
    }
    setToken("");
    onSignedIn(result.auth);
  };

  return (
    <div className="paste-token">
      <span className="settings-row-hint">
        {replacing ? "Replace it with a personal access token" : "Or paste a personal access token"} — the
        way in for GitHub Enterprise:
      </span>
      <div className="auth-row">
        <input
          aria-label="GitHub host"
          className="paste-token-host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="github.com"
        />
        <input
          aria-label="Personal access token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="Personal access token"
        />
        <button className="secondary" disabled={busy || !token.trim()} onClick={() => void save()}>
          {busy ? "Checking…" : "Save token"}
        </button>
      </div>
      <TokenHint host={cleanHost} />
      {status && <p className="error">{status}</p>}
    </div>
  );
}

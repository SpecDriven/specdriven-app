import { useState } from "react";
import { normalizeSignedCommitRepos, parseRepoScope, scopeUrl } from "../server/git/repoScope";

// Settings → Git & GitHub's Signed commits (specs/app/user-info-settings
// .feature.md "Signed commits"): the GitHub urls whose commits the app
// signs — a repository, an owner or a host — and the passphrase of the SSH
// key that signs them, for a key no agent holds. The server signs with the
// key in this computer's git config (src/server/git/signing.ts) and keeps
// the passphrase apart from the settings file (signingKey.ts); it is never
// sent back, so the field only ever shows what is being typed.

/** What saving a passphrase answered: whether it was tried on a key, and which. */
export interface PassphraseSaved {
  checked: boolean;
  key: string | null;
}

export async function putSigningPassphrase(passphrase: string): Promise<PassphraseSaved | { error: string }> {
  try {
    const res = await fetch("/api/signing/passphrase", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase }),
    });
    const data = (await res.json()) as { checked?: boolean; key?: string | null; error?: string };
    if (!res.ok) return { error: data.error ?? "Could not save the passphrase" };
    return { checked: data.checked === true, key: data.key ?? null };
  } catch {
    return { error: "Could not save the passphrase — is the server running?" };
  }
}

export async function deleteSigningPassphrase(): Promise<boolean> {
  try {
    return (await fetch("/api/signing/passphrase", { method: "DELETE" })).ok;
  } catch {
    return false;
  }
}

/**
 * The list with `entry` added, or why it cannot be: not a url, or on the
 * list already. The url is kept as the server writes it.
 */
export function addSignedRepo(repos: readonly string[], entry: string): { repos: string[] } | { error: string } {
  const scope = parseRepoScope(entry);
  if (!scope) {
    return {
      error:
        "Enter a GitHub url: a repository (https://github.com/owner/repo), an owner (https://github.com/owner) or a host.",
    };
  }
  const url = scopeUrl(scope);
  const next = normalizeSignedCommitRepos([...repos, url]);
  return next.length === normalizeSignedCommitRepos(repos).length ? { error: `${url} is on the list already.` } : { repos: next };
}

/** What a listed url covers, in words. */
export function scopeWords(url: string): string {
  const depth = parseRepoScope(url)?.path.length;
  return depth === 0 ? "every repository on this host" : depth === 1 ? "every repository of this owner" : "this repository";
}

export function SignedCommits({
  repos,
  passphraseKept,
  onSave,
  onPassphraseKept,
}: {
  repos: string[];
  /** Whether the server keeps a passphrase for the signing key. */
  passphraseKept: boolean;
  /** Save the whole list; false when the server refused (it says why elsewhere on the page). */
  onSave: (repos: string[]) => Promise<boolean>;
  onPassphraseKept: (kept: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [keyStatus, setKeyStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!draft.trim()) return;
    const result = addSignedRepo(repos, draft);
    if ("error" in result) {
      setStatus(result.error);
      return;
    }
    setStatus(null);
    if (await onSave(result.repos)) setDraft("");
  };

  const remove = async (url: string) => {
    setStatus(null);
    await onSave(repos.filter((r) => r !== url));
  };

  const savePassphrase = async () => {
    if (!passphrase) return;
    setBusy(true);
    setKeyStatus(null);
    const result = await putSigningPassphrase(passphrase);
    setBusy(false);
    if ("error" in result) {
      setKeyStatus({ text: result.error, error: true });
      return;
    }
    setPassphrase("");
    onPassphraseKept(true);
    setKeyStatus({
      text: result.checked
        ? `Saved — it unlocks ${result.key}.`
        : "Saved. There was no key file to try it on: git's user.signingkey names none on this computer.",
      error: false,
    });
  };

  const removePassphrase = async () => {
    if (await deleteSigningPassphrase()) {
      onPassphraseKept(false);
      setKeyStatus(null);
    } else {
      setKeyStatus({ text: "Could not remove the passphrase", error: true });
    }
  };

  return (
    <div className="settings-row auth-section signed-commits">
      <span className="auth-title">Signed commits</span>
      <p className="hint">
        Some repositories only take signed commits. The app signs its commits to the ones listed here with the
        signing key in this computer&apos;s git config (<code>user.signingkey</code>, <code>gpg.format</code>), as this
        computer&apos;s git user.
      </p>
      <div className="paste-token confluence-tokens">
        {repos.length > 0 && (
          <ul className="confluence-wikis signed-repos">
            {repos.map((url) => (
              <li key={url}>
                <span>
                  <strong>{url}</strong>
                  <span className="hint"> — {scopeWords(url)}</span>
                </span>
                <button className="link" onClick={() => void remove(url)} aria-label={`Stop signing commits to ${url}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="auth-row">
          <input
            aria-label="GitHub url whose commits are signed"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            placeholder="https://github.com/owner/repo"
          />
          <button className="btn btn-secondary" disabled={!draft.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
        <span className="hint">A repository, an owner (all of its repositories) or a whole GitHub host.</span>
        {status && <p className="error">{status}</p>}
      </div>
      <div className="paste-token confluence-tokens signing-passphrase">
        <span className="settings-row-hint">
          SSH key passphrase — for a signing key that is locked with one and not held by an ssh-agent:
        </span>
        {passphraseKept && (
          <ul className="confluence-wikis">
            <li>
              <span>A passphrase is kept on this computer.</span>
              <button className="link" onClick={() => void removePassphrase()} aria-label="Remove the kept passphrase">
                Remove
              </button>
            </li>
          </ul>
        )}
        <div className="auth-row">
          <input
            aria-label="SSH signing key passphrase"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void savePassphrase();
            }}
            placeholder={passphraseKept ? "Replace the passphrase" : "Passphrase"}
          />
          <button className="btn btn-secondary" disabled={busy || !passphrase} onClick={() => void savePassphrase()}>
            {busy ? "Checking…" : "Save passphrase"}
          </button>
        </div>
        <span className="hint">
          Tried on the key before it is kept, stored apart from the settings file, and handed to ssh-keygen only while
          a commit is signed.
        </span>
        {keyStatus && <p className={keyStatus.error ? "error" : "hint"}>{keyStatus.text}</p>}
      </div>
    </div>
  );
}

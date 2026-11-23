import { useState } from "react";

// Settings → Git & GitHub's Signed commits (specs/app/user-info-settings
// .feature.md "Signed commits"): whether the app signs its commits in the
// open folder, and why — it finds that out itself (src/server/git
// /signing.ts) — and the passphrase of the SSH key that signs them, for a
// key no agent holds. The server signs with the key in this computer's git
// config and keeps the passphrase apart from the settings file
// (signingKey.ts); it is never sent back, so the field only ever shows what
// is being typed.

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
 * Whether the open folder's commits are signed, and what told the app so
 * (the server's `commitSigning`): git's config, the remote's latest
 * commits, or the settings file's list, where the app notes a remote that
 * refused unsigned commits. Anything else reads as not signed.
 */
export function signingWords(reason: unknown): string {
  switch (reason) {
    case "git-config":
      return "The open folder's commits are signed: git's config on this computer says so (commit.gpgsign).";
    case "history":
      return "The open folder's commits are signed: the latest commits on its remote are, and git has a signing key.";
    case "listed":
      return "The open folder's commits are signed: its repository is on the settings file's list (signedCommitRepos), where the app notes a remote that refused unsigned commits.";
    default:
      return "The open folder's commits are not signed.";
  }
}

export function SignedCommits({
  signing,
  passphraseKept,
  onPassphraseKept,
}: {
  /** Why the open folder's commits are signed (the server's `commitSigning`); null where they are not. */
  signing: unknown;
  /** Whether the server keeps a passphrase for the signing key. */
  passphraseKept: boolean;
  onPassphraseKept: (kept: boolean) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [keyStatus, setKeyStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

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
        Some repositories only take signed commits. The app signs its commits wherever git on this computer does
        (<code>commit.gpgsign</code>), where the latest commits on a repository&apos;s remote are all signed, and once
        a remote has refused unsigned ones — with the signing key in this computer&apos;s git config (
        <code>user.signingkey</code>, <code>gpg.format</code>), as this computer&apos;s git user.
      </p>
      <p className="hint signing-status" role="status">
        {signingWords(signing)}
      </p>
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

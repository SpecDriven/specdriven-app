// The passphrase of the SSH key that signs commits
// (specs/app/user-info-settings.feature.md "Signed commits"). The app runs
// with no terminal, so ssh-keygen — which git runs to make an SSH signature
// — has nobody to ask for the passphrase of a key that is not in an agent.
// Settings takes it once instead; it is kept in a secret store of its own
// (src/server/secrets.ts: a 0600 file under the app's home, OS-encrypted in
// the desktop app), never in settings.yaml.
//
// It reaches ssh-keygen the way OpenSSH provides for: SSH_ASKPASS names a
// program that answers the prompt, here a three-line script that echoes one
// environment variable. Both are in the environment of the one git command
// that signs, never on a command line.
//
// Without a kept passphrase the machine's own setup answers — an agent that
// holds the key, or an askpass of the user's — and where there is neither,
// the script still stands in and answers nothing: ssh-keygen would otherwise
// wait on the terminal the app was started from, for as long as it took,
// with the folder's every later save waiting behind that commit.
//
// All of this holds for every commit the app makes, not only one to a
// repository on the signed-commit list: git signs wherever its own config
// says so (`commit.gpgsign`), and that commit asks for the passphrase just
// the same.

import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readTextFile } from "../fsx";
import { run, which } from "../run";
import { secretStore, setSecretBackend } from "../secrets";
import { homeStatePath } from "../settingsModel";

const STORE = "commit-signing";
const PASSPHRASE_ENV = "SPECDRIVEN_SIGNING_PASSPHRASE";

/** The longest passphrase taken. */
export const MAX_PASSPHRASE_LENGTH = 1024;

/**
 * The kept passphrase, or null when there is none. Read from where it is
 * kept each time, never from what this process last saw: another copy of
 * the app on this computer — the desktop app beside a development server,
 * or the code a hot reload left running — may have saved or removed it
 * since, and a remembered "none" would fail every commit until a restart.
 */
export async function signingPassphrase(): Promise<string | null> {
  setSecretBackend(STORE, null);
  return (await secretStore(STORE).load())?.passphrase || null;
}

export async function saveSigningPassphrase(passphrase: string): Promise<void> {
  await secretStore(STORE).save({ passphrase });
}

export async function clearSigningPassphrase(): Promise<void> {
  await secretStore(STORE).clear();
}

/** Why a posted passphrase cannot be kept, or null when it can. */
export function passphraseRefusal(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return "Enter the signing key's passphrase";
  if (value.length > MAX_PASSPHRASE_LENGTH || /[\r\n\0]/.test(value)) {
    return "A passphrase is one line of at most 1024 characters";
  }
  return null;
}

// Answers only a passphrase prompt: ssh also asks through SSH_ASKPASS
// whether to trust a host, and that is not this script's to answer.
const ASKPASS_SCRIPT = `#!/bin/sh
# SpecDriven: answers ssh-keygen's passphrase prompt while the app signs a
# commit. The passphrase is in the environment of that one command; nothing
# is kept in this file.
case "$1" in
*assphrase*) [ -n "$${PASSPHRASE_ENV}" ] && printf '%s\\n' "$${PASSPHRASE_ENV}" ;;
*) exit 1 ;;
esac
`;

/** Where the askpass script is kept: beside the home settings file. */
export function askpassPath(): string {
  return join(dirname(homeStatePath()), "signing-askpass.sh");
}

/** The askpass script, written if it is missing or not as this app writes it. */
async function ensureAskpass(): Promise<string> {
  const path = askpassPath();
  if ((await readTextFile(path)) !== ASKPASS_SCRIPT) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, ASKPASS_SCRIPT, { mode: 0o700 });
  }
  // A file found as written may still have lost its mode (a restored backup).
  await chmod(path, 0o700);
  return path;
}

// Asked through an askpass even when the app was started from a terminal;
// an OpenSSH from before SSH_ASKPASS_REQUIRE only does so with a display named.
const neverTheTerminal = (): Record<string, string> => ({
  SSH_ASKPASS_REQUIRE: "force",
  DISPLAY: process.env.DISPLAY || ":0",
});

/** The environment in which ssh-keygen is answered with `passphrase`; with none, it is told there is no answer. */
async function askpassEnv(passphrase: string | null): Promise<Record<string, string>> {
  return {
    ...neverTheTerminal(),
    SSH_ASKPASS: await ensureAskpass(),
    ...(passphrase ? { [PASSPHRASE_ENV]: passphrase } : {}),
  };
}

/**
 * What a git command that signs runs with besides its own environment: the
 * kept passphrase, where ssh-keygen will ask for it. With none kept, the
 * user's own askpass when they have one, else an answer of "none" — never
 * a prompt on a terminal.
 */
export async function signingEnv(): Promise<Record<string, string>> {
  const passphrase = await signingPassphrase();
  if (!passphrase && process.env.SSH_ASKPASS) return neverTheTerminal();
  return askpassEnv(passphrase);
}

/**
 * How long a git command that makes a commit may take. A commit of specs is
 * a moment's work; one that has not ended by now is waiting on a question
 * nobody sees — a GPG pinentry, say — and holds the folder's every later
 * save behind it.
 */
export const SIGNING_TIMEOUT_MS = 120_000;
let signingTimeout = SIGNING_TIMEOUT_MS;

/** The limit in effect. */
export function signingTimeoutMs(): number {
  return signingTimeout;
}

/** Change the limit; null puts the default back. Returns the previous one. For tests. */
export function setSigningTimeoutMs(next: number | null): number {
  const previous = signingTimeout;
  signingTimeout = next ?? SIGNING_TIMEOUT_MS;
  return previous;
}

export interface PassphraseCheck {
  /**
   * "unlocks": the signing key opens with it. "wrong": it does not.
   * "unchecked": there was no key file to try it on — no git or ssh-keygen,
   * no `user.signingkey`, or one that names a key held by an agent.
   */
  outcome: "unlocks" | "wrong" | "unchecked";
  /** The private key file it was tried on, or null. */
  key: string | null;
}

/**
 * Try a passphrase on the SSH key git signs with in `repoDir` (anywhere,
 * when null): `user.signingkey` as git resolves it there, the private key
 * beside a `.pub`. ssh-keygen derives the public key from the file, which
 * it can only do once the file is unlocked.
 */
export async function checkSigningPassphrase(passphrase: string, repoDir: string | null): Promise<PassphraseCheck> {
  if (!which("git")) return { outcome: "unchecked", key: null };
  const config = async (key: string) => {
    const res = await run("git", ["config", "--type=path", "--get", key], repoDir ? { cwd: repoDir } : {});
    return res.exitCode === 0 ? res.stdout.trim() : "";
  };
  // The program git itself signs with, when its config names one.
  const keygen = (await config("gpg.ssh.program")) || which("ssh-keygen");
  if (!keygen) return { outcome: "unchecked", key: null };
  const named = await config("user.signingkey");
  // A literal key (`ssh-ed25519 AAAA…`, `key::…`) is one an agent holds.
  if (!named || /^(key::|ssh-|ecdsa-|sk-)/.test(named)) {
    return { outcome: "unchecked", key: null };
  }
  const key = named.replace(/\.pub$/, "");
  if (!(await stat(key).then((info) => info.isFile(), () => false))) return { outcome: "unchecked", key: null };
  const res = await run(keygen, ["-y", "-f", key], {
    env: { ...process.env, ...(await askpassEnv(passphrase)) },
    timeoutMs: 10_000,
    label: "ssh-keygen",
  });
  if (res.exitCode === 0) return { outcome: "unlocks", key };
  return { outcome: /incorrect passphrase/i.test(res.stderr) ? "wrong" : "unchecked", key };
}

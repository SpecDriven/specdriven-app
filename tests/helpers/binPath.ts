// What binaries the tests can see. The machine's own gh must never decide
// which git engine a test runs on, nor authenticate anything against real
// GitHub, so every test process starts on a PATH holding one shim — the real
// git, exec'd by absolute path so it still finds its own subcommands — and no
// gh at all (preload.ts). installFakeGh() puts a stub gh on top for the tests
// that exercise the GitHub CLI engine.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { which } from "../../src/server/run";

/** Single-quote a path for the shell scripts below. */
function quote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/** Replace PATH with a directory holding git and nothing else. */
export function isolatePath(): void {
  const realGit = which("git");
  const dir = mkdtempSync(join(tmpdir(), "specdriven-path-"));
  if (realGit) script(dir, "git", `#!/bin/sh\nexec ${quote(realGit)} "$@"\n`);
  process.env.PATH = dir;
}

export interface FakeGh {
  /** Every gh subcommand the code under test ran, in order. */
  calls(): string[];
  restore(): void;
}

export interface FakeGhOptions {
  /** Whether `gh auth token` succeeds; signed out by default it does not. */
  signedIn?: boolean;
  /** Repository `gh repo clone` hands to git; without one, cloning fails. */
  origin?: string;
}

/**
 * A stub gh at the front of PATH, answering the three things the engine asks
 * of it: the auth token, the account, and `repo clone`. Every call is logged
 * so a test can assert gh — not plain git — did the work.
 */
export function installFakeGh({ signedIn = true, origin }: FakeGhOptions = {}): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), "specdriven-gh-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const cloneBody = origin
    ? `exec git clone ${quote(origin)} "$4"`
    : `echo 'remote: Repository not found.' >&2; exit 1`;
  script(
    dir,
    "gh",
    `#!/bin/sh
echo "$1 $2" >> ${quote(log)}
case "$1 $2" in
"auth token") ${signedIn ? "echo gho_faketoken" : "echo 'not logged in' >&2; exit 1"} ;;
"auth git-credential") printf 'username=x-access-token\\npassword=gho_faketoken\\n' ;;
"api user") echo '{"login":"octo","id":7,"name":"Octo Cat","email":null}' ;;
"repo clone") ${cloneBody} ;;
*) echo "unexpected: $*" >&2; exit 1 ;;
esac
`,
  );
  const before = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${before ?? ""}`;
  return {
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    restore: () => {
      process.env.PATH = before;
    },
  };
}

/** The account the stub gh reports, with the noreply email the engine derives. */
export const FAKE_GH_ACCOUNT = {
  login: "octo",
  name: "Octo Cat",
  email: "7+octo@users.noreply.github.com",
};

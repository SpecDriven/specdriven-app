// What binaries the tests can see. The machine's own gh must never decide
// which git engine a test runs on, nor authenticate anything against real
// GitHub, so every test process starts on a PATH holding one shim — the real
// git, exec'd by absolute path so it still finds its own subcommands — and no
// gh at all (preload.ts). installFakeGh() puts a stub gh on top for the tests
// that exercise the GitHub CLI engine. Both are cached executables
// (fakeBin.ts), so neither pays macOS's first-exec scan more than once.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { which } from "../../src/server/run";
import { linkExecutable } from "./fakeBin";

/** Single-quote a path for the shell scripts below. */
function quote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Replace PATH with a directory holding git and nothing else. */
export function isolatePath(): void {
  const realGit = which("git");
  const dir = mkdtempSync(join(tmpdir(), "specdriven-path-"));
  if (realGit) linkExecutable(dir, "git", `#!/bin/sh\nexec ${quote(realGit)} "$@"\n`);
  process.env.PATH = dir;
}

export interface FakeGh {
  /** Every gh subcommand the code under test ran, in order. */
  calls(): string[];
  /** The repository each `gh repo clone` was asked for, in order. */
  cloned(): string[];
  restore(): void;
}

export interface FakeGhOptions {
  /** Whether `gh auth token` succeeds; signed out by default it does not. */
  signedIn?: boolean;
  /** Repository `gh repo clone` hands to git; without one, cloning fails. */
  origin?: string;
  /** GitHub Enterprise hosts gh is logged in to besides github.com. */
  enterpriseHosts?: string[];
}

/**
 * The stub gh's script. It is the same text for every test — what a test
 * varies (the call log, signed in or not, the clone origin) reaches it
 * through FAKE_GH_* variables — so it is written and scanned only once.
 */
const FAKE_GH = `#!/bin/sh
echo "$1 $2" >> "$FAKE_GH_LOG"
case "$1 $2" in
"auth token")
  if [ "$FAKE_GH_SIGNED_IN" = 1 ]; then echo gho_faketoken; else echo 'not logged in' >&2; exit 1; fi ;;
"auth status")
  if [ "$FAKE_GH_SIGNED_IN" != 1 ]; then echo '{"hosts":{}}'; exit 1; fi
  printf '{"hosts":{"github.com":[{"state":"success","host":"github.com","login":"octo"}]%s}}\n' "$FAKE_GH_EXTRA_HOSTS" ;;
"auth git-credential") printf 'username=x-access-token\\npassword=gho_faketoken\\n' ;;
"api user") echo '{"login":"octo","id":7,"name":"Octo Cat","email":null}' ;;
"repo clone")
  echo "$3" >> "$FAKE_GH_LOG.cloned"
  if [ -n "$FAKE_GH_ORIGIN" ]; then exec git clone "$FAKE_GH_ORIGIN" "$4"; fi
  echo 'remote: Repository not found.' >&2; exit 1 ;;
*) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

/**
 * A stub gh at the front of PATH, answering what the engine asks of it: the
 * auth token, the hosts it is logged in to, the account, and `repo clone`. Every call is logged
 * so a test can assert gh — not plain git — did the work.
 */
export function installFakeGh({ signedIn = true, origin, enterpriseHosts = [] }: FakeGhOptions = {}): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), "specdriven-gh-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  writeFileSync(`${log}.cloned`, "");
  linkExecutable(dir, "gh", FAKE_GH);
  const vars = {
    PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_GH_LOG: log,
    FAKE_GH_SIGNED_IN: signedIn ? "1" : "0",
    FAKE_GH_ORIGIN: origin ?? "",
    FAKE_GH_EXTRA_HOSTS: enterpriseHosts
      .map((h) => `,"${h}":[{"state":"success","host":"${h}","login":"octo"}]`)
      .join(""),
  };
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return {
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    cloned: () => readFileSync(`${log}.cloned`, "utf8").split("\n").filter(Boolean),
    restore: () => {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** The account the stub gh reports, with the noreply email the engine derives. */
export const FAKE_GH_ACCOUNT = {
  login: "octo",
  name: "Octo Cat",
  email: "7+octo@users.noreply.github.com",
};

// specs: git operations, "a git command that hangs is stopped": the
// commands that move data report their progress, which is how one that is
// slow is told from one that hangs — and that progress is not part of what
// a failed command says. And a gh that is too slow to answer does not
// decide the rest of the session: it is asked again until it answers.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { limitsFor, setGitTimeouts, withoutProgress } from "../../src/server/git/cli";
import { ghHosts, resetGhCache } from "../../src/server/git/gh";
import { linkExecutable } from "../helpers/fakeBin";

// A gh whose `auth status` never answers while the file $GH_HANG names is
// there, and names a GitHub Enterprise host once it is gone.
const SLOW_GH = `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then
  if [ -e "$GH_HANG" ]; then exec /bin/sleep 30; fi
  echo '{"hosts":{"github.example.com":[{"state":"success"}]}}'
  exit 0
fi
exit 1
`;

let root: string;
const VARIABLES = ["PATH", "GH_HANG"] as const;
const saved = Object.fromEntries(VARIABLES.map((key) => [key, process.env[key]]));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-gitlimits-"));
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setGitTimeouts(null);
  resetGhCache();
  await rm(root, { recursive: true, force: true });
});

test("the commands that move data are limited by their silence, the ones that only ask by their length", () => {
  setGitTimeouts({ quietMs: 50_000, totalMs: 1_800_000 });
  for (const verb of ["fetch", "pull", "push", "clone"]) {
    expect(limitsFor(verb)).toEqual({ quietMs: 50_000, timeoutMs: 1_800_000 });
  }
  expect(limitsFor("ls-remote")).toEqual({ timeoutMs: 50_000 });
  for (const verb of ["commit", "merge", "status", undefined]) expect(limitsFor(verb)).toEqual({});
});

test("the progress a command reported is not part of what it says when it fails", () => {
  const stderr = [
    "remote: Enumerating objects: 4, done.        ",
    "remote: Counting objects:  25% (1/4)        \rremote: Counting objects: 100% (4/4), done.        ",
    "remote: Compressing objects: 100% (2/2), done.\x1b[K",
    "Receiving objects:  25% (1/4)\rReceiving objects:  75% (3/4), 131.96 KiB | 87.00 KiB/s\rReceiving objects: 100% (4/4), 586.34 KiB | 105.00 KiB/s, done.",
    "remote: Total 4 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)        ",
    "Delta compression using up to 8 threads",
    "Writing objects:  75% (3/4), 1.87 MiB | 1019.00 KiB/s\r",
    "Total 4 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)",
    "To github.com:acme/specs.git",
    " ! [rejected]        main -> main (fetch first)",
    "error: failed to push some refs to 'github.com:acme/specs.git'",
    "",
  ].join("\n");
  expect(withoutProgress(stderr)).toBe(
    [
      "To github.com:acme/specs.git",
      " ! [rejected]        main -> main (fetch first)",
      "error: failed to push some refs to 'github.com:acme/specs.git'",
      "",
    ].join("\n"),
  );
  // What reports no progress is left exactly as it was.
  const plain = "fatal: unable to access 'https://github.com/acme/specs.git/': Could not resolve host: github.com\n";
  expect(withoutProgress(plain)).toBe(plain);
});

test("a gh that was too slow to answer is asked again until it answers", async () => {
  const bin = join(root, "bin");
  Bun.spawnSync(["/bin/mkdir", "-p", bin]);
  linkExecutable(bin, "gh", SLOW_GH);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  process.env.GH_HANG = join(root, "hang");
  await writeFile(process.env.GH_HANG, "");
  resetGhCache();
  setGitTimeouts({ quietMs: 300, retryMs: 100 });

  // Stopped at its limit: github.com stands in, for this caller and the next.
  expect(await ghHosts()).toEqual(["github.com"]);
  const started = Date.now();
  expect(await ghHosts()).toEqual(["github.com"]);
  expect(Date.now() - started).toBeLessThan(250); // no second wait for gh

  // gh answers again: what it says replaces the stand-in, with nothing restarted.
  await rm(process.env.GH_HANG);
  let hosts: string[] = [];
  for (let i = 0; i < 100 && hosts[0] !== "github.example.com"; i++) {
    await Bun.sleep(50);
    hosts = await ghHosts();
  }
  expect(hosts).toEqual(["github.example.com"]);
});

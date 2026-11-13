// A git backend that runs no git, for tests whose subject is something else —
// a folder a sync tick makes, the spans a tick records, the order the app
// pulls and reads in. Real git costs 15–50 ms a command and a sync tick runs
// about fifteen of them; this answers in microseconds and never flakes.
//
// It stands for a clean clone that is up to date with its remote: pulls bring
// nothing, commits and pushes succeed, nothing is ever conflicted. File moves
// and removals still happen on disk, as callers expect of `git mv` / `git rm`.
// A test scripts anything else (a pull that delivers a teammate's file, a
// failed push) by passing its own methods.
//
// Tests of sync itself — merges, conflicts, two clones converging — keep
// using real git (fixtures.ts): there git's behaviour is what is under test.

import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitBackend, PathMove, SyncResult } from "../../src/server/git/backend";
import { substituteGitBackend } from "../../src/server/git";

export interface FakeGit {
  /** Every operation the code under test asked for, as "<op> <repo-relative args>", in order. */
  calls(): string[];
  /** Hand git back to the real engines. */
  restore(): void;
}

const PUSHED: SyncResult = { pushed: true, message: "" };

function move(repoDir: string, from: string, to: string): void {
  mkdirSync(dirname(join(repoDir, to)), { recursive: true });
  renameSync(join(repoDir, from), join(repoDir, to));
}

/**
 * Route every git operation in this process to a fake until restore(). Pass
 * methods to script what the default clean, up-to-date clone does not.
 */
export function installFakeGit(script: Partial<Omit<GitBackend, "name">> = {}): FakeGit {
  const log: string[] = [];
  const record = (op: string, ...args: unknown[]) => log.push([op, ...args.map(String)].join(" ").trim());

  const fake: GitBackend = {
    name: "cli",
    async clone(url) {
      throw new Error(`fake git: clone of ${url} is not scripted`);
    },
    async pull() {
      return { ok: true, conflictedFiles: [], message: "Already up to date." };
    },
    async push() {
      return PUSHED;
    },
    async theirsVersion() {
      return null;
    },
    async conflictedFiles() {
      return [];
    },
    async stageVersion() {
      return null;
    },
    async diffNames() {
      return [];
    },
    async existsIn() {
      return false;
    },
    async resolveConflict(repoDir, relPath, content) {
      await Bun.write(join(repoDir, relPath), content);
      return PUSHED;
    },
    async syncSavedChanges() {
      return PUSHED;
    },
    async moveAndPush(repoDir, fromPath, toPath, _message, extraMoves: PathMove[] = []) {
      move(repoDir, fromPath, toPath);
      for (const extra of extraMoves) move(repoDir, extra.from, extra.to);
      return PUSHED;
    },
    async removeAndPush(repoDir, paths) {
      for (const path of [paths].flat()) rmSync(join(repoDir, path), { recursive: true, force: true });
      return PUSHED;
    },
    async commitAndPush() {
      return PUSHED;
    },
    async hasUpstream() {
      return true;
    },
    async commitAllAndPublish() {
      return PUSHED;
    },
    async checkoutRef(_repoDir, ref) {
      throw new Error(`fake git: checkout of ${ref} is not scripted`);
    },
    async headCommit() {
      return "0".repeat(40);
    },
    ...script,
  };

  // Log every call, then hand it to the method in effect (the default or the
  // test's own). The repo dir is left out: a test asserts on what was asked.
  const logged = Object.fromEntries(
    Object.entries(fake).map(([op, method]) => [
      op,
      typeof method === "function"
        ? (repoDir: string, ...rest: unknown[]) => {
            record(op, ...(op === "clone" ? [repoDir, ...rest] : rest));
            return method(repoDir, ...rest);
          }
        : method,
    ]),
  ) as unknown as GitBackend;

  substituteGitBackend(logged);
  return {
    calls: () => [...log],
    restore: () => substituteGitBackend(null),
  };
}

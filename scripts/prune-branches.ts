// Deletes local branches whose last commit is older than N days (default 5),
// and first removes clean worktrees that have such a branch checked out.
// Prints the plan and changes nothing unless --yes is given.
//
//   bun scripts/prune-branches.ts                 # dry run, 5 days
//   bun scripts/prune-branches.ts --days 14       # dry run, 14 days
//   bun scripts/prune-branches.ts --yes           # do it
//   bun scripts/prune-branches.ts --yes --keep-worktrees
//
// Branches are force-deleted (-D): squash-merged PRs never look merged to git.
// Before deleting, every branch tip is written to
// <git-common-dir>/branch-backup-<timestamp>.txt; restore one with
// `git branch <name> <sha>` until gc prunes the commits.
//
// Never touched: main, the current branch, worktrees with uncommitted or
// untracked files (their branches stay too), locked worktrees, the main
// checkout and the worktree this runs in.

import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--yes");
const keepWorktrees = args.includes("--keep-worktrees");
const daysArg = args.indexOf("--days");
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 5;
if (!Number.isFinite(days) || days < 0) {
  console.error("--days needs a non-negative number");
  process.exit(2);
}
const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

const git = async (...a: string[]) => (await $`git ${a}`.quiet().text()).trimEnd();

type Worktree = { path: string; branch?: string; locked: boolean };

async function worktrees(): Promise<Worktree[]> {
  const out = await git("worktree", "list", "--porcelain");
  return out
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))!.slice("worktree ".length);
      const branch = lines.find((l) => l.startsWith("branch "))?.slice("branch refs/heads/".length);
      return { path, branch, locked: lines.some((l) => l.startsWith("locked")) };
    });
}

const branchTimes = new Map<string, number>();
const refs = await git("for-each-ref", "--format=%(committerdate:unix) %(refname:short)", "refs/heads");
for (const line of refs.split("\n")) {
  if (!line) continue;
  const space = line.indexOf(" ");
  branchTimes.set(line.slice(space + 1), Number(line.slice(0, space)));
}
const isOld = (branch: string) => (branchTimes.get(branch) ?? Infinity) < cutoff;

const current = await git("rev-parse", "--abbrev-ref", "HEAD");
const self = resolve(await git("rev-parse", "--show-toplevel"));
const all = await worktrees();
const mainCheckout = resolve(all[0]!.path);

const toRemove: Worktree[] = []; // clean worktrees: git worktree remove
const missing: Worktree[] = []; // folder already gone: git worktree prune drops them
const kept: { wt: Worktree; why: string }[] = [];
for (const wt of all) {
  if (!wt.branch || !isOld(wt.branch)) continue;
  const path = resolve(wt.path);
  if (path === mainCheckout || path === self) continue;
  if (keepWorktrees) kept.push({ wt, why: "--keep-worktrees" });
  else if (wt.locked) kept.push({ wt, why: "locked" });
  else if (!existsSync(wt.path)) missing.push(wt);
  else if (await git("-C", wt.path, "status", "--porcelain")) kept.push({ wt, why: "uncommitted changes" });
  else toRemove.push(wt);
}

const freed = new Set([...toRemove, ...missing].map((w) => w.path));
const stillCheckedOut = new Set(all.filter((w) => w.branch && !freed.has(w.path)).map((w) => w.branch!));
const toDelete = [...branchTimes.keys()]
  .filter((b) => isOld(b) && b !== "main" && b !== current && !stillCheckedOut.has(b))
  .sort();

console.log(`Cutoff: last commit before ${new Date(cutoff * 1000).toISOString().slice(0, 10)} (${days} days)`);
console.log(`\nWorktrees to remove (${toRemove.length + missing.length}):`);
for (const w of toRemove) console.log(`  ${w.path}  [${w.branch}]`);
for (const w of missing) console.log(`  ${w.path}  [${w.branch}] — folder already gone`);
console.log(`\nWorktrees kept, branch not deleted (${kept.length}):`);
for (const { wt, why } of kept) console.log(`  ${wt.path}  [${wt.branch}] — ${why}`);
console.log(`\nBranches to delete (${toDelete.length} of ${branchTimes.size}):`);
for (const b of toDelete) console.log(`  ${b}`);

if (!apply) {
  console.log("\nDry run. Re-run with --yes to do it.");
  process.exit(0);
}
if (toDelete.length === 0 && toRemove.length === 0 && missing.length === 0) process.exit(0);

const commonDir = resolve(await git("rev-parse", "--git-common-dir"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = `${commonDir}/branch-backup-${stamp}.txt`;
await Bun.write(backup, refs + "\n");
console.log(`\nBacked up all ${branchTimes.size} branch tips to ${backup}`);

let failures = 0;
let removedCount = missing.length;
for (const w of toRemove) {
  const r = await $`git worktree remove ${w.path}`.quiet().nothrow();
  if (r.exitCode === 0) {
    removedCount++;
    continue;
  }
  failures++;
  console.error(`  could not remove ${w.path}: ${r.stderr.toString().trim()}`);
  const i = toDelete.indexOf(w.branch!);
  if (i >= 0) toDelete.splice(i, 1);
}
await $`git worktree prune`.quiet();

let deleted = 0;
for (let i = 0; i < toDelete.length; i += 50) {
  const r = await $`git branch -D ${toDelete.slice(i, i + 50)}`.quiet().nothrow();
  deleted += (r.stdout.toString().match(/^Deleted branch/gm) ?? []).length;
  if (r.exitCode !== 0) {
    failures++;
    console.error(r.stderr.toString().trim());
  }
}

console.log(`Removed ${removedCount} worktree(s), deleted ${deleted} branch(es).`);
process.exit(failures ? 1 : 0);

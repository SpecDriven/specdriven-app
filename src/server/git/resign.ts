// Signing the commits that wait to be pushed (specs/app/user-info-settings
// .feature.md "Signed commits"): a remote that only takes signed commits
// refuses a push of unsigned ones, and they would stay on this computer for
// good — signing from then on (signing.ts) does nothing for what is made
// already. So each commit the upstream lacks is made again, signed: the same
// tree, message and author, on the signed copy of its parent, and the branch
// is moved to the last of them.
//
// No working tree is touched and no index: a commit and its signed copy
// hold the same tree, so what is checked out — and what is saved but not
// yet committed — stays exactly as it was. Nothing of the upstream is made
// again either, so nothing anyone else holds changes.
//
// The committer becomes this computer's git user, as for every signed
// commit: the host verifies a signature against the committer's email.
//
// Asked of the git binary directly, like signing.ts: only the engines that
// run one can sign.

import { run } from "../run";
import type { RunResult } from "../run";
import { signingEnv, signingTimeoutMs } from "./signingKey";

/** One commit, as much of it as making it again needs. */
export interface CommitToSign {
  tree: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  message: string;
  signed: boolean;
}

/**
 * A commit object as `git cat-file commit` prints it: headers, a blank
 * line, the message. Null for one whose tree or author cannot be read. The
 * date is kept in the form git reads back exactly ("@<seconds> <zone>").
 */
export function parseCommit(raw: string): CommitToSign | null {
  const gap = raw.indexOf("\n\n");
  const headers = gap < 0 ? raw : raw.slice(0, gap);
  const tree = headers.match(/^tree ([0-9a-f]+)$/m)?.[1];
  const author = headers.match(/^author (.*) <([^>]*)> (\d+ [+-]\d{4})$/m);
  if (!tree || !author) return null;
  return {
    tree,
    parents: [...headers.matchAll(/^parent ([0-9a-f]+)$/gm)].map((m) => m[1]!),
    author: { name: author[1]!, email: author[2]!, date: `@${author[3]!}` },
    message: gap < 0 ? "" : raw.slice(gap + 2),
    signed: /^gpgsig(-sha256)? /m.test(headers),
  };
}

const said = (res: RunResult): string => (res.stderr + res.stdout).trim();

/**
 * Sign the commits of the checked-out branch that its upstream does not
 * hold. Answers how many were unsigned: 0 leaves everything as it was —
 * nothing waits, all of it is signed already, the branch tracks nothing, or
 * a merge is under way. Throws with git's own words when a commit cannot be
 * signed; the branch has not moved then.
 *
 * To be called in the folder's local turn: it moves the branch.
 */
export async function resignWaiting(repoDir: string): Promise<number> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const git = (...args: string[]) => run("git", ["-C", repoDir, ...args], { env, timeoutMs: 30_000, label: `git ${args[0]}` });

  if ((await git("symbolic-ref", "-q", "HEAD")).exitCode !== 0) return 0;
  if ((await git("rev-parse", "-q", "--verify", "MERGE_HEAD")).exitCode === 0) return 0;
  const head = await git("rev-parse", "HEAD");
  const listed = await git("rev-list", "--reverse", "--topo-order", "@{upstream}..HEAD");
  if (head.exitCode !== 0 || listed.exitCode !== 0) return 0;
  const waiting = listed.stdout.split("\n").filter(Boolean);

  const commits: Array<CommitToSign & { sha: string }> = [];
  for (const sha of waiting) {
    const raw = await git("cat-file", "commit", sha);
    const commit = raw.exitCode === 0 ? parseCommit(raw.stdout) : null;
    if (!commit) throw new Error(`could not read commit ${sha} to sign it: ${said(raw)}`);
    commits.push({ ...commit, sha });
  }
  const unsigned = commits.filter((commit) => !commit.signed).length;
  if (unsigned === 0) return 0;

  // Every waiting commit is made again, the signed ones too: a commit names
  // its parents, so one made on a new parent is a new commit.
  const unlock = await signingEnv();
  const copies = new Map<string, string>();
  for (const commit of commits) {
    const parents = commit.parents.flatMap((parent) => ["-p", copies.get(parent) ?? parent]);
    const made = await run("git", ["-C", repoDir, "commit-tree", "-S", commit.tree, ...parents], {
      env: {
        ...env,
        ...unlock,
        GIT_AUTHOR_NAME: commit.author.name,
        GIT_AUTHOR_EMAIL: commit.author.email,
        GIT_AUTHOR_DATE: commit.author.date,
      },
      input: commit.message,
      timeoutMs: signingTimeoutMs(),
      label: "git commit-tree",
    });
    const copy = made.stdout.trim();
    if (made.exitCode !== 0 || !copy) throw new Error(`could not sign commit ${commit.sha.slice(0, 8)}: ${said(made)}`);
    copies.set(commit.sha, copy);
  }

  const old = head.stdout.trim();
  const moved = await git("update-ref", "-m", "specdriven: sign the commits waiting to be pushed", "HEAD", copies.get(old)!, old);
  if (moved.exitCode !== 0) throw new Error(`could not move the branch to its signed commits: ${said(moved)}`);
  return unsigned;
}

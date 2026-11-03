#!/usr/bin/env bun
/**
 * Release notes (docs/releasing.md "Release notes"): what each release
 * changed, made from the pull requests merged since the release before it.
 *
 *   bun scripts/release-notes.ts section v1.2.3   print one version's notes
 *   bun scripts/release-notes.ts backfill         rewrite CHANGELOG.md from every v* tag
 *
 * `bun run bump` calls `notesSince` to add the new version's section to
 * CHANGELOG.md in the release commit; the release workflow prints that
 * section onto the GitHub release, and the app's What's new page reads the
 * file from the build. The file's format is src/frontend/releaseNotes.ts.
 */
import { $ } from "bun";
import {
  formatChangelog,
  sectionFor,
  type Release,
  type ReleaseEntry,
} from "../src/frontend/releaseNotes";

export const CHANGELOG = "CHANGELOG.md";

/** Release tags; `windows-v*` releases ride on these and are not listed. */
const TAG_PATTERN = "v[0-9]*";

/** One first-parent commit, as `git log` reports it. */
export interface Commit {
  subject: string;
  body: string;
}

/** Not a change anyone using the app would look for: releases, dependency bumps, upkeep. */
const SKIP = /^(chore\b|Merge (branch|remote-tracking branch|tag) |Bump specs$)/;
/** A conventional-commit prefix, which older commits carry and notes do without. */
const TYPE_PREFIX = /^(feat|fix|perf|refactor|docs|test|build|ci|style)(\([^)]*\))?!?:\s*/;
/** GitHub's squash title: `Title (#123)`. */
const SQUASH = /^(.*\S)\s+\(#(\d+)\)$/;
/** GitHub's merge commit, whose body carries the pull request's title. */
const MERGE_PR = /^Merge pull request #(\d+) from \S+/;

/**
 * The title without its conventional-commit prefix, capitalized as the
 * prefix's absence asks; a title without one keeps its own case (qTest).
 */
function plainTitle(title: string): string {
  const bare = title.replace(TYPE_PREFIX, "");
  return bare === title ? title : bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** The change one commit made, or null for a commit the notes leave out. */
export function entryFor(commit: Commit): ReleaseEntry | null {
  const subject = commit.subject.trim();
  const merge = MERGE_PR.exec(subject);
  if (merge) {
    const title = commit.body.split("\n").map((l) => l.trim()).find(Boolean);
    return title ? { title: plainTitle(title), pr: Number(merge[1]) } : null;
  }
  if (!subject || SKIP.test(subject)) return null;
  const squash = SQUASH.exec(subject);
  const title = plainTitle(squash ? squash[1]! : subject);
  return { title, pr: squash ? Number(squash[2]) : null };
}

/** The changes these commits made, in the order given (git log's: newest first). */
export function noteEntries(commits: Commit[]): ReleaseEntry[] {
  return commits.map(entryFor).filter((e): e is ReleaseEntry => e !== null);
}

const FIELD = "\x1f";
const RECORD = "\x1e";

/** Commits `git log --format=%s%x1f%b%x1e` printed. */
export function parseLog(out: string): Commit[] {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim())
    .map((r) => {
      const [subject = "", body = ""] = r.split(FIELD);
      return { subject, body };
    });
}

/**
 * The first-parent commits in `range` (`a..b`, or one ref for all of its
 * history): the main line's own commits, so a merged branch's work shows
 * as its pull request, not commit by commit.
 */
export async function commitsIn(range: string, cwd = "."): Promise<Commit[]> {
  const out = await $`git log --first-parent --format=%s%x1f%b%x1e ${range}`.cwd(cwd).quiet().text();
  return parseLog(out);
}

/** The newest release tag reachable from `ref`, or null before the first release. */
export async function previousTag(ref = "HEAD", cwd = "."): Promise<string | null> {
  const res = await $`git describe --tags --abbrev=0 --match ${TAG_PATTERN} ${ref}`.cwd(cwd).nothrow().quiet();
  return res.exitCode === 0 ? res.text().trim() : null;
}

/** Today in the local time zone, as YYYY-MM-DD. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The notes for releasing `version` from HEAD: every change since the last release tag. */
export async function notesSince(version: string, date: string, cwd = "."): Promise<Release> {
  const prev = await previousTag("HEAD", cwd);
  const commits = await commitsIn(prev ? `${prev}..HEAD` : "HEAD", cwd);
  return { version, date, entries: noteEntries(commits) };
}

/** What the oldest release says, its history predating the notes. */
export const EARLIER = "Earlier changes are in the git history.";

/**
 * Every release tag's notes, newest first, each from the commits since the
 * tag before it. The oldest tag's history predates release notes, so it
 * points there instead.
 */
export async function allReleases(cwd = "."): Promise<Release[]> {
  const format = "--format=%(refname:short)%1f%(creatordate:short)";
  const out = await $`git for-each-ref --sort=v:refname ${format} refs/tags/${TAG_PATTERN}`
    .cwd(cwd)
    .quiet()
    .text();
  const tags = out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(FIELD) as [string, string])
    .filter(([name]) => /^v\d+\.\d+\.\d+$/.test(name));
  const releases: Release[] = [];
  for (const [i, [tag, date]] of tags.entries()) {
    const prev = tags[i - 1]?.[0];
    const entries = prev
      ? noteEntries(await commitsIn(`${prev}..${tag}`, cwd))
      : [{ title: EARLIER, pr: null }];
    releases.push({ version: tag.slice(1), date, entries });
  }
  return releases.reverse();
}

async function main(args: string[]): Promise<void> {
  const [command, arg] = args;
  if (command === "section" && arg) {
    const section = sectionFor(await Bun.file(CHANGELOG).text(), arg);
    if (section === null) throw new Error(`${CHANGELOG} has no section for ${arg}`);
    process.stdout.write(section);
    return;
  }
  if (command === "backfill" && !arg) {
    const releases = await allReleases();
    await Bun.write(CHANGELOG, formatChangelog(releases));
    console.log(`  ✓ ${CHANGELOG}  ${releases.length} releases`);
    return;
  }
  throw new Error("usage: release-notes.ts section v<version> | backfill");
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (e) {
    console.error(`release-notes: ${(e as Error).message}`);
    process.exit(1);
  }
}

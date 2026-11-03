// Covers specs/app/release-notes.feature.md: the notes `bun run bump` writes
// to CHANGELOG.md from the pull requests merged since the last release, the
// section the release workflow lifts onto the GitHub release, and the file as
// the What's new page reads it.
import { test, expect } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CHANGELOG_HEADER,
  changelogSection,
  formatChangelog,
  parseChangelog,
  prependSection,
  sectionFor,
  type Release,
} from "../src/frontend/releaseNotes";
import { entryFor, noteEntries, parseLog } from "../scripts/release-notes";

const BUMP = resolve(import.meta.dir, "../scripts/bump-version.ts");

test("each merged pull request is one note, titled as it was merged", () => {
  expect(entryFor({ subject: "Publish a feature to the Wiki and qTest from one dialog (#359)", body: "" })).toEqual({
    title: "Publish a feature to the Wiki and qTest from one dialog",
    pr: 359,
  });
  // GitHub's merge commit names the branch; its body carries the title.
  expect(
    entryFor({ subject: "Merge pull request #112 from SpecDriven/claude/kind-tesla", body: "feat: edit the diagram at the caret\n" }),
  ).toEqual({ title: "Edit the diagram at the caret", pr: 112 });
  // A title of its own case is kept; a conventional prefix is dropped.
  expect(entryFor({ subject: "qTest: accept module urls (#311)", body: "" })?.title).toBe("qTest: accept module urls");
  expect(entryFor({ subject: "fix: seal the canvas on flush", body: "" })).toEqual({ title: "Seal the canvas on flush", pr: null });
});

test("releases, dependency bumps and upkeep are left out of the notes", () => {
  const subjects = [
    "chore: release v0.1.220",
    "chore(deps): bump @codemirror/view (#352)",
    "chore: checkpoint",
    "Merge branch 'main' into feature",
    "Bump specs",
    "Remove the spec proposals service (#353)",
  ];
  expect(noteEntries(subjects.map((subject) => ({ subject, body: "" })))).toEqual([
    { title: "Remove the spec proposals service", pr: 353 },
  ]);
});

test("git log records split into subject and body", () => {
  const out = "First (#2)\x1f\x1e\nMerge pull request #1 from a/b\x1fThe title\n\n\x1e\n";
  expect(parseLog(out)).toEqual([
    { subject: "First (#2)", body: "" },
    { subject: "Merge pull request #1 from a/b", body: "The title\n\n" },
  ]);
});

const r220: Release = {
  version: "0.1.220",
  date: "2026-11-02",
  entries: [
    { title: "Publish a feature to the Wiki and qTest from one dialog", pr: 359 },
    { title: "Re-clone a marketplace whose copy can no longer be refreshed", pr: 358 },
  ],
};
const r219: Release = { version: "0.1.219", date: "2026-11-01", entries: [{ title: "A change without a PR", pr: null }] };

test("a version's section is its heading and a linked line per pull request", () => {
  expect(changelogSection(r220)).toBe(
    "## v0.1.220 — 2026-11-02\n\n" +
      "- Publish a feature to the Wiki and qTest from one dialog ([#359](https://github.com/SpecDriven/specdriven-app/pull/359))\n" +
      "- Re-clone a marketplace whose copy can no longer be refreshed ([#358](https://github.com/SpecDriven/specdriven-app/pull/358))\n",
  );
  expect(changelogSection({ version: "1.0.0", date: "2026-11-03", entries: [] })).toBe(
    "## v1.0.0 — 2026-11-03\n\n- Maintenance release.\n",
  );
});

test("the newest release goes on top, and a version is written once", () => {
  const text = prependSection(prependSection("", r219), r220);
  expect(text.startsWith(CHANGELOG_HEADER)).toBe(true);
  expect(text).toBe(formatChangelog([r220, r219]));
  expect(() => prependSection(text, r220)).toThrow(/already has a section for v0.1.220/);
});

test("the release workflow's section is the lines under the version's heading", () => {
  const text = formatChangelog([r220, r219]);
  expect(sectionFor(text, "v0.1.220")).toBe(changelogSection(r220).split("\n\n")[1]!);
  expect(sectionFor(text, "0.1.219")).toBe("- A change without a PR\n");
  expect(sectionFor(text, "0.1.218")).toBeNull();
});

test("What's new reads back every release the file lists, newest first", () => {
  const maintenance: Release = { version: "0.1.218", date: "2026-10-31", entries: [] };
  expect(parseChangelog(formatChangelog([r220, r219, maintenance]))).toEqual([r220, r219, maintenance]);
});

test("the shipped CHANGELOG.md lists the version package.json names, newest first", async () => {
  const { version } = await Bun.file(resolve(import.meta.dir, "../package.json")).json();
  const releases = parseChangelog(await Bun.file(resolve(import.meta.dir, "../CHANGELOG.md")).text());
  expect(releases[0]?.version).toBe(version);
  const versions = releases.map((r) => r.version);
  expect(new Set(versions).size).toBe(versions.length);
});

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bump-notes-"));
  const git = (...args: string[]) => $`git ${args}`.cwd(dir).quiet();
  await git("init", "-q", "-b", "main");
  for (const [k, v] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ]) {
    await git("config", k!, v!);
  }
  await Bun.write(join(dir, "package.json"), `{\n  "name": "x",\n  "version": "1.0.0"\n}\n`);
  await git("add", ".");
  await git("commit", "-q", "-m", "chore: release v1.0.0");
  await git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
  // A Windows release tag on a later commit must not count as the last release.
  for (const subject of ["Add search (#1)", "chore(deps): bump x (#2)", "Fix the sidebar (#3)"]) {
    await git("commit", "-q", "--allow-empty", "-m", subject);
  }
  await git("tag", "windows-v1.0.0");
  return dir;
}

test("bump commits the version and its notes together, and tags that commit", async () => {
  const dir = await repo();
  try {
    const run = await $`bun ${BUMP} patch`.cwd(dir).nothrow().quiet();
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);

    const changed = await $`git show --name-only --format=%s "v1.0.1^{commit}"`.cwd(dir).text();
    expect(changed.split("\n").filter(Boolean)).toEqual(["chore: release v1.0.1", "CHANGELOG.md", "package.json"]);

    const notes = parseChangelog(await $`git show v1.0.1:CHANGELOG.md`.cwd(dir).text());
    expect(notes).toHaveLength(1);
    expect(notes[0]!.version).toBe("1.0.1");
    expect(notes[0]!.entries).toEqual([
      { title: "Fix the sidebar", pr: 3 },
      { title: "Add search", pr: 1 },
    ]);
    expect((await $`git status --porcelain`.cwd(dir).text()).trim()).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dry run shows the notes it would write and touches nothing", async () => {
  const dir = await repo();
  try {
    const run = await $`bun ${BUMP} minor --dry-run`.cwd(dir).nothrow().quiet();
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("- Fix the sidebar ([#3]");
    expect(await Bun.file(join(dir, "CHANGELOG.md")).exists()).toBe(false);
    expect((await $`git tag -l v1.1.0`.cwd(dir).text()).trim()).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

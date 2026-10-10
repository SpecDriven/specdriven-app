// scripts/test-links.ts: the Claude Code hooks that keep the spec repo's
// `[test: <name> : <url>#L<n> ]` links (specs/external-links/test-
// traceability.feature.md) naming the test at their anchor — re-anchored
// when a test moves, reported when it is gone, and new tests without a
// scenario reported at the end of a turn. Runs against a throwaway git
// repo and spec folder; nothing is pushed.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judge, linksIn, rewrite, run, sameTest, testTitles, type Link } from "../scripts/test-links";

const SCRIPT = join(import.meta.dir, "..", "scripts", "test-links.ts");
const URL = "https://github.com/SpecDriven/specdriven-app/blob/main/tests/a.test.ts";

function link(name: string | null, line: number, path = "tests/a.test.ts"): Link {
  return { spec: "/s.md", specLine: 1, name, url: `https://github.com/SpecDriven/specdriven-app/blob/main/${path}#L${line}`, path, line };
}

const A = [
  'import { test } from "bun:test";',
  "",
  'test("first thing", () => {});',
  "",
  "test.each([",
  '  ["x", 1],',
  '])("refuses %s", () => {});',
  "for (const e of [1, 2]) {",
  "  test(`works (${e} engine)`, () => {});",
  "}",
].join("\n");

describe("reading links and tests", () => {
  test("only links into this repo's tests count, and none inside code", () => {
    const spec = [
      `[test: first thing : ${URL}#L3 ]`,
      "[test: other : https://github.com/o/r/blob/main/T.java#L1 ]",
      `\`[test: in code : ${URL}#L3 ]\``,
      "```",
      `[test: fenced : ${URL}#L3 ]`,
      "```",
      `[test: ${URL}#L5 ]`,
    ].join("\n");
    expect(linksIn("/s.md", spec).map((l) => [l.name, l.line, l.specLine])).toEqual([
      ["first thing", 3, 1],
      [null, 5, 7],
    ]);
  });

  test("a multi-line test.each is named by its closing title, template titles by their pattern or head", () => {
    expect(testTitles(A)).toEqual([
      { name: "first thing", line: 3 },
      { name: "refuses %s", line: 5 },
      { name: "works (${e} engine)", line: 9 },
    ]);
    expect(sameTest("works", "works (${e} engine)")).toBe(true);
    expect(sameTest("works (cli engine)", "works (${e} engine)")).toBe(true);
    expect(sameTest("work", "works (${e} engine)")).toBe(false);
  });
});

describe("judging a link", () => {
  const read = (files: Record<string, string>) => (p: string) => files[p] ?? null;

  test("a link whose anchor names its test is right, a test.each head included", () => {
    expect(judge(link("first thing", 3), read({ "tests/a.test.ts": A }), [])).toEqual({ kind: "ok" });
    expect(judge(link("refuses %s", 6), read({ "tests/a.test.ts": A }), [])).toEqual({ kind: "ok" });
    expect(judge(link("works", 9), read({ "tests/a.test.ts": A }), [])).toEqual({ kind: "ok" });
  });

  test("a test that moved in its file is re-anchored, one that moved file is re-pointed", () => {
    const moved = `\n\n${A}`;
    expect(judge(link("first thing", 3), read({ "tests/a.test.ts": moved }), [])).toMatchObject({ kind: "fix", line: 5 });
    expect(
      judge(link("first thing", 3), read({ "tests/a.test.ts": "", "tests/b.test.ts": A }), ["tests/a.test.ts", "tests/b.test.ts"]),
    ).toMatchObject({ kind: "fix", path: "tests/b.test.ts", line: 3 });
  });

  test("a bare url is given the name at its anchor", () => {
    expect(judge(link(null, 3), read({ "tests/a.test.ts": A }), [])).toMatchObject({ kind: "fix", name: "first thing", line: 3 });
  });

  test("a name no test carries any more is broken", () => {
    expect(judge(link("gone", 3), read({ "tests/a.test.ts": A }), [])).toMatchObject({ kind: "broken" });
    expect(judge(link("gone", 3), read({}), [])).toMatchObject({ kind: "broken" });
  });

  test("a rewrite touches the token it names and leaves code alone", () => {
    const from = `first thing : ${URL}#L3`;
    const to = `first thing : ${URL}#L9`;
    const text = `[test: ${from} ]\n\`[test: ${from} ]\``;
    expect(rewrite(text, new Map([[from, to]]))).toBe(`[test: ${to} ]\n\`[test: ${from} ]\``);
  });
});

describe("the hooks", () => {
  let dir: string;
  let repo: string;
  let specs: string;
  const saved = process.env.SPECDRIVEN_SPECS_DIR;

  async function sh(cwd: string, ...cmd: string[]) {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    await p.exited;
    return (await new Response(p.stdout).text()).trim();
  }

  async function hook(kind: string, input: object) {
    const p = Bun.spawn([process.execPath, SCRIPT, "--hook", kind], {
      cwd: repo,
      stdin: new Blob([JSON.stringify({ cwd: repo, ...input })]),
      stdout: "pipe",
      env: { ...process.env, SPECDRIVEN_SPECS_DIR: specs },
    });
    expect(await p.exited).toBe(0);
    const out = (await new Response(p.stdout).text()).trim();
    return out ? JSON.parse(out) : null;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "test-links-"));
    repo = join(dir, "repo");
    specs = join(dir, "specs");
    await mkdir(join(repo, "tests"), { recursive: true });
    await mkdir(join(repo, "scripts"), { recursive: true });
    await mkdir(specs);
    await Bun.write(join(repo, "scripts", "test-links.ts"), "");
    await Bun.write(join(repo, "tests", "a.test.ts"), A);
    await Bun.write(join(specs, "f.feature.md"), `## a scenario @v1 [proposed]\n\n- Then: x\n\n[test: first thing : ${URL}#L3 ]\n`);
    await sh(repo, "git", "init", "-q", "-b", "main");
    await sh(repo, "git", "add", ".");
    await sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    process.env.SPECDRIVEN_SPECS_DIR = specs;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.SPECDRIVEN_SPECS_DIR;
    else process.env.SPECDRIVEN_SPECS_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  test("after an edit to a test file the links into it are re-anchored, and Claude is told", async () => {
    await Bun.write(join(repo, "tests", "a.test.ts"), `// moved\n${A}`);
    const out = await hook("post-tool-use", { tool_name: "Edit", tool_input: { file_path: join(repo, "tests", "a.test.ts") } });
    expect(out.hookSpecificOutput.additionalContext).toContain('"first thing" → tests/a.test.ts#L4');
    expect(await Bun.file(join(specs, "f.feature.md")).text()).toContain(`[test: first thing : ${URL}#L4 ]`);
  });

  test("an edit outside tests/ is let through without a word", async () => {
    await Bun.write(join(repo, "scripts", "x.ts"), "");
    expect(await hook("post-tool-use", { tool_name: "Write", tool_input: { file_path: join(repo, "scripts", "x.ts") } })).toBeNull();
  });

  test("at the end of a turn a broken link or an unlinked new test blocks once, then only warns", async () => {
    await Bun.write(join(repo, "tests", "a.test.ts"), A.replace("first thing", "renamed thing"));
    const first = await hook("stop", { stop_hook_active: false });
    expect(first.decision).toBe("block");
    expect(first.reason).toContain('no test "first thing"');
    expect(first.reason).toContain('"renamed thing"');
    const again = await hook("stop", { stop_hook_active: true });
    expect(again.decision).toBeUndefined();
    expect(again.systemMessage).toContain("still need attention");
  });

  test("a turn that leaves every link right ends quietly", async () => {
    await Bun.write(join(repo, "tests", "a.test.ts"), `${A}\n// a comment\n`);
    expect(await hook("stop", { stop_hook_active: false })).toBeNull();
    expect(run(repo, { fix: false })).toMatchObject({ broken: [], fixed: [], checked: 1 });
  });
});

// scripts/spec-discovery.ts: the Claude Code stop hook that ends a coding
// session by naming the behaviour the branch added that no scenario in the
// spec repo describes — new exports and routes no linked test exercises,
// and new files nothing reaches. Runs against a throwaway git repo and
// spec folder; nothing is pushed.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, exercises, hunks, importsOf, report, resolveImport, surface } from "../scripts/spec-discovery";

const SCRIPT = join(import.meta.dir, "..", "scripts", "spec-discovery.ts");
const BLOB = "https://github.com/SpecDriven/specdriven-app/blob/main";

describe("reading the diff", () => {
  const diff = [
    "diff --git a/src/server/widgets.ts b/src/server/widgets.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/server/widgets.ts",
    "@@ -0,0 +1,2 @@",
    "+export function makeWidget() {}",
    "+const private = 1;",
    "diff --git a/src/server/api.ts b/src/server/api.ts",
    "--- a/src/server/api.ts",
    "+++ b/src/server/api.ts",
    "@@ -10,0 +11 @@",
    '+  ["POST", "/api/widgets", postWidgets],',
    "diff --git a/src/types.d.ts b/src/types.d.ts",
    "--- a/src/types.d.ts",
    "+++ b/src/types.d.ts",
    "@@ -1,0 +2 @@",
    "+export declare const x: number;",
    "diff --git a/docs/notes.md b/docs/notes.md",
    "--- a/docs/notes.md",
    "+++ b/docs/notes.md",
    "@@ -1,0 +2 @@",
    "+a note",
  ].join("\n");

  test("only source files count, each with the lines it gained and whether it is new", () => {
    expect(hunks(diff, () => []).map((h) => [h.path, h.isNew, h.added.length])).toEqual([
      ["src/server/widgets.ts", true, 2],
      ["src/server/api.ts", false, 1],
    ]);
  });

  test("a line of a file that reads like a diff header is content, not a header", () => {
    const sneaky = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +2,2 @@",
      "+++ b/src/evil.ts",
      "+export const real = 1;",
    ].join("\n");
    expect(hunks(sneaky, () => []).map((h) => h.path)).toEqual(["src/a.ts"]);
    expect(surface(hunks(sneaky, () => [])[0]!.added).exports).toEqual(["real"]);
  });

  test("files git does not track yet are new files, every line of them added", () => {
    const untracked = (path: string) =>
      path === "" ? ["src/fresh.ts", "src/fresh.css", "notes.txt"] : ["export const a = 1;", "const b = 2;"];
    expect(hunks("", untracked).map((h) => [h.path, h.isNew, h.added.length])).toEqual([["src/fresh.ts", true, 2]]);
  });

  test("the surface is what the branch newly exports and serves, never a type", () => {
    expect(
      surface([
        "export function makeWidget() {}",
        "export async function listWidgets() {}",
        "export const LIMIT = 10;",
        "export default class Widget {}",
        "export interface Widget { id: string }",
        "export type WidgetId = string;",
        "function helper() {}",
        '  ["POST", "/api/widgets", postWidgets],',
        '  ["GET", "/api/widgets/:id", getWidget],',
        "export function makeWidget() {}",
      ]),
    ).toEqual({
      exports: ["makeWidget", "listWidgets", "LIMIT", "Widget"],
      routes: ["POST /api/widgets", "GET /api/widgets/:id"],
    });
  });
});

describe("what a test exercises", () => {
  test("an export is named as a whole word", () => {
    expect(exercises("expect(makeWidget()).toBe(1)", "export", "makeWidget")).toBe(true);
    expect(exercises("expect(makeWidgetTwice()).toBe(1)", "export", "makeWidget")).toBe(false);
    expect(exercises("nothing here", "export", "makeWidget")).toBe(false);
  });

  test("a route is called by its path, up to its first parameter", () => {
    expect(exercises('fetch("/api/widgets/abc/archive")', "route", "POST /api/widgets/:id/archive")).toBe(true);
    expect(exercises('fetch("/api/other")', "route", "POST /api/widgets/:id/archive")).toBe(false);
    // `/api/` alone would match every test that calls the api.
    expect(exercises('fetch("/api/anything")', "route", "GET /api/:rest")).toBe(false);
  });

  test("only relative imports are followed, and only to a source file", () => {
    expect(importsOf('import { a } from "../src/a";\nawait import("./b");\nimport "bun:test";')).toEqual([
      "../src/a",
      "./b",
    ]);
    const exists = (p: string) => ["src/a.ts", "src/b/index.tsx"].includes(p);
    expect(resolveImport("tests/x.test.ts", "../src/a", exists)).toBe("src/a.ts");
    expect(resolveImport("tests/x.test.ts", "../src/b", exists)).toBe("src/b/index.tsx");
    expect(resolveImport("tests/x.test.ts", "../src/gone", exists)).toBeNull();
    expect(resolveImport("tests/x.test.ts", "./helpers", exists)).toBeNull();
  });
});

describe("the stop hook", () => {
  let dir: string;
  let repo: string;
  let specs: string;
  const saved = process.env.SPECDRIVEN_SPECS_DIR;

  const WIDGETS = ["export function oldThing() {}", "export function covered() {}"].join("\n");
  const TESTS = [
    'import { oldThing, covered } from "../src/server/widgets";',
    "",
    'test("covers old thing", () => oldThing());',
    "",
    'test("covers the covered one", () => covered());',
  ].join("\n");

  async function sh(cwd: string, ...cmd: string[]) {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    await p.exited;
    return (await new Response(p.stdout).text()).trim();
  }

  async function hook(input: object) {
    const p = Bun.spawn([process.execPath, SCRIPT, "--hook", "stop"], {
      cwd: repo,
      stdin: new Blob([JSON.stringify({ cwd: repo, ...input })]),
      stdout: "pipe",
      env: { ...process.env, SPECDRIVEN_SPECS_DIR: specs },
    });
    expect(await p.exited).toBe(0);
    const out = (await new Response(p.stdout).text()).trim();
    return out ? JSON.parse(out) : null;
  }

  function found() {
    return discover(repo, "HEAD")!;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spec-discovery-"));
    repo = join(dir, "repo");
    specs = join(dir, "specs");
    await mkdir(join(repo, "src", "server"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await mkdir(join(repo, "scripts"), { recursive: true });
    await mkdir(specs);
    await Bun.write(join(repo, "scripts", "spec-discovery.ts"), "");
    await Bun.write(join(repo, "src", "server", "widgets.ts"), WIDGETS);
    await Bun.write(join(repo, "tests", "widgets.test.ts"), TESTS);
    await Bun.write(
      join(specs, "widgets.feature.md"),
      `# Widgets\n\n## S1: a widget is made @v1 [proposed]\n\n- **Then** a widget\n\n[test: covers old thing : ${BLOB}/tests/widgets.test.ts#L3 ]\n`,
    );
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

  test("a turn that adds no behaviour ends quietly", async () => {
    await Bun.write(join(repo, "src", "server", "widgets.ts"), `${WIDGETS}\n// a comment\n`);
    expect(found().changes).toEqual([]);
    expect(await hook({ stop_hook_active: false })).toBeNull();
  });

  test("behaviour a scenario's test already exercises is described, and said nothing about", async () => {
    await Bun.write(join(repo, "src", "server", "widgets.ts"), `${WIDGETS}\nexport function covered2() {}\n`);
    await Bun.write(join(repo, "tests", "widgets.test.ts"), `${TESTS}\n// covered2 is exercised here\n`);
    expect(found().changes).toEqual([]);
    expect(await hook({ stop_hook_active: false })).toBeNull();
  });

  test("an export and a route no test exercises are gaps, and the turn is blocked once", async () => {
    await Bun.write(
      join(repo, "src", "server", "widgets.ts"),
      `${WIDGETS}\nexport function archiveWidget() {}\n["POST", "/api/widgets/:id/archive", archiveWidget],\n`,
    );
    const change = found().changes[0]!;
    expect(change.path).toBe("src/server/widgets.ts");
    expect(change.gaps).toEqual([
      { kind: "route", name: "POST /api/widgets/:id/archive", tests: [] },
      { kind: "export", name: "archiveWidget", tests: [] },
    ]);
    expect(change.related).toEqual(["specs/widgets.feature.md"]);

    const first = await hook({ stop_hook_active: false });
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("archiveWidget — no test exercises it");
    expect(first.reason).toContain("route POST /api/widgets/:id/archive");
    expect(first.reason).toContain("perhaps belongs in: specs/widgets.feature.md");

    // One nudge: a second stop with them still open only warns.
    const again = await hook({ stop_hook_active: true });
    expect(again.decision).toBeUndefined();
    expect(again.systemMessage).toContain("still unspecified");
  });

  test("a test no scenario links is named, as the one to link once the scenario exists", async () => {
    await Bun.write(join(repo, "src", "server", "widgets.ts"), `${WIDGETS}\nexport function archiveWidget() {}\n`);
    await Bun.write(join(repo, "tests", "archive.test.ts"), 'test("archives", () => archiveWidget());');
    expect(found().changes[0]!.gaps).toEqual([
      { kind: "export", name: "archiveWidget", tests: ["tests/archive.test.ts"] },
    ]);
    expect(report(found())).toContain("exercised by tests/archive.test.ts, which no scenario links");
  });

  test("a new file of substance that exports nothing is a gap of its own; a small one is plumbing", async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `const line${i} = ${i};`).join("\n");
    await Bun.write(join(repo, "src", "server", "big.ts"), lines(20));
    await Bun.write(join(repo, "src", "server", "small.ts"), lines(3));
    expect(found().changes.map((c) => [c.path, c.gaps[0]!.kind])).toEqual([["src/server/big.ts", "file"]]);
  });

  test("the hook stays out of the way when it is switched off", async () => {
    await Bun.write(join(repo, "src", "server", "widgets.ts"), `${WIDGETS}\nexport function archiveWidget() {}\n`);
    const p = Bun.spawn([process.execPath, SCRIPT, "--hook", "stop"], {
      cwd: repo,
      stdin: new Blob(["{}"]),
      stdout: "pipe",
      env: { ...process.env, SPECDRIVEN_SPECS_DIR: specs, SPECDRIVEN_SPEC_DISCOVERY: "off" },
    });
    expect(await p.exited).toBe(0);
    expect((await new Response(p.stdout).text()).trim()).toBe("");
  });
});

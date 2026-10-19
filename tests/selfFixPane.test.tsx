// specs/app/self-healing.feature.md on the client: the hints about the
// machine, the line about which bundle booted, the controls a fix offers,
// and the titles. Pure helpers and static markup — no DOM.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BootBanner, ChangeList, FixStatus, Hints } from "../src/frontend/SelfFixPane";
import {
  EMPTY_SELF_FIX,
  bootBanner,
  fixControls,
  fixLabel,
  preconditionHints,
  selfFixTitle,
  type FixRecord,
  type FixView,
  type Preconditions,
} from "../src/frontend/selfFix";

const ready: Preconditions = {
  codeGen: true,
  claude: true,
  git: true,
  bun: "/usr/local/bin/bun",
  source: { dir: "/h/app/specdriven-0.1.157", version: "0.1.157", match: true, mode: "installed" },
  runtime: "desktop",
  boot: { source: "asar", reason: "none", fixId: null },
  canRelaunch: true,
};

const fix = (extra: Partial<FixRecord> = {}): FixRecord => ({
  id: "11111111-1111-1111-1111-111111111111",
  createdAt: "2026-10-19T10:00:00Z",
  description: "The greeting reads Helo.\nIt should read Hello.",
  screenshots: [],
  sourceDir: "/h/app/specdriven-0.1.157",
  baseRef: "baseline",
  mode: "installed",
  cleanAtStart: true,
  sessionId: "s-1",
  status: "running",
  builtAt: null,
  error: null,
  ...extra,
});

const view = (extra: Partial<FixView> = {}): FixView => ({
  fix: fix(),
  session: null,
  diff: { files: ["src/greeting.ts"], summary: "1 file changed, 1 insertion(+), 1 deletion(-)" },
  boot: ready.boot,
  canRelaunch: true,
  runtime: "desktop",
  ...extra,
});

describe("Fix this app is refused where it cannot work", () => {
  test("every missing precondition is a hint; the ones that block come with the remedy", () => {
    expect(preconditionHints(ready)).toEqual([]);
    const hints = preconditionHints({ ...ready, codeGen: false, claude: false, git: false, bun: null, source: null });
    expect(hints.map((h) => [h.blocking, h.settings ?? false])).toEqual([
      [true, true],
      [true, false],
      [true, false],
      [true, false],
      [false, false],
    ]);
    expect(hints[0]!.text).toMatch(/Code generation is switched off/);
    expect(hints[3]!.text).toMatch(/SPECDRIVEN_APP_SOURCE/);
    expect(hints[4]!.text).toMatch(/bun is not installed/);
    // The version running is not the one installed.
    const [mismatch] = preconditionHints({ ...ready, source: { ...ready.source!, version: "0.1.150", match: false } });
    expect(mismatch).toMatchObject({ blocking: true });
    expect(mismatch!.text).toMatch(/version 0\.1\.150/);
    // A desktop build from before the shim, and the web server, are told but not blocked.
    expect(preconditionHints({ ...ready, boot: { source: "none", reason: "none", fixId: null } })).toEqual([
      expect.objectContaining({ blocking: false, text: expect.stringMatching(/predates self-fixing/) }),
    ]);
    expect(preconditionHints({ ...ready, runtime: "web", boot: { source: "none", reason: "none", fixId: null }, canRelaunch: false })).toEqual([
      expect.objectContaining({ blocking: false, text: expect.stringMatching(/bun run start/) }),
    ]);
  });

  test("the hints render as a list, with a Settings button where Settings holds the remedy", () => {
    const html = renderToStaticMarkup(<Hints hints={preconditionHints({ ...ready, codeGen: false, bun: null })} onOpenSettings={() => {}} />);
    expect(html).toContain('class="blocking"');
    expect(html).toContain("Open Settings");
    expect(html).toContain('class="muted"');
    expect(renderToStaticMarkup(<Hints hints={[]} onOpenSettings={() => {}} />)).toBe("");
  });
});

describe("which bundle booted", () => {
  test("the banner names the fix running, or why the shipped build runs instead", () => {
    const fixes = [fix()];
    expect(bootBanner(ready.boot, fixes)).toBeNull();
    expect(bootBanner({ source: "patch", reason: "ok", fixId: fixes[0]!.id }, fixes)).toBe('Running the rebuilt app with "The greeting reads Helo.".');
    expect(bootBanner({ source: "patch", reason: "ok", fixId: "22222222-2222-2222-2222-222222222222" }, fixes)).toBe("Running the rebuilt app with fix 22222222.");
    expect(bootBanner({ source: "asar", reason: "crash-loop", fixId: fixes[0]!.id }, fixes)).toMatch(/failed to start twice; this is the shipped build/);
    expect(bootBanner({ source: "asar", reason: "load-error", fixId: fixes[0]!.id }, fixes)).toMatch(/could not be loaded/);
    expect(bootBanner({ source: "asar", reason: "version-mismatch", fixId: fixes[0]!.id }, fixes)).toMatch(/another version of the app and is ignored/);
    expect(bootBanner({ source: "none", reason: "none", fixId: null })).toBeNull();
  });

  test("a fall-back banner is marked as a warning", () => {
    const warn = renderToStaticMarkup(<BootBanner index={{ ...ready, boot: { source: "asar", reason: "crash-loop", fixId: "x" }, fixes: [] }} />);
    expect(warn).toContain('class="self-fix-banner warn"');
    const fine = renderToStaticMarkup(<BootBanner index={{ ...ready, boot: { source: "patch", reason: "ok", fixId: "x" }, fixes: [] }} />);
    expect(fine).toContain('class="self-fix-banner"');
    expect(renderToStaticMarkup(<BootBanner index={{ ...ready, fixes: [] }} />)).toBe("");
  });
});

describe("the controls a fix offers", () => {
  test("rebuild needs a change, restart a build, revert a start", () => {
    expect(fixControls(view({ diff: { files: [], summary: "" } }))).toEqual({ build: false, restart: false, revert: true });
    expect(fixControls(view())).toEqual({ build: true, restart: false, revert: true });
    expect(fixControls(view({ fix: fix({ status: "built" }) }))).toEqual({ build: true, restart: true, revert: true });
    expect(fixControls(view({ fix: fix({ status: "applied" }) }))).toEqual({ build: true, restart: true, revert: true });
    expect(fixControls(view({ fix: fix({ status: "reverted" }), diff: null }))).toEqual({ build: false, restart: false, revert: false });
    expect(fixControls(view({ fix: fix({ status: "draft", sessionId: null }), diff: null }))).toEqual({ build: false, restart: false, revert: false });
  });

  test("the status line says where the fix stands, with the agent's state and the last error", () => {
    const html = renderToStaticMarkup(
      <FixStatus view={view({ session: { status: "awaiting_input" } as FixView["session"], fix: fix({ error: "Build failed (exit 1)" }) })} />,
    );
    expect(html).toContain("Agent working");
    expect(html).toContain("agent awaiting input");
    expect(html).toContain("Build failed (exit 1)");
    expect(renderToStaticMarkup(<FixStatus view={view({ fix: fix({ status: "built" }) })} />)).toContain("Rebuilt — restart to use it");
  });

  test("the change list names the files, or says nothing changed", () => {
    expect(renderToStaticMarkup(<ChangeList view={view()} />)).toContain("<code>src/greeting.ts</code>");
    expect(renderToStaticMarkup(<ChangeList view={view({ diff: { files: [], summary: "" } })} />)).toContain("Nothing changed yet.");
  });
});

test("titles and labels come from the first line of the user's words", () => {
  expect(fixLabel(fix())).toBe("The greeting reads Helo.");
  expect(fixLabel(fix({ description: "" }))).toBe("New fix");
  expect(selfFixTitle({ kind: "new" }, EMPTY_SELF_FIX)).toBe("Fix this app");
  expect(selfFixTitle({ kind: "fix", id: fix().id }, EMPTY_SELF_FIX)).toBe("Fix this app");
  expect(selfFixTitle({ kind: "fix", id: fix().id }, { ...EMPTY_SELF_FIX, views: { [fix().id]: view() } })).toBe("Fix: The greeting reads Helo.");
});

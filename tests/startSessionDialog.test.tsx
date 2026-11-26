// The Start session dialog (src/frontend/StartSessionDialog.tsx): one dialog
// for one thing, an AI session, with the old dialog's words and gating
// (specs/launch-ai-agent-session.feature.md). Timing your own work is the
// Pomodoro, which has no dialog to start it (tests/pomodoroSettings.test.tsx).
// Static markup only — bun test has no DOM.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AiSessionFields, StartSessionDialog, aiTabState, hostedSessionPick, sessionSelection } from "../src/frontend/StartSessionDialog";
import type { PromptOptions } from "../src/frontend/ModalPrompts";

const noop = () => undefined;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const submit = (markup: string) => markup.match(/<button type="submit"([^>]*)>([^<]*)<\/button>/);

const aiDialog: PromptOptions = {
  title: "Name the session",
  hint: "Runs the chosen agent over Quote, or copies the prompt.",
  initial: "Session 2026-09-08 09:15:00 PDT",
  placeholder: "e.g. implement billing quotes",
  confirmLabel: "Start AI Session",
  choicesLabel: "Run in",
  choices: [
    { value: "clipboard", label: "Copy prompt to clipboard", confirmLabel: "Copy prompt" },
    { value: "desktop", label: "Claude Code Desktop" },
    { value: "pane", label: "Coding agent pane" },
  ],
  initialChoice: "pane",
};

describe("aiTabState", () => {
  test("is the old button's gating, each reason in words", () => {
    expect(aiTabState({ codeGen: true, specCount: 2, sessionRunning: false })).toEqual({ enabled: true, hint: null });
    expect(aiTabState({ codeGen: false, specCount: 2, sessionRunning: false }).hint).toContain("Code generation");
    expect(aiTabState({ codeGen: true, specCount: 0, sessionRunning: false }).hint).toContain("Select a spec");
    expect(aiTabState({ codeGen: true, specCount: 1, sessionRunning: true }).hint).toContain("already starting");
  });
});

describe("hostedSessionPick", () => {
  test("the hosted app copies what is checked, else the open feature, else says what to do", () => {
    const checked = [{ fileName: "quote.feature.md", scenarios: [{ name: "Price", version: 1 }] }];
    expect(hostedSessionPick({ picked: checked, bundled: 0, openFeature: "other.feature.md" })).toEqual({ files: checked });
    expect(hostedSessionPick({ picked: [], bundled: 0, openFeature: "other.feature.md" })).toEqual({
      files: [{ fileName: "other.feature.md" }],
    });
    // What a plugin view bundles is a session of its own, open feature or not.
    expect(hostedSessionPick({ picked: [], bundled: 1, openFeature: "other.feature.md" })).toEqual({ files: [] });
    const none = hostedSessionPick({ picked: [], bundled: 0, openFeature: null });
    expect("hint" in none && none.hint).toContain("Open a feature");
  });
});

describe("AiSessionFields", () => {
  const enabled = { enabled: true, hint: null };

  test("keeps the session dialog's title, name, Run in group, and confirm label", () => {
    const markup = html(<AiSessionFields dialog={aiDialog} state={enabled} onConfirm={noop} onCancel={noop} />);
    expect(markup).toContain("<h3>Name the session</h3>");
    expect(markup).toContain('value="Session 2026-09-08 09:15:00 PDT"');
    expect(markup).toContain("<legend>Run in</legend>");
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toMatch(/<input type="radio"[^>]*checked=""[^>]*value="pane"/);
    expect(submit(markup)![2]).toBe("Start AI Session");
    expect(submit(markup)![1]).not.toContain("disabled");
  });

  test("the clipboard choice relabels the button; no agent means no group and Copy prompt", () => {
    const clip = html(
      <AiSessionFields dialog={{ ...aiDialog, initialChoice: "clipboard" }} state={enabled} onConfirm={noop} onCancel={noop} />,
    );
    expect(submit(clip)![2]).toBe("Copy prompt");
    const none = html(
      <AiSessionFields
        dialog={{ ...aiDialog, choices: undefined, choicesLabel: undefined, confirmLabel: "Copy prompt" }}
        state={enabled}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(none).not.toContain('role="radiogroup"');
    expect(submit(none)![2]).toBe("Copy prompt");
  });

  test("when off, says why and disables the field and the button", () => {
    const off = aiTabState({ codeGen: false, specCount: 0, sessionRunning: false });
    const markup = html(<AiSessionFields dialog={aiDialog} state={off} onConfirm={noop} onCancel={noop} />);
    expect(markup).toContain("Code generation is switched off in Settings.");
    expect(markup).toMatch(/<input[^>]*aria-label="Session name"[^>]*disabled=""/);
    expect(submit(markup)![1]).toContain("disabled");
  });
});

describe("StartSessionDialog", () => {
  test("is the AI session's dialog alone — no tabs, no Pomodoro", () => {
    const ai = { dialog: aiDialog, state: aiTabState({ codeGen: true, specCount: 0, sessionRunning: false }), onConfirm: noop };
    const markup = html(<StartSessionDialog ai={ai} onClose={noop} />);
    expect(markup).toContain('aria-label="Name the session"');
    expect(markup).toContain("Select a spec in the sidebar");
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain("Pomodoro");
  });
});

describe("sessionSelection", () => {
  const none = { checked: [], treePicks: [], openFeature: null, openScenario: null };
  const row = (name: string, version = 1) => ({ name, version, status: "proposed" as const });

  test("nothing checked, picked or open is nothing, so the Start session button is off", () => {
    expect(sessionSelection(none)).toEqual([]);
  });

  test("the open feature runs whole", () => {
    expect(sessionSelection({ ...none, openFeature: "a.feature.md" })).toEqual([{ fileName: "a.feature.md" }]);
  });

  test("the open scenario runs alone", () => {
    expect(sessionSelection({ ...none, openFeature: "a.feature.md", openScenario: row("Blocked") })).toEqual([
      { fileName: "a.feature.md", scenarios: [{ name: "Blocked", version: 1 }] },
    ]);
  });

  test("scenarios picked in the tree win over the open one, grouped by feature", () => {
    const treePicks = [
      { file: "a.feature.md", row: row("One") },
      { file: "a.feature.md", row: row("Two", 2) },
      { file: "b.feature.md", row: row("Three") },
    ];
    expect(sessionSelection({ ...none, treePicks, openFeature: "a.feature.md", openScenario: row("Other") })).toEqual([
      { fileName: "a.feature.md", scenarios: [{ name: "One", version: 1 }, { name: "Two", version: 2 }] },
      { fileName: "b.feature.md", scenarios: [{ name: "Three", version: 1 }] },
    ]);
  });

  test("specs checked for a session win over everything else", () => {
    const checked = [{ fileName: "c.feature.md" }];
    expect(
      sessionSelection({ checked, treePicks: [{ file: "a.feature.md", row: row("One") }], openFeature: "a.feature.md", openScenario: null }),
    ).toBe(checked);
  });
});

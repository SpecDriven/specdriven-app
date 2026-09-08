// The Start session dialog (src/frontend/StartSessionDialog.tsx): one dialog
// for an AI session or a Pomodoro. The AI tab keeps the old dialog's words
// and gating (specs/launch-ai-agent-session.feature.md); the Pomodoro tab
// is open to anyone, whatever is selected and whether or not code
// generation is on. Static markup only — bun test has no DOM.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AiSessionFields,
  PomodoroFields,
  StartSessionDialog,
  StartSessionTabs,
  aiTabState,
  formOf,
  parsePomodoroForm,
} from "../src/frontend/StartSessionDialog";
import { DEFAULT_PREFS } from "../src/frontend/pomodoro";
import type { PromptOptions } from "../src/frontend/ModalPrompts";

const noop = () => undefined;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const tabs = (markup: string) =>
  [...markup.matchAll(/<button[^>]*role="tab"[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/button>/g)].map((m) => m[1]);
const selected = (markup: string) =>
  markup.match(/<button[^>]*aria-selected="true"[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/button>/)?.[1];
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

describe("StartSessionTabs", () => {
  test("is a tablist of the two kinds with the current one selected", () => {
    const markup = html(<StartSessionTabs tab="pomodoro" onChange={noop} />);
    expect(markup).toContain('role="tablist"');
    expect(tabs(markup)).toEqual(["AI session", "Pomodoro"]);
    expect(selected(markup)).toBe("Pomodoro");
    expect(selected(html(<StartSessionTabs tab="ai" onChange={noop} />))).toBe("AI session");
  });
});

describe("aiTabState", () => {
  test("is the old button's gating, each reason in words", () => {
    expect(aiTabState({ codeGen: true, specCount: 2, sessionRunning: false })).toEqual({ enabled: true, hint: null });
    expect(aiTabState({ codeGen: false, specCount: 2, sessionRunning: false }).hint).toContain("Code generation");
    expect(aiTabState({ codeGen: true, specCount: 0, sessionRunning: false }).hint).toContain("Select a spec");
    expect(aiTabState({ codeGen: true, specCount: 1, sessionRunning: true }).hint).toContain("already starting");
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

describe("PomodoroFields", () => {
  const props = { prefs: DEFAULT_PREFS, running: false, initialName: "Session 2026-09-08 09:15:00 PDT", onConfirm: noop, onPreview: noop, onEnd: noop, onCancel: noop };

  test("offers the name, the four lengths, the sounds with a preview, the tick, and Start Pomodoro", () => {
    const markup = html(<PomodoroFields {...props} />);
    expect(markup).toContain("<h3>Start a Pomodoro</h3>");
    expect(markup).toContain('value="Session 2026-09-08 09:15:00 PDT"');
    const numbers = [...markup.matchAll(/<input type="number"[^>]*aria-label="([^"]*)"[^>]*value="(\d+)"/g)].map((m) => [m[1], m[2]]);
    expect(numbers).toEqual([
      ["Focus minutes", "25"],
      ["Short break minutes", "5"],
      ["Long break minutes", "15"],
      ["Pomodoros between long breaks", "4"],
    ]);
    expect([...markup.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual(["bell", "chime", "ding", "woodblock", "none"]);
    expect(markup).toMatch(/<option value="bell"[^>]*selected=""/);
    expect(markup).toContain('aria-label="Preview sound"');
    expect(markup).toContain('role="switch"');
    expect(submit(markup)![2]).toBe("Start Pomodoro");
    expect(submit(markup)![1]).not.toContain("disabled");
  });

  test("shows the stored preferences, and no preview for silence", () => {
    const markup = html(<PomodoroFields {...props} prefs={{ ...DEFAULT_PREFS, workMinutes: 50, sound: "none", tick: true }} />);
    expect(markup).toMatch(/aria-label="Focus minutes"[^>]*value="50"/);
    expect(markup).toMatch(/<option value="none"[^>]*selected=""/);
    expect(markup).toMatch(/<button[^>]*aria-label="Preview sound"[^>]*disabled=""/);
    expect(markup).toMatch(/role="switch"[^>]*checked=""/);
  });

  test("with a session running, offers to end it instead", () => {
    const markup = html(<PomodoroFields {...props} running />);
    expect(markup).toContain("A Pomodoro session is running");
    expect(markup).toContain("End session");
    expect(markup).not.toContain("Start Pomodoro");
    expect(markup).not.toContain('type="number"');
  });

  test("the form's text becomes clamped preferences", () => {
    const form = { ...formOf(DEFAULT_PREFS), workMinutes: "999", shortBreakMinutes: "", longBreakEvery: "0", sound: "siren" as never, tick: true };
    expect(parsePomodoroForm(form, DEFAULT_PREFS)).toEqual({ ...DEFAULT_PREFS, workMinutes: 180, shortBreakMinutes: 5, longBreakEvery: 1, tick: true });
    expect(formOf({ ...DEFAULT_PREFS, longBreakMinutes: 20 }).longBreakMinutes).toBe("20");
  });
});

describe("StartSessionDialog", () => {
  test("opens on the asked-for tab and names itself after it", () => {
    const ai = { dialog: aiDialog, state: aiTabState({ codeGen: true, specCount: 0, sessionRunning: false }), onConfirm: noop };
    const pomodoro = { prefs: DEFAULT_PREFS, running: false, initialName: "s", onConfirm: noop, onPreview: noop, onEnd: noop };
    const onAi = html(<StartSessionDialog initialTab="ai" ai={ai} pomodoro={pomodoro} onClose={noop} />);
    expect(onAi).toContain('aria-label="Name the session"');
    expect(selected(onAi)).toBe("AI session");
    expect(onAi).toContain("Select a spec in the sidebar");
    const onPomodoro = html(<StartSessionDialog initialTab="pomodoro" ai={ai} pomodoro={pomodoro} onClose={noop} />);
    expect(onPomodoro).toContain('aria-label="Start a Pomodoro"');
    expect(selected(onPomodoro)).toBe("Pomodoro");
    // Nothing selected and still startable.
    expect(submit(onPomodoro)![1]).not.toContain("disabled");
  });
});

// Automates specs/agents/claude.feature.md "Create and name a code gen
// session" and specs/launch-ai-agent-session.feature.md step 8: the session
// dialog opens on a timestamp name, and — with more than one agent installed
// — a "Run in" choice between Claude Code Desktop and the coding agent pane,
// preselected from the remembered choice.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultSessionName } from "../src/frontend/App";
import { codeGenTargetLabel, readCodeGenTarget, resolveCodeGenTarget } from "../src/frontend/codeGenTarget";
import { PromptChoices, confirmLabelOf, initialChoiceOf } from "../src/frontend/ModalPrompts";
import { CLAUDE_AGENT, agentsWith } from "./fixtures/agents";

describe("defaultSessionName", () => {
  test("is Session, the local date and time, and the zone's short name", () => {
    const date = new Date(2026, 8, 4, 15, 30, 30);
    const name = defaultSessionName(date);
    expect(name.startsWith("Session 2026-09-04 15:30:30 ")).toBe(true);
    const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")!.value;
    expect(name).toBe(`Session 2026-09-04 15:30:30 ${zone}`);
  });

  test("zero-pads every part", () => {
    expect(defaultSessionName(new Date(2026, 0, 5, 7, 8, 9))).toMatch(
      /^Session 2026-01-05 07:08:09 \S+$/,
    );
  });
});

describe("resolveCodeGenTarget", () => {
  // The agents as /api/state reports them, with the named CLIs found.
  const all = agentsWith("claude", "codex", "pi");
  const claude = agentsWith("claude");
  const none = agentsWith();

  test("keeps the remembered choice while it is usable", () => {
    expect(resolveCodeGenTarget("desktop", true, none)).toBe("desktop");
    expect(resolveCodeGenTarget("claude", true, claude)).toBe("claude");
  });

  test("falls back on whether Claude.app is installed", () => {
    expect(resolveCodeGenTarget(null, true, none)).toBe("desktop");
    expect(resolveCodeGenTarget("nope", true, none)).toBe("desktop");
    expect(resolveCodeGenTarget("desktop", false, claude)).toBe("claude");
    // Nothing installed: desktop stands in, and the server says what is
    // missing — the dialog does not open on it.
    expect(resolveCodeGenTarget(null, false, none)).toBe("desktop");
    expect(resolveCodeGenTarget("claude", false, none)).toBe("desktop");
  });

  test("the pane is a target too, and the fallback when only the CLI is there", () => {
    expect(resolveCodeGenTarget("claude", true, claude)).toBe("claude");
    expect(resolveCodeGenTarget("claude", true, none)).toBe("desktop");
    expect(resolveCodeGenTarget(null, false, claude)).toBe("claude");
    expect(resolveCodeGenTarget("desktop", false, claude)).toBe("claude");
  });

  // The headless `claude -p` target is gone: only the desktop app and the
  // coding agent pane, with whichever agent plugin is there, run a session.
  test("reads only the known targets off the state", () => {
    expect(readCodeGenTarget("desktop", all)).toBe("desktop");
    expect(readCodeGenTarget("claude", all)).toBe("claude");
    expect(readCodeGenTarget("pi", all)).toBe("pi");
    expect(readCodeGenTarget("codex", all)).toBe("codex");
    // Only agents the plugins supply are targets; Pi's CLI being absent is resolve's business.
    expect(readCodeGenTarget("pi", claude)).toBe("pi");
    expect(readCodeGenTarget("pi", [CLAUDE_AGENT])).toBeNull();
    expect(readCodeGenTarget("cli", all)).toBeNull();
    expect(readCodeGenTarget(null, all)).toBeNull();
    expect(readCodeGenTarget("x", all)).toBeNull();
  });

  // The agents are picked by rank: a remembered one is kept while its CLI
  // is there, and an unchosen dialog opens on the first usable one — Claude
  // before Codex before Pi, and never on one whose CLI is gone.
  test("an unchosen dialog opens on the first usable agent by rank", () => {
    expect(codeGenTargetLabel("pi", all)).toBe("Pi in the coding agent pane");
    expect(codeGenTargetLabel("codex", all)).toBe("Codex in the coding agent pane");
    expect(codeGenTargetLabel("desktop", all)).toBe("Claude Code Desktop");
    expect(resolveCodeGenTarget("pi", false, agentsWith("pi"))).toBe("pi");
    expect(resolveCodeGenTarget("pi", true, all)).toBe("pi");
    expect(resolveCodeGenTarget("pi", true, agentsWith("claude", "codex"))).toBe("desktop");
    expect(resolveCodeGenTarget(null, true, all)).toBe("desktop");
    expect(resolveCodeGenTarget(null, false, all)).toBe("claude");
    expect(resolveCodeGenTarget(null, false, agentsWith("codex", "pi"))).toBe("codex");
    expect(resolveCodeGenTarget(null, false, agentsWith("pi"))).toBe("pi");
    expect(resolveCodeGenTarget("codex", false, agentsWith("codex"))).toBe("codex");
    expect(resolveCodeGenTarget("codex", true, agentsWith("claude", "pi"))).toBe("desktop");
  });
});

describe("PromptChoices", () => {
  const all = agentsWith("claude");
  const choices = [
    { value: "desktop", label: codeGenTargetLabel("desktop", all), hint: "Opens the Claude app" },
    { value: "claude", label: codeGenTargetLabel("claude", all), hint: "Chats with Claude here" },
  ];

  test("renders one radio per choice with the picked one checked", () => {
    const html = renderToStaticMarkup(
      <PromptChoices label="Run in" choices={choices} value="claude" onChange={() => {}} />,
    );
    expect(html).toContain("<legend>Run in</legend>");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toMatch(
      /<input[^>]*checked=""[^>]*value="claude"|<input[^>]*value="claude"[^>]*checked=""/,
    );
    expect(html).toContain("Claude Code Desktop");
    expect(html).toContain("Opens the Claude app");
    expect(html).toContain('role="radiogroup"');
  });

  test("the dialog starts on the remembered choice, or the first one", () => {
    expect(initialChoiceOf({ title: "t", choices, initialChoice: "claude" })).toBe("claude");
    expect(initialChoiceOf({ title: "t", choices, initialChoice: "nope" })).toBe("desktop");
    expect(initialChoiceOf({ title: "t", choices })).toBe("desktop");
    expect(initialChoiceOf({ title: "t" })).toBeNull();
  });
});

// "Copy prompt to clipboard" (the dialog's top option) does something other
// than start a session, so the confirm button says so while it is picked.
describe("confirmLabelOf", () => {
  const choices = [
    { value: "clipboard", label: "Copy prompt to clipboard", confirmLabel: "Copy prompt" },
    { value: "desktop", label: codeGenTargetLabel("desktop", []) },
  ];

  test("is the picked choice's own label, else the dialog's", () => {
    const opts = { title: "t", confirmLabel: "Start AI Session", choices };
    expect(confirmLabelOf(opts, "clipboard")).toBe("Copy prompt");
    expect(confirmLabelOf(opts, "desktop")).toBe("Start AI Session");
    expect(confirmLabelOf({ title: "t", confirmLabel: "Start AI Session" }, null)).toBe(
      "Start AI Session",
    );
    expect(confirmLabelOf({ title: "t" }, null)).toBe("OK");
  });
});

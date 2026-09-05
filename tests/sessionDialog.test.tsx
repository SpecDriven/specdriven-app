// Automates specs/agents/claude.feature.md "Create and name a code gen
// session" and specs/launch-ai-agent-session.feature.md step 8: the session
// dialog opens on a timestamp name, and — with more than one agent installed
// — a "Run in" choice between Claude Code Desktop and the coding agent pane,
// preselected from the remembered choice.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CODE_GEN_TARGET_LABEL,
  defaultSessionName,
  readCodeGenTarget,
  resolveCodeGenTarget,
} from "../src/frontend/App";
import { PromptChoices, initialChoiceOf } from "../src/frontend/ModalPrompts";

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
  test("keeps the remembered choice while it is usable", () => {
    expect(resolveCodeGenTarget("desktop", true)).toBe("desktop");
    expect(resolveCodeGenTarget("pane", true, true)).toBe("pane");
  });

  test("falls back on whether Claude.app is installed", () => {
    expect(resolveCodeGenTarget(null, true)).toBe("desktop");
    expect(resolveCodeGenTarget("nope", true)).toBe("desktop");
    expect(resolveCodeGenTarget("desktop", false, true)).toBe("pane");
    // Nothing installed: desktop stands in, and the server says what is
    // missing — the dialog does not open on it.
    expect(resolveCodeGenTarget(null, false)).toBe("desktop");
    expect(resolveCodeGenTarget("pane", false)).toBe("desktop");
  });

  test("the pane is a target too, and the fallback when only the CLI is there", () => {
    expect(resolveCodeGenTarget("pane", true, true)).toBe("pane");
    expect(resolveCodeGenTarget("pane", true, false)).toBe("desktop");
    expect(resolveCodeGenTarget(null, false, true)).toBe("pane");
    expect(resolveCodeGenTarget("desktop", false, true)).toBe("pane");
  });

  // The headless `claude -p` target is gone: only the desktop app and the
  // coding agent pane (with Claude or Pi) run a session.
  test("reads only the known targets off the state", () => {
    expect(readCodeGenTarget("desktop")).toBe("desktop");
    expect(readCodeGenTarget("pane")).toBe("pane");
    expect(readCodeGenTarget("pi")).toBe("pi");
    expect(readCodeGenTarget("cli")).toBeNull();
    expect(readCodeGenTarget(null)).toBeNull();
    expect(readCodeGenTarget("x")).toBeNull();
  });

  // Pi (specs/agents/integration-with-pi-dev-agent.feature.md): a choice of
  // agent, kept when it was the last one picked and pi is still on PATH —
  // but never what an unchosen dialog falls back to.
  test("Pi is remembered when its CLI is there, and is never the fallback", () => {
    expect(CODE_GEN_TARGET_LABEL.pi).toBe("Pi in the coding agent pane");
    expect(resolveCodeGenTarget("pi", false, false, true)).toBe("pi");
    expect(resolveCodeGenTarget("pi", true, true, true)).toBe("pi");
    expect(resolveCodeGenTarget("pi", true, true, false)).toBe("desktop");
    expect(resolveCodeGenTarget(null, true, true, true)).toBe("desktop");
    expect(resolveCodeGenTarget(null, false, true, true)).toBe("pane");
    // Only where there is no Claude at all does an unchosen dialog open on Pi.
    expect(resolveCodeGenTarget(null, false, false, true)).toBe("pi");
  });
});

describe("PromptChoices", () => {
  const choices = [
    { value: "desktop", label: CODE_GEN_TARGET_LABEL.desktop, hint: "Opens the Claude app" },
    { value: "pane", label: CODE_GEN_TARGET_LABEL.pane, hint: "Chats with Claude here" },
  ];

  test("renders one radio per choice with the picked one checked", () => {
    const html = renderToStaticMarkup(
      <PromptChoices label="Run in" choices={choices} value="pane" onChange={() => {}} />,
    );
    expect(html).toContain("<legend>Run in</legend>");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toMatch(
      /<input[^>]*checked=""[^>]*value="pane"|<input[^>]*value="pane"[^>]*checked=""/,
    );
    expect(html).toContain("Claude Code Desktop");
    expect(html).toContain("Opens the Claude app");
    expect(html).toContain('role="radiogroup"');
  });

  test("the dialog starts on the remembered choice, or the first one", () => {
    expect(initialChoiceOf({ title: "t", choices, initialChoice: "pane" })).toBe("pane");
    expect(initialChoiceOf({ title: "t", choices, initialChoice: "nope" })).toBe("desktop");
    expect(initialChoiceOf({ title: "t", choices })).toBe("desktop");
    expect(initialChoiceOf({ title: "t" })).toBeNull();
  });
});

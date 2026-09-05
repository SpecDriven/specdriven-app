// Automates specs/agents/claude.feature.md "Create and name a code gen
// session" and specs/launch-ai-agent-session.feature.md step 8: the session
// dialog opens on a timestamp name, and — with Claude.app installed — a "Run
// in" choice between Claude Code Desktop and the headless CLI, preselected
// from the remembered choice.
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
    expect(resolveCodeGenTarget("cli", true)).toBe("cli");
    expect(resolveCodeGenTarget("cli", false)).toBe("cli");
    expect(resolveCodeGenTarget("desktop", true)).toBe("desktop");
  });

  test("falls back on whether Claude.app is installed", () => {
    expect(resolveCodeGenTarget(null, true)).toBe("desktop");
    expect(resolveCodeGenTarget(null, false)).toBe("cli");
    expect(resolveCodeGenTarget("desktop", false)).toBe("cli");
    expect(resolveCodeGenTarget("nope", true)).toBe("desktop");
  });

  test("reads only the two known targets off the state", () => {
    expect(readCodeGenTarget("desktop")).toBe("desktop");
    expect(readCodeGenTarget("cli")).toBe("cli");
    expect(readCodeGenTarget(null)).toBeNull();
    expect(readCodeGenTarget("x")).toBeNull();
  });
});

describe("PromptChoices", () => {
  const choices = [
    { value: "desktop", label: CODE_GEN_TARGET_LABEL.desktop, hint: "Opens the Claude app" },
    { value: "cli", label: CODE_GEN_TARGET_LABEL.cli, hint: "Runs claude -p here" },
  ];

  test("renders one radio per choice with the picked one checked", () => {
    const html = renderToStaticMarkup(
      <PromptChoices label="Run in" choices={choices} value="cli" onChange={() => {}} />,
    );
    expect(html).toContain("<legend>Run in</legend>");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="cli"|<input[^>]*value="cli"[^>]*checked=""/);
    expect(html).toContain("Claude Code Desktop");
    expect(html).toContain("Opens the Claude app");
    expect(html).toContain('role="radiogroup"');
  });

  test("the dialog starts on the remembered choice, or the first one", () => {
    expect(initialChoiceOf({ title: "t", choices, initialChoice: "cli" })).toBe("cli");
    expect(initialChoiceOf({ title: "t", choices, initialChoice: "nope" })).toBe("desktop");
    expect(initialChoiceOf({ title: "t", choices })).toBe("desktop");
    expect(initialChoiceOf({ title: "t" })).toBeNull();
  });
});

// Automates specs/agents/agent-pane.feature.md on the client: the
// transcript is a reduction of the server's events, the "/" popup filters
// the session's commands, the pane's width stays within bounds, and the
// rows render what a reader needs. Pure helpers and static markup — no DOM.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentPane,
  MODE_LABEL,
  STATUS_LABEL,
  SimulationWatermark,
  TranscriptRow,
  effortItems,
  effortsFor,
  folderItems,
  folderPath,
  knownFolders,
  modeItems,
  modelItems,
  modelLabel,
  nameFromMessage,
} from "../src/frontend/AgentPane";
import {
  EMPTY_TRANSCRIPT,
  agentChat,
  applyCommand,
  applyEvent,
  clampAgentWidth,
  filterCommands,
  formatCost,
  formatDuration,
  shouldFollow,
  toolSummary,
} from "../src/frontend/agentChat";
import type { AgentChoices, ChatEvent, TranscriptItem } from "../src/frontend/agentChat";
import { codeGenTargetLabel, readCodeGenTarget, resolveCodeGenTarget } from "../src/frontend/codeGenTarget";
import { CLAUDE_AGENT, CODEX_AGENT, PI_AGENT, agentsWith } from "./fixtures/agents";

let seq = 0;
// Omit over the event union would keep only the shared keys; the bodies
// are typed loosely here and stamped with a sequence number.
const ev = (body: object, at = "2026-09-04T10:00:00.000Z"): ChatEvent =>
  ({ ...body, seq: ++seq, at }) as ChatEvent;

function reduce(events: ChatEvent[]) {
  return events.reduce(applyEvent, EMPTY_TRANSCRIPT);
}

describe("applyEvent", () => {
  test("streams an assistant reply, then keeps the final text", () => {
    const t = reduce([
      ev({ kind: "user", id: "u1", text: "hi" }),
      ev({ kind: "text_delta", messageId: "m1", index: 0, text: "Hel" }),
      ev({ kind: "text_delta", messageId: "m1", index: 0, text: "lo" }),
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(t.items[1]).toMatchObject({ text: "Hello", streaming: true });
    const done = applyEvent(
      t,
      ev({
        kind: "assistant",
        messageId: "m1",
        turn: 1,
        blocks: [
          { type: "text", text: "Hello!" },
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls -la" } },
        ],
        parentToolUseId: null,
      }),
    );
    expect(done.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect(done.items[1]).toMatchObject({ text: "Hello!", streaming: false });
    expect(done.items[2]).toMatchObject({ name: "Bash", summary: "ls -la" });
    const withResult = applyEvent(
      done,
      ev({ kind: "tool_result", toolUseId: "tu1", content: "a\nb", isError: false, parentToolUseId: null }),
    );
    expect(withResult.items[2]).toMatchObject({ result: { content: "a\nb", isError: false } });
    expect(withResult.items).toHaveLength(3);
    expect(withResult.lastSeq).toBe(seq);
  });

  test("a result that arrives before its tool call still pairs up", () => {
    const t = reduce([
      ev({ kind: "tool_result", toolUseId: "tu9", content: "out", isError: true, parentToolUseId: null }),
      ev({
        kind: "assistant",
        messageId: "m2",
        turn: 1,
        blocks: [{ type: "tool_use", id: "tu9", name: "Read", input: { file_path: "/x/y.ts" } }],
        parentToolUseId: null,
      }),
    ]);
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({
      kind: "tool",
      name: "Read",
      summary: "/x/y.ts",
      result: { content: "out", isError: true },
    });
  });

  test("a turn's result ends the streaming and records the cost", () => {
    const t = reduce([
      ev({ kind: "text_delta", messageId: "m3", index: 0, text: "partial" }),
      ev({ kind: "result", turn: 1, subtype: "success", isError: false, costUsd: 0.02, durationMs: 900, numTurns: 1, denials: 0 }),
    ]);
    expect(t.items[0]).toMatchObject({ kind: "assistant", text: "partial", streaming: false });
    expect(t.items[1]).toMatchObject({ kind: "result", costUsd: 0.02, durationMs: 900 });
  });

  test("a failed turn keeps why it failed even when the reply already said it", () => {
    // Claude Code's sign-in failure is both the reply and the result: the
    // footer does not repeat it, but the sign-in hint still reads it
    // (specs/agents/claude.feature.md "Sign in to Claude without Claude Code installed").
    const why = "Not logged in · Please run /login";
    const t = reduce([
      ev({ kind: "text_delta", messageId: "m4", index: 0, text: why }),
      ev({ kind: "result", turn: 1, subtype: "success", isError: true, costUsd: 0, durationMs: 50, numTurns: 1, denials: 0, text: why }),
    ]);
    expect(t.items[1]).toMatchObject({ kind: "result", isError: true, failure: why });
    expect((t.items[1] as { text?: string }).text).toBeUndefined();
    // A turn that went fine records no failure.
    const fine = reduce([ev({ kind: "result", turn: 1, subtype: "success", isError: false, costUsd: 0, durationMs: 50, numTurns: 1, denials: 0, text: "ok" })]);
    expect((fine.items[0] as { failure?: string }).failure).toBeUndefined();
  });

  test("permission requests become cards that resolve in place", () => {
    const t = reduce([
      ev({
        kind: "permission_request",
        requestId: "r1",
        toolName: "Bash",
        input: { command: "rm x" },
        suggestions: [{ type: "addRules" }],
      }),
      ev({
        kind: "permission_request",
        requestId: "r2",
        toolName: "AskUserQuestion",
        input: {
          questions: [
            { question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }], multiSelect: false },
          ],
        },
        suggestions: [],
      }),
      ev({ kind: "permission_resolved", requestId: "r1", behavior: "allow", via: "user" }),
    ]);
    expect(t.items[0]).toMatchObject({
      kind: "permission",
      summary: "rm x",
      suggestions: [{ type: "addRules" }],
      resolved: { behavior: "allow", via: "user" },
    });
    expect(t.items[1]).toMatchObject({ kind: "question", requestId: "r2" });
    expect((t.items[1] as { questions: unknown[] }).questions).toHaveLength(1);
  });

  test("an event seen before changes nothing", () => {
    const first = ev({ kind: "note", level: "info", code: "init", text: "up" });
    const t = applyEvent(EMPTY_TRANSCRIPT, first);
    expect(applyEvent(t, first)).toBe(t);
    expect(applyEvent(t, { ...first, seq: first.seq - 1 })).toBe(t);
  });
});

describe("toolSummary", () => {
  test("names the one thing each tool is about", () => {
    expect(toolSummary("Bash", { command: "bun test", description: "Run tests" })).toBe("bun test");
    expect(toolSummary("Edit", { file_path: "src/a.ts", old_string: "x" })).toBe("src/a.ts");
    expect(toolSummary("Grep", { pattern: "TODO", path: "." })).toBe("TODO");
    expect(toolSummary("WebFetch", { url: "https://x.y", prompt: "p" })).toBe("https://x.y");
    expect(toolSummary("Task", { description: "explore", prompt: "long" })).toBe("explore");
    expect(toolSummary("mcp__foo__bar", { first: "", second: "value" })).toBe("value");
    expect(toolSummary("Nothing", null)).toBe("");
  });
});

describe("filterCommands", () => {
  const commands = [
    { name: "review", description: "Review code", argumentHint: "[files]" },
    { name: "preview", description: "Preview", argumentHint: "" },
    { name: "compact", description: "Compact", argumentHint: "" },
  ];

  test("opens only while the caret is in a leading slash word", () => {
    expect(filterCommands(commands, "hello", 5).active).toBe(false);
    expect(filterCommands(commands, "/rev", 4).active).toBe(true);
    expect(filterCommands(commands, "/review src", 11).active).toBe(false);
    expect(filterCommands(commands, "/review src", 3).active).toBe(true);
  });

  test("ranks names that start with the text above names that contain it", () => {
    expect(filterCommands(commands, "/rev", 4).items.map((c) => c.name)).toEqual(["review", "preview"]);
    expect(filterCommands(commands, "/", 1).items.map((c) => c.name)).toEqual(["compact", "preview", "review"]);
    expect(filterCommands(commands, "/zzz", 4).items).toEqual([]);
  });

  test("caps the list and fills in the picked command", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, description: "", argumentHint: "" }));
    expect(filterCommands(many, "/c", 2).items).toHaveLength(8);
    expect(applyCommand(commands[0]!)).toBe("/review ");
  });
});

describe("geometry", () => {
  test("the pane stays between its minimum and 60% of the window", () => {
    expect(clampAgentWidth(100, 1280)).toBe(420);
    expect(clampAgentWidth(500, 1280)).toBe(500);
    expect(clampAgentWidth(2000, 1280)).toBe(768);
    expect(clampAgentWidth(500, 400)).toBe(420);
  });

  test("the transcript follows new output only near its bottom", () => {
    expect(shouldFollow(0, 1000, 500)).toBe(false);
    expect(shouldFollow(500, 1000, 500)).toBe(true);
    expect(shouldFollow(460, 1000, 500)).toBe(true);
    expect(shouldFollow(440, 1000, 500)).toBe(false);
  });

  test("costs and durations read at a glance", () => {
    expect(formatCost(null)).toBe("");
    expect(formatCost(0.0123)).toBe("$0.01");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatDuration(500)).toBe("500 ms");
    expect(formatDuration(1234)).toBe("1.2 s");
  });
});

describe("Start session targets with the pane", () => {
  test("the pane is a target, and the fallback when only the CLI is there", () => {
    const claude = agentsWith("claude");
    const none = agentsWith();
    expect(codeGenTargetLabel("claude", claude)).toBe("Claude in the coding agent pane");
    expect(resolveCodeGenTarget("claude", true, claude)).toBe("claude");
    expect(resolveCodeGenTarget("claude", true, none)).toBe("desktop");
    expect(resolveCodeGenTarget(null, false, claude)).toBe("claude");
    expect(resolveCodeGenTarget(null, true, claude)).toBe("desktop");
    expect(resolveCodeGenTarget("desktop", false, claude)).toBe("claude");
  });
});

describe("TranscriptRow", () => {
  const at = "2026-09-04T10:00:00.000Z";
  // Rows render for an agent; the fixture is Claude's descriptor, as the
  // pane reads it off /api/state (specs/agents/agent-plugins.feature.md).
  const row = (item: TranscriptItem, agent = CLAUDE_AGENT) =>
    renderToStaticMarkup(<TranscriptRow item={item} agent={agent} />);

  test("a tool call shows its name, its subject, and how it went", () => {
    const html = row({
      kind: "tool",
      id: "t:1",
      name: "Bash",
      input: { command: "ls" },
      summary: "ls",
      result: { content: "a.txt", isError: false },
      at,
    });
    expect(html).toContain("<details");
    expect(html).toContain("Bash");
    expect(html).toContain(">ls<");
    expect(html).toContain("done");
    expect(html).toContain("a.txt");
  });

  test("a permission card offers Allow always only with a rule to keep", () => {
    const base = {
      kind: "permission" as const,
      id: "p:1",
      requestId: "r1",
      toolName: "Write",
      input: { file_path: "x" },
      summary: "x",
      at,
    };
    const plain = row({ ...base, suggestions: [] });
    expect(plain).toContain("Claude wants to use Write");
    expect(plain).toContain("Allow once");
    expect(plain).toContain("Deny…");
    expect(plain).not.toContain("Allow always");
    expect(row({ ...base, suggestions: [{ type: "addRules" }] })).toContain("Allow always");
    const resolved = row({ ...base, suggestions: [], resolved: { behavior: "deny", via: "interrupt" } });
    expect(resolved).toContain("Denied (stopped)");
    expect(resolved).not.toContain("Allow once");
  });

  test("a question card lists the options and a way to send answers", () => {
    const html = row({
      kind: "question",
      id: "p:2",
      requestId: "r2",
      questions: [
        {
          question: "Which format?",
          header: "Format",
          options: [
            { label: "Summary", description: "short" },
            { label: "Detailed", description: "long" },
          ],
          multiSelect: false,
        },
      ],
      at,
    });
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain("Which format?");
    expect(html).toContain("Send answers");
    expect(html).toContain("Skip");
  });

  test("a failed turn says why, and how to sign in when that is why", () => {
    const html = row({
      kind: "result",
      id: "r:1",
      subtype: "success",
      isError: true,
      costUsd: 0,
      durationMs: 300,
      numTurns: 1,
      text: "Not logged in · Please run /login",
      at,
    });
    expect(html).toContain("Turn failed");
    expect(html).toContain("claude auth login");
    // The reply already said why, so the footer carries only `failure`.
    const repeated = row({ kind: "result", id: "r:3", subtype: "success", isError: true, costUsd: 0, durationMs: 50, numTurns: 1, failure: "Not logged in · Please run /login", at });
    expect(repeated).toContain("claude auth login");
    expect(repeated).not.toContain("Please run /login");
    const fine = row({ kind: "result", id: "r:2", subtype: "success", isError: false, costUsd: 0.5, durationMs: 2000, numTurns: 3, at });
    expect(fine).toContain("Turn done");
    expect(fine).toContain("$0.50");
    expect(fine).toContain("2.0 s");
  });

  test("user text is shown as typed, and markdown in replies is rendered", () => {
    expect(row({ kind: "user", id: "u:1", text: "<b>hi</b>", at })).toContain("&lt;b&gt;hi&lt;/b&gt;");
    const reply = row({
      kind: "assistant",
      id: "a:1",
      text: "**bold** done",
      streaming: true,
      streamText: "",
      finalParts: ["**bold** done"],
      at,
    });
    expect(reply).toContain("<strong>bold</strong>");
    expect(reply).toContain("agent-caret");
  });

  test("labels cover every status and mode", () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(
      ["awaiting_input", "ended", "error", "idle", "running", "starting"].sort(),
    );
    expect(Object.keys(MODE_LABEL).sort()).toEqual(["acceptEdits", "auto", "bypassPermissions", "default", "plan"]);
  });

  test("the folder menu offers the code repo, the data repo, then folders sessions used", () => {
    const meta = (cwd: string, startedAt: string) => ({ cwd, startedAt }) as never;
    const folders = knownFolders("/w/code", "/w/data", [
      meta("/w/old", "2026-10-01T00:00:00Z"),
      meta("/w/code", "2026-10-02T00:00:00Z"),
      meta("/w/new", "2026-10-03T00:00:00Z"),
    ]);
    expect(folders).toEqual(["/w/code", "/w/data", "/w/new", "/w/old"]);
    expect(knownFolders(null, "/w/data", [])).toEqual(["/w/data"]);
    // Every code repo the project names comes after the default, before the data repo.
    expect(knownFolders("/w/code", "/w/data", [], ["/w/code", "/w/mobile"])).toEqual([
      "/w/code",
      "/w/mobile",
      "/w/data",
    ]);

    const picked: string[] = [];
    const items = folderItems(folders, "/w/data", async () => "/w/typed", (f) => picked.push(f));
    expect(items.map((i) => i.label)).toEqual(["code", "data", "new", "old", "Other folder…"]);
    expect(items.filter((i) => i.checked).map((i) => i.description)).toEqual(["/w/data"]);
    items[2]!.onSelect!();
    expect(picked).toEqual(["/w/new"]);
    // Without a prompt there is no "Other folder…"; an unlisted current folder leads.
    const bare = folderItems(["/w/data"], "/w/x", undefined, () => {});
    expect(bare.map((i) => i.description)).toEqual(["/w/x", "/w/data"]);
  });

  test("a folder typed with a trailing slash is the same folder as its sessions'", () => {
    const meta = (cwd: string, startedAt: string) => ({ cwd, startedAt }) as never;
    const folders = knownFolders("/w/code", "/w/data/", [meta("/w/data", "2026-10-07T00:00:00Z")]);
    expect(folders).toEqual(["/w/code", "/w/data"]);
    const items = folderItems(folders, "/w/data/", undefined, () => {});
    expect(items.map((i) => i.description)).toEqual(["/w/code", "/w/data"]);
    expect(items.filter((i) => i.checked).map((i) => i.description)).toEqual(["/w/data"]);
    expect(folderPath("/")).toBe("/");
    expect(folderPath("C:\\")).toBe("C:\\");
    expect(folderPath("C:\\w\\data\\")).toBe("C:\\w\\data");
  });

  test("the mode menu numbers every mode and badges the agent's default", () => {
    const picked: string[] = [];
    const claude = modeItems(CLAUDE_AGENT, "plan", (m) => picked.push(m));
    expect(claude.map((i) => i.id)).toEqual(["auto", "default", "acceptEdits", "plan", "bypassPermissions"]);
    expect(claude.map((i) => i.keys)).toEqual(["1", "2", "3", "4", "5"]);
    expect(claude.filter((i) => i.checked).map((i) => i.id)).toEqual(["plan"]);
    expect(claude.every((i) => typeof i.description === "string")).toBe(true);
    const label = (items: typeof claude, id: string) =>
      renderToStaticMarkup(<>{items.find((i) => i.id === id)!.label}</>);
    expect(label(claude, "auto")).toContain("Default");
    expect(label(claude, "default")).toBe("Manual");
    const codex = modeItems(CODEX_AGENT, "default", () => {});
    expect(label(codex, "auto")).toBe("Auto");
    expect(label(codex, "default")).toContain("Default");
    // The "auto" line names the agent whose call it is.
    expect(codex.find((i) => i.id === "auto")!.description).toBe("Codex handles permission decisions");
    claude[0]!.onSelect!();
    expect(picked).toEqual(["auto"]);
    // An agent that declares no modes gets no menu at all.
    expect(modeItems(PI_AGENT, "bypassPermissions", () => {})).toEqual([]);
  });
});

// Demo mode (src/server/demoAgent.ts): the pane's agent is a script, and the
// watermark is what a screen recording of it shows. Decorative — the header
// chip carries the same fact for a screen reader — so it is hidden from the
// accessibility tree and must never swallow a click.
describe("SimulationWatermark", () => {
  test("repeats the label, hidden from assistive tech and inert", () => {
    const html = renderToStaticMarkup(<SimulationWatermark />);
    expect(html).toContain("agent-sim-watermark");
    expect(html).toContain("aria-hidden=\"true\"");
    expect(html.match(/Simulation…/g)?.length).toBeGreaterThan(1);
  });
});

// The composer bar (specs/agents/agent-pane.feature.md "The composer bar
// picks the folder, model, effort and mode"): the model and effort menus are
// built from what the agent offers (AgentProvider.choices), and the
// new-session screen is the same message box with the bar under it.
describe("composer bar", () => {
  const choices: AgentChoices = {
    models: [
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
      { value: "haiku", displayName: "Haiku 5.5", efforts: [] },
      { value: "custom-model", displayName: "custom-model" },
    ],
    model: "opus",
    effort: "high",
  };

  test("the model menu lists the agent's models, the running one checked and the default badged", () => {
    const picked: (string | null)[] = [];
    // A session reports the id its alias stands for; the row still matches.
    const items = modelItems(choices, "claude-sonnet-5-5", CLAUDE_AGENT, (m) => picked.push(m));
    expect(items.map((i) => i.id)).toEqual(["model:opus", "model:sonnet", "model:haiku", "model:custom-model"]);
    expect(items.filter((i) => i.checked).map((i) => i.id)).toEqual(["model:sonnet"]);
    expect(items.map((i) => i.keys)).toEqual(["1", "2", "3", "4"]);
    expect(renderToStaticMarkup(<>{items[0]!.label}</>)).toContain("Default");
    expect(items[0]!.description).toBe("Most capable");
    items[2]!.onSelect!();
    expect(picked).toEqual(["haiku"]);
    expect(modelLabel(choices, "claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel(choices, "elsewhere-1")).toBe("elsewhere-1");
    expect(modelLabel(null, undefined)).toBe("Default model");
  });

  test("a model off the list still shows, and with no default the agent's own leads the menu", () => {
    const items = modelItems({ ...choices, model: null }, "elsewhere-1", CLAUDE_AGENT, () => {});
    expect(items.map((i) => i.id).slice(0, 2)).toEqual(["model:default", "model:elsewhere-1"]);
    expect(items.filter((i) => i.checked).map((i) => i.id)).toEqual(["model:elsewhere-1"]);
    expect(items[0]!.description).toBe("Whatever Claude picks on its own");
    const fresh = modelItems({ ...choices, model: null }, null, CLAUDE_AGENT, () => {});
    expect(fresh.filter((i) => i.checked).map((i) => i.id)).toEqual(["model:default"]);
  });

  test("a model's description that only repeats its name is left off, as a proxy's rows carry it", () => {
    const proxy: AgentChoices = {
      models: [{ value: "claude-opus-4-8", displayName: "Opus 4.8 (latest)", description: "Opus 4.8 (latest)" }],
      model: "claude-opus-4-8",
      effort: null,
    };
    const [row] = modelItems(proxy, null, CLAUDE_AGENT, () => {});
    expect(row!.description).toBeUndefined();
    expect(renderToStaticMarkup(<>{row!.label}</>)).toContain("Opus 4.8 (latest)");
  });

  test("the effort menu offers the levels the model takes, after the agent's own default", () => {
    expect(effortsFor(choices, "claude-sonnet-5-5")).toEqual(["low", "medium", "high"]);
    expect(effortsFor(choices, "haiku")).toEqual([]);
    // A row that does not say, or no row, offers every level.
    expect(effortsFor(choices, "custom-model")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortsFor(null, "x")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // No model picked yet: the default model's levels.
    expect(effortsFor(choices, null)).toHaveLength(5);
    const picked: (string | null)[] = [];
    const items = effortItems(["low", "medium", "high"], "high", CLAUDE_AGENT, (e) => picked.push(e));
    expect(items.map((i) => i.label)).toEqual(["Default", "Low", "Medium", "High"]);
    expect(items.filter((i) => i.checked).map((i) => i.id)).toEqual(["effort:high"]);
    expect(items[0]!.description).toBe("Claude decides for the model");
    items[0]!.onSelect!();
    items[1]!.onSelect!();
    expect(picked).toEqual([null, "low"]);
    expect(effortItems(["max"], null, CLAUDE_AGENT, () => {}).filter((i) => i.checked).map((i) => i.id)).toEqual([
      "effort:default",
    ]);
  });

  test("a session is named after the first line of its first message", () => {
    expect(nameFromMessage("\n  Fix the login bug  \nwith details")).toBe("Fix the login bug");
    expect(nameFromMessage("x".repeat(80))).toBe(`${"x".repeat(57)}…`);
    expect(nameFromMessage("   ")).toBe("");
  });

  test("a new session starts from the message box, with the folder and mode in its bar", () => {
    agentChat.setAgents([CLAUDE_AGENT, CODEX_AGENT]);
    const html = renderToStaticMarkup(
      <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" onClose={() => {}} />,
    );
    expect(html).toContain("New Claude session");
    expect(html).toContain('placeholder="Describe a task for Claude"');
    expect(html).toContain('aria-label="Agent: Claude"');
    expect(html).toContain('aria-label="Folder: /w/code"');
    expect(html).toContain('aria-label="Permission mode: Auto"');
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain("in the code repo");
    // The old form is gone: no name field, no Start chat button.
    expect(html).not.toContain("Session name");
    expect(html).not.toContain("Start chat");
    agentChat.setAgents([]);
  });
});

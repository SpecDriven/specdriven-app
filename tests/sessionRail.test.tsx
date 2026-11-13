// The session popover of the coding agent pane (specs/agents/agent-pane
// .feature.md S10): the numbers, the paths and the words it shows, pinned
// through its pure helpers and static markup — no DOM. The popover's
// behaviour in a page is tests/agentRail.test.tsx.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ContextMeter,
  SessionRail,
  SessionRailButton,
  TranscriptViewRow,
  abbreviatePath,
  contextHeadline,
  contextLevel,
  contextPercent,
  meterSegments,
  parentPath,
  sliceColor,
} from "../src/frontend/SessionRail";
import {
  EMPTY_TRANSCRIPT,
  TRANSCRIPT_VIEWS,
  TRANSCRIPT_VIEW_HINT,
  TRANSCRIPT_VIEW_LABEL,
  applyEvent,
  formatPercent,
  formatTokens,
  transcriptViewHint,
} from "../src/frontend/agentChat";
import type { ChatContextUsage, ChatEvent, ChatSessionMeta } from "../src/frontend/agentChat";
import { CLAUDE_AGENT, CODEX_AGENT, PI_AGENT, agent } from "./fixtures/agents";

const CLAUDE = agent({ ...CLAUDE_AGENT, capabilities: { ...CLAUDE_AGENT.capabilities, contextUsage: "breakdown" } });
const CODEX = agent({ ...CODEX_AGENT, capabilities: { ...CODEX_AGENT.capabilities, contextUsage: "totals" } });

/** Claude Desktop's own example: 151.5k of a 1M window, 132 MCP tools. */
const BREAKDOWN: ChatContextUsage = {
  at: "2026-11-07T10:00:00.000Z",
  model: "claude-opus-4-7[1m]",
  totalTokens: 151_500,
  maxTokens: 1_000_000,
  autoCompactAt: 967_000,
  detail: "estimate",
  slices: [
    { id: "system_prompt", label: "System prompt", tokens: 10_100, kind: "used" },
    {
      id: "mcp_tools",
      label: "MCP tools",
      tokens: 62_800,
      kind: "used",
      items: Array.from({ length: 132 }, (_, i) => ({ name: `mcp__srv__tool_${i}`, detail: "srv", tokens: i === 7 ? 4_000 : 400 })),
    },
    { id: "messages", label: "Messages", tokens: 26_100, kind: "used" },
    { id: "system_tools", label: "System tools", tokens: 37_300, kind: "used" },
    {
      id: "memory_files",
      label: "Memory files",
      tokens: 7_400,
      kind: "used",
      items: [
        { name: "CLAUDE.md", detail: "Project", tokens: 4_000 },
        { name: "MEMORY.md", detail: "User", tokens: 3_400 },
      ],
    },
    { id: "skills", label: "Skills", tokens: 6_900, kind: "used" },
    { id: "mcp_instructions", label: "MCP server instructions", tokens: 733, kind: "used" },
    { id: "autocompact_buffer", label: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
    { id: "free_space", label: "Free space", tokens: 815_500, kind: "free" },
    { id: "deferred_tools", label: "MCP tools (deferred)", tokens: 12_000, kind: "deferred" },
  ],
};

const WORKTREE_META: ChatSessionMeta = {
  id: "s1",
  name: "Fix login",
  agent: "claude",
  cwd: "/Users/dev/.specdriven/worktrees/app-1a2b3c/vmware-install-f2f998",
  worktree: {
    folder: "/Users/dev/dev/personal/SpecDriven/specdriven-app",
    repo: "/Users/dev/dev/personal/SpecDriven/specdriven-app",
    path: "/Users/dev/.specdriven/worktrees/app-1a2b3c/vmware-install-f2f998",
    cwd: "/Users/dev/.specdriven/worktrees/app-1a2b3c/vmware-install-f2f998",
    branch: "specdriven/vmware-install-f2f998",
    base: "main",
  },
  dataRepo: "/Users/dev/specs",
  project: "/Users/dev/specs",
  startedAt: "2026-11-07T09:00:00.000Z",
  status: "idle",
  permissionMode: "auto",
  context: BREAKDOWN,
  lastSeq: 4,
};

describe("formatTokens and formatPercent", () => {
  test("write counts the way Claude Desktop does", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(733)).toBe("733");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(7_400)).toBe("7.4k");
    expect(formatTokens(33_000)).toBe("33k");
    expect(formatTokens(151_500)).toBe("151.5k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(999_960)).toBe("1M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  test("give a share of the window to one decimal", () => {
    expect(formatPercent(62_800, 1_000_000)).toBe("6.3%");
    expect(formatPercent(150_000, 1_000_000)).toBe("15%");
    expect(formatPercent(733, 1_000_000)).toBe("0.1%");
    expect(formatPercent(10, 1_000_000)).toBe("<0.1%");
    expect(formatPercent(0, 1_000_000)).toBe("0%");
    expect(formatPercent(5, 0)).toBe("0%");
  });
});

describe("paths", () => {
  test("the home folder is ~, and a long path loses its middle, whole folders first", () => {
    expect(abbreviatePath("/Users/dev/dev/personal/SpecDriven", "/Users/dev")).toBe("~/dev/personal/SpecDriven");
    expect(abbreviatePath("/Users/dev", "/Users/dev/")).toBe("~");
    // A sibling whose name starts like the home folder is not inside it.
    expect(abbreviatePath("/Users/devon/x", "/Users/dev")).toBe("/Users/devon/x");
    expect(abbreviatePath("/Users/dev/dev/personal/SpecDriven", "/Users/dev", 20)).toBe("~/…/SpecDriven");
    expect(abbreviatePath("/opt/a/b/c/d/e/project", null, 18)).toBe("/opt/…/d/e/project");
    expect(abbreviatePath("/opt/a/b/c/d/e/project", null, 17)).toBe("/opt/…/e/project");
    const cut = abbreviatePath("/a-very-long-folder-name-that-goes-on-and-on", null, 16);
    expect(cut).toHaveLength(16);
    expect(cut).toContain("…");
  });

  test("a folder's parent", () => {
    expect(parentPath("/a/b/c")).toBe("/a/b");
    expect(parentPath("/a/b/c/")).toBe("/a/b");
    expect(parentPath("/a")).toBe("/");
    expect(parentPath("C:\\work\\app")).toBe("C:\\work");
    expect(parentPath("app")).toBe("");
  });
});

describe("the context meter's numbers", () => {
  test("the percentage needs a window", () => {
    expect(contextPercent(BREAKDOWN)).toBe(15);
    expect(contextPercent({ totalTokens: 5_000, maxTokens: null })).toBeNull();
    expect(contextPercent(undefined)).toBeNull();
    expect(contextHeadline(BREAKDOWN)).toEqual({ left: "15% used", right: "151.5k / 1M" });
    expect(contextHeadline({ ...BREAKDOWN, maxTokens: null })).toEqual({ left: "151.5k used", right: "" });
    expect(contextLevel(null)).toBe("ok");
    expect(contextLevel(69)).toBe("ok");
    expect(contextLevel(70)).toBe("warn");
    expect(contextLevel(90)).toBe("high");
  });

  test("the bar draws used parts in their colour order, then the reserve and free space", () => {
    const parts = meterSegments(BREAKDOWN)!;
    expect(parts.map((p) => p.id)).toEqual([
      "mcp_tools",
      "system_tools",
      "messages",
      "system_prompt",
      "memory_files",
      "skills",
      "mcp_instructions",
      "autocompact_buffer",
      "free_space",
    ]);
    // Deferred schemas are not in the window.
    expect(parts.some((p) => p.kind === "deferred")).toBe(false);
    expect(parts[0]!.color).toBe("var(--meter-1)");
    expect(parts.find((p) => p.id === "mcp_instructions")!.color).toBe("var(--meter-other)");
    expect(sliceColor({ id: "anything", kind: "free" })).toBe("var(--meter-free)");
  });

  test("an agent with totals only gets one used part, a derived reserve and what is left", () => {
    const totals: ChatContextUsage = { at: "x", totalTokens: 60_000, maxTokens: 200_000, autoCompactAt: 160_000, detail: "estimate" };
    expect(meterSegments(totals)!.map((p) => [p.id, p.tokens])).toEqual([
      ["used", 60_000],
      ["buffer", 40_000],
      ["free", 100_000],
    ]);
    // Past the reserve, nothing is free; parts at zero draw nothing.
    expect(meterSegments({ ...totals, totalTokens: 190_000 })!.map((p) => p.id)).toEqual(["used", "buffer"]);
    expect(meterSegments({ ...totals, maxTokens: null })).toBeNull();
  });

  test("a context event leaves the transcript as it was", () => {
    const ev = { kind: "context", context: BREAKDOWN, seq: 3, at: BREAKDOWN.at } as ChatEvent;
    const t = applyEvent(EMPTY_TRANSCRIPT, ev);
    expect(t.items).toEqual([]);
    expect(t.lastSeq).toBe(3);
  });
});

// specs/agents/agent-pane.feature.md "The transcript view shows a session at
// three levels of detail": the popover's Transcript row. Switching it in a
// page is tests/agentRail.test.tsx.
describe("the Transcript row", () => {
  test("the popover offers Normal, Thinking and Verbose, with Normal picked on a device that never chose", () => {
    const html = renderToStaticMarkup(<TranscriptViewRow agent={CLAUDE} />);
    expect(html).toContain('role="radiogroup" aria-label="Transcript view"');
    expect(TRANSCRIPT_VIEWS.map((v) => TRANSCRIPT_VIEW_LABEL[v])).toEqual(["Normal", "Thinking", "Verbose"]);
    expect([...html.matchAll(/aria-checked="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1]])).toEqual([
      ["Normal", "true"],
      ["Thinking", "false"],
      ["Verbose", "false"],
    ]);
    // The row sits in the popover itself, between the branch and the window.
    const rail = renderToStaticMarkup(<SessionRail meta={WORKTREE_META} agent={CLAUDE} homeDir={null} />);
    expect(rail.indexOf('data-row="branch"')).toBeLessThan(rail.indexOf('data-row="transcript"'));
    expect(rail.indexOf('data-row="transcript"')).toBeLessThan(rail.indexOf("15% used"));
  });

  test("the Thinking choice says when the agent does not report its thinking", () => {
    const thinks = agent({ ...CLAUDE_AGENT, capabilities: { ...CLAUDE_AGENT.capabilities, thinking: true } });
    expect(transcriptViewHint("thinking", thinks)).toBe(TRANSCRIPT_VIEW_HINT.thinking);
    expect(transcriptViewHint("thinking", PI_AGENT)).toBe(
      `${TRANSCRIPT_VIEW_HINT.thinking} — ${PI_AGENT.label} does not report its thinking`,
    );
    // The other two views read the same for every agent.
    for (const view of ["normal", "verbose"] as const) {
      expect(transcriptViewHint(view, PI_AGENT)).toBe(TRANSCRIPT_VIEW_HINT[view]);
    }
  });
});

describe("SessionRail", () => {
  test("a worktree session shows its folder, branch, base and the window by category", () => {
    const html = renderToStaticMarkup(<SessionRail meta={WORKTREE_META} agent={CLAUDE} homeDir="/Users/dev" />);
    expect(html).toContain("specdriven-app");
    expect(html).toContain("~/dev/personal/SpecDriven");
    expect(html).toContain("specdriven/vmware-install-f2f998");
    expect(html).toContain("off main · ~/…/app-1a2b3c/vmware-install-f2f998");
    expect(html).toContain(">Worktree<");
    expect(html).toContain("15% used");
    expect(html).toContain("151.5k / 1M");
    // The legend: Claude Desktop's rows, with a swatch, the count and the share.
    expect(html).toContain("MCP tools</span><span class=\"agent-meter-num\">62.8k</span>");
    expect(html).toContain("6.3%");
    expect(html).toContain("Autocompact buffer");
    expect(html).toContain("Free space");
    expect(html).toContain("not loaded");
    // The lists under it, with their counts, biggest item first.
    expect(html).toMatch(/MCP tools<\/span><span class="agent-rail-items-count">132</);
    expect(html).toMatch(/Memory files<\/span><span class="agent-rail-items-count">2</);
    expect(html.indexOf("mcp__srv__tool_7")).toBeLessThan(html.indexOf("mcp__srv__tool_0"));
    expect(html).toContain("Estimated after the last turn");
    expect(html).toContain('aria-label="Refresh the context count"');
  });

  test("Refresh is there only for an agent that counts on request, and waits for the turn", () => {
    const busy = renderToStaticMarkup(
      <SessionRail meta={{ ...WORKTREE_META, status: "running" }} agent={CLAUDE} homeDir={null} />,
    );
    expect(busy).toMatch(/aria-label="Refresh the context count" disabled=""/);
    const totals: ChatContextUsage = { at: "x", totalTokens: 60_000, maxTokens: 200_000, detail: "estimate" };
    const codex = renderToStaticMarkup(
      <SessionRail meta={{ ...WORKTREE_META, agent: "codex", context: totals }} agent={CODEX} homeDir={null} />,
    );
    expect(codex).not.toContain("Refresh the context count");
    expect(codex).toContain("30% used");
    expect(codex).toContain("60k / 200k");
    // No home folder: the path is written out.
    expect(codex).toContain("/Users/dev/dev/personal/SpecDriven");
  });

  test("an agent that counts nothing says so, and one that counts says when", () => {
    const { context: _c, ...bare } = WORKTREE_META;
    const pi = renderToStaticMarkup(<SessionRail meta={{ ...bare, agent: "pi" }} agent={PI_AGENT} homeDir={null} />);
    expect(pi).toContain("Pi does not report its context usage.");
    const waiting = renderToStaticMarkup(<SessionRail meta={bare} agent={CLAUDE} homeDir={null} />);
    expect(waiting).toContain("Counted once the first turn is over.");
  });

  test("a measured count says so, and a count with no window shows no bar", () => {
    const measured = renderToStaticMarkup(<ContextMeter usage={{ ...BREAKDOWN, detail: "measured" }} />);
    expect(measured).toContain("Measured");
    const windowless = renderToStaticMarkup(<ContextMeter usage={{ ...BREAKDOWN, maxTokens: null }} />);
    expect(windowless).toContain("151.5k used");
    expect(windowless).not.toContain("agent-meter-seg");
  });

  test("the header button shows how full the window is, and nothing while unknown", () => {
    const html = renderToStaticMarkup(<SessionRailButton meta={WORKTREE_META} agent={CLAUDE} homeDir={null} />);
    expect(html).toContain('aria-label="Session details"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<span class="agent-rail-pct">15%</span>');
    expect(html).toContain('data-level="ok"');
    expect(html).not.toContain("agent-rail-popover");
    const { context: _c, ...bare } = WORKTREE_META;
    const unknown = renderToStaticMarkup(<SessionRailButton meta={bare} agent={CLAUDE} homeDir={null} />);
    expect(unknown).not.toContain("agent-rail-pct");
    expect(unknown).not.toContain("agent-rail-ring-fill");
    const full = renderToStaticMarkup(
      <SessionRailButton meta={{ ...WORKTREE_META, context: { ...BREAKDOWN, totalTokens: 930_000 } }} agent={CLAUDE} homeDir={null} />,
    );
    expect(full).toContain('data-level="high"');
    const open = renderToStaticMarkup(<SessionRailButton meta={WORKTREE_META} agent={CLAUDE} homeDir={null} defaultOpen />);
    expect(open).toContain('role="dialog"');
    expect(open).toContain("agent-rail-popover");
  });
});

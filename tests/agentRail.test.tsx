// The session popover in a page (specs/agents/agent-pane.feature.md S10):
// the header's ring opens it, it asks the server which branch the folder is
// on, Esc closes it, Refresh asks the agent to count again, and a count
// that comes down the stream moves the ring. React needs a DOM for the
// effects, so this file borrows one the way tests/agentWorktreePane.test.tsx does.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "Event",
  "MutationObserver",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;
const realFetch = globalThis.fetch;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/" });
  const w = happyWindow as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (w[key] ?? w.window);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

// Another file's pane may have asked about /w/code under its own fetch stub.
beforeEach(() => forgetFolderInfos());

afterEach(async () => {
  await agentChat.end("s1").catch(() => undefined);
  globalThis.fetch = realFetch;
  localStorage.clear();
  forgetFolderInfos();
  agentChat.setAgents([]);
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentPane } from "../src/frontend/AgentPane";
import { Toaster } from "../src/frontend/Toasts";
import { agentChat, forgetFolderInfos } from "../src/frontend/agentChat";
import type { ChatContextUsage, ChatMcpServer, ChatSessionMeta } from "../src/frontend/agentChat";
import { CLAUDE_AGENT, agent } from "./fixtures/agents";

const CLAUDE = agent({ ...CLAUDE_AGENT, capabilities: { ...CLAUDE_AGENT.capabilities, contextUsage: "breakdown" } });

const COUNT: ChatContextUsage = {
  at: "2026-11-07T10:00:00.000Z",
  totalTokens: 30_000,
  maxTokens: 200_000,
  detail: "estimate",
  slices: [
    { id: "system_tools", label: "System tools", tokens: 20_000, kind: "used" },
    { id: "messages", label: "Messages", tokens: 10_000, kind: "used" },
  ],
};

const META: ChatSessionMeta = {
  id: "s1",
  name: "Tidy specs",
  agent: "claude",
  cwd: "/w/code",
  dataRepo: "/w/data",
  project: "/w/data",
  startedAt: "2026-11-07T09:00:00.000Z",
  status: "idle",
  permissionMode: "auto",
  context: COUNT,
  lastSeq: 1,
};

/** A server where /w/code is a repo on main; the stream is the test's to feed. */
function server(
  posts: { url: string; body: unknown }[],
  feed: { push?: (line: string) => void },
  /** The agent's MCP side: the list, and what an action answers. */
  mcp?: { list: () => ChatMcpServer[]; act: (server: string, action: string) => { url?: string } | Response },
) {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "/api/agent/chat/s1/mcp" && mcp) {
      if (init.method !== "POST") {
        posts.push({ url, body: null });
        return Response.json({ servers: mcp.list() });
      }
      const body = JSON.parse(String(init.body)) as { server: string; action: string };
      posts.push({ url, body });
      const answer = mcp.act(body.server, body.action);
      return answer instanceof Response ? answer : Response.json({ servers: mcp.list(), ...answer });
    }
    if (url.startsWith("/api/agent/folder?")) return Response.json({ canWorktree: true, repo: "/w/code", branch: "main" });
    if (url === "/api/agent/chat/s1/context" && init.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ context: { ...COUNT, totalTokens: 48_000, detail: "measured" } });
    }
    if (url === "/api/agent/chat/s1" && init.method === "DELETE") return Response.json({ ok: true });
    if (url === "/api/agent/chat/s1") return Response.json({ meta: META, commands: [], events: [] });
    if (url.startsWith("/api/agent/chat/s1/events")) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            feed.push = (line) => controller.enqueue(encoder.encode(`${line}\n`));
          },
        }),
      );
    }
    return Response.json({ choices: null });
  }) as unknown as typeof fetch;
}

function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const settle = () => act(() => Bun.sleep(10));

const button = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Session details"]')!;
const popover = (host: HTMLElement) => host.querySelector<HTMLElement>('[role="dialog"][aria-label="Session details"]');

test("the header ring opens the session popover on the folder, its branch and the window", async () => {
  server([], {});
  agentChat.setAgents([CLAUDE]);
  await agentChat.openSession("s1");
  const { host, unmount } = mount(
    <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" homeDir="/w" onClose={() => {}} />,
  );
  expect(button(host).textContent).toBe("15%");
  expect(popover(host)).toBeNull();

  act(() => button(host).click());
  await settle();
  const dialog = popover(host)!;
  expect(button(host).getAttribute("aria-expanded")).toBe("true");
  expect(dialog.querySelector('[data-row="folder"]')!.textContent).toBe("code · ~");
  // Not a worktree session: the branch the folder has checked out.
  expect(dialog.querySelector('[data-row="branch"]')!.textContent).toBe("main");
  expect(dialog.textContent).toContain("15% used");
  expect(dialog.textContent).toContain("30k / 200k");
  expect([...dialog.querySelectorAll(".agent-meter-seg")].map((s) => s.getAttribute("data-slice"))).toEqual([
    "system_tools",
    "messages",
    "free",
  ]);

  // Esc closes it, and gives the button its state back.
  act(() => {
    dialog.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  });
  expect(popover(host)).toBeNull();
  expect(button(host).getAttribute("aria-expanded")).toBe("false");
  unmount();
});

// specs/agents/agent-pane.feature.md "Transcript view": the popover's
// Transcript row picks Normal, Thinking or Verbose for every session on
// this device, and the open transcript follows at once.
test("the popover's Transcript row switches the view, the transcript follows, and the choice is kept", async () => {
  const feed: { push?: (line: string) => void } = {};
  server([], feed);
  agentChat.setAgents([CLAUDE]);
  await agentChat.openSession("s1");
  const { host, unmount } = mount(
    <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" homeDir="/w" onClose={() => {}} />,
  );
  await settle();
  const at = COUNT.at;
  const lines = [
    { kind: "assistant", messageId: "m1", turn: 1, blocks: [{ type: "thinking", text: "Read the spec first." }], parentToolUseId: null },
    { kind: "assistant", messageId: "m1", turn: 1, blocks: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "a.md" } }], parentToolUseId: null },
    { kind: "tool_result", toolUseId: "r1", content: "# A", isError: false, parentToolUseId: null },
    { kind: "assistant", messageId: "m2", turn: 1, blocks: [{ type: "tool_use", id: "g1", name: "Grep", input: { pattern: "TODO" } }], parentToolUseId: null },
    { kind: "tool_result", toolUseId: "g1", content: "3 matches", isError: false, parentToolUseId: null },
  ];
  act(() => lines.forEach((line, i) => feed.push!(JSON.stringify({ ...line, seq: i + 2, at }))));
  await settle();
  const log = () => host.querySelector<HTMLElement>('[role="log"]')!;
  // Normal, the default: the two calls are one line, the thought is not shown.
  expect(log().querySelectorAll(".agent-tool-run")).toHaveLength(1);
  expect(log().textContent).toContain("Read 1 file, searched 1 time");
  expect(log().textContent).not.toContain("Read the spec first.");

  act(() => button(host).click());
  await settle();
  const radios = () => [...popover(host)!.querySelectorAll<HTMLButtonElement>('[data-row="transcript"] [role="radio"]')];
  expect(radios().map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
    ["Normal", "true"],
    ["Thinking", "false"],
    ["Verbose", "false"],
  ]);

  act(() => radios()[1]!.click());
  expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  expect(log().querySelectorAll(".agent-tool-run")).toHaveLength(0);
  expect(log().querySelectorAll(".agent-tool")).toHaveLength(2);
  expect(log().querySelector(".agent-thinking")!.textContent).toBe("Read the spec first.");
  expect(log().querySelectorAll("details[open]")).toHaveLength(0);
  expect(localStorage.getItem("sd-agent-transcript-view")).toBe("thinking");

  act(() => radios()[2]!.click());
  expect(log().querySelectorAll("details[open]")).toHaveLength(2);
  expect(localStorage.getItem("sd-agent-transcript-view")).toBe("verbose");
  unmount();

  // The choice is the device's: a pane opened later starts on it.
  const again = mount(
    <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" homeDir="/w" onClose={() => {}} />,
  );
  await settle();
  expect(again.host.querySelectorAll('[role="log"] details[open]')).toHaveLength(2);
  again.unmount();
});

test("Refresh asks the agent to count every category, and a count on the stream moves the ring", async () => {
  const posts: { url: string; body: unknown }[] = [];
  const feed: { push?: (line: string) => void } = {};
  server(posts, feed);
  agentChat.setAgents([CLAUDE]);
  await agentChat.openSession("s1");
  const { host, unmount } = mount(
    <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" onClose={() => {}} />,
  );
  act(() => button(host).click());
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Refresh the context count"]')!.click());
  await settle();
  expect(posts).toEqual([{ url: "/api/agent/chat/s1/context", body: { detail: "full" } }]);
  expect(popover(host)!.textContent).toContain("24% used");
  expect(popover(host)!.textContent).toContain("Measured");
  expect(button(host).textContent).toBe("24%");

  // The agent counts again after its next turn: the stream says so.
  await settle();
  act(() => {
    feed.push!(JSON.stringify({ kind: "context", context: { ...COUNT, totalTokens: 150_000 }, seq: 2, at: COUNT.at }));
  });
  await settle();
  expect(button(host).textContent).toBe("75%");
  expect(button(host).querySelector(".agent-rail-ring")!.getAttribute("data-level")).toBe("warn");
  unmount();
});

// specs/agents/agent-pane.feature.md "MCP servers": the popover asks the
// agent for its MCP servers when it opens; a switch turns one off, Sign in
// starts its sign-in and opens the page, and the list keeps asking until the
// server is through.
test("the popover lists the MCP servers, a switch turns one off, and Sign in opens the page and waits for the server", async () => {
  const LISTING = agent({ ...CLAUDE, capabilities: { ...CLAUDE.capabilities, mcpServers: true } });
  const servers: ChatMcpServer[] = [
    { name: "specdriven-confluence", status: "connected", source: "SpecDriven", tools: 3, canToggle: true, canAuthenticate: false },
    { name: "linear", status: "needs-auth", source: "user", canToggle: true, canAuthenticate: true },
  ];
  const named = (name: string) => servers.find((s) => s.name === name)!;
  const posts: { url: string; body: unknown }[] = [];
  server(posts, {}, {
    list: () => servers.map((s) => ({ ...s })),
    act: (name, action) => {
      if (action === "disable") named(name).status = "disabled";
      if (action === "enable") return Response.json({ error: "Claude could not enable it: timed out" }, { status: 502 });
      return action === "authenticate" ? { url: "https://auth.example/authorize?state=1" } : {};
    },
  });
  const opened: string[] = [];
  const realOpen = window.open;
  window.open = ((url: string) => {
    opened.push(url);
    return null;
  }) as unknown as typeof window.open;
  agentChat.setAgents([LISTING]);
  await agentChat.openSession("s1");
  const { host, unmount } = mount(
    <>
      <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" onClose={() => {}} />
      <Toaster />
    </>,
  );
  // Nothing is asked until the popover opens.
  await settle();
  expect(posts).toEqual([]);

  act(() => button(host).click());
  await settle();
  const list = () => popover(host)!.querySelector<HTMLDetailsElement>('details[data-list="mcp"]')!;
  const row = (name: string) => list().querySelector<HTMLElement>(`li[data-server="${name}"]`)!;
  const toggle = (name: string) => row(name).querySelector<HTMLInputElement>('input[role="switch"]')!;
  expect(posts).toEqual([{ url: "/api/agent/chat/s1/mcp", body: null }]);
  expect(list().querySelector(".agent-rail-items-count")!.textContent).toBe("2");
  // A server wants a sign-in: the row is open without a click.
  expect(list().open).toBe(true);
  expect(row("specdriven-confluence").textContent).toContain("SpecDriven · Connected · 3 tools");
  expect(toggle("specdriven-confluence").checked).toBe(true);
  expect(row("linear").textContent).toContain("user · Needs sign-in");

  // The switch turns the server off, and the row follows the agent's answer.
  await act(async () => toggle("specdriven-confluence").click());
  await settle();
  expect(posts.at(-1)).toEqual({ url: "/api/agent/chat/s1/mcp", body: { server: "specdriven-confluence", action: "disable" } });
  expect(row("specdriven-confluence").textContent).toContain("SpecDriven · Disabled");
  expect(toggle("specdriven-confluence").checked).toBe(false);

  // A refused action says why, and the row stays as the agent has it.
  await act(async () => toggle("specdriven-confluence").click());
  await settle();
  expect(posts.at(-1)).toEqual({ url: "/api/agent/chat/s1/mcp", body: { server: "specdriven-confluence", action: "enable" } });
  const refusals = () => [...document.querySelectorAll(".toast")].filter((t) => t.textContent?.includes("could not enable"));
  const said = refusals().map((t) => t.querySelector(".toast-message")?.textContent);
  // An error toast stays until dismissed, and the toasts are one list for
  // the whole test run: dismiss this one, or a later file's page shows it.
  for (const t of refusals()) await act(async () => t.querySelector<HTMLButtonElement>("button.toast-close")!.click());
  expect(said).toEqual(["Claude could not enable it: timed out"]);
  expect(refusals()).toEqual([]);
  expect(toggle("specdriven-confluence").checked).toBe(false);

  // Sign in: the agent starts it, the page opens in the browser and stays as a link.
  const signIn = row("linear").querySelector<HTMLButtonElement>("button.agent-mcp-btn")!;
  expect(signIn.textContent).toBe("Sign in");
  await act(async () => signIn.click());
  await settle();
  expect(posts.at(-1)).toEqual({ url: "/api/agent/chat/s1/mcp", body: { server: "linear", action: "authenticate" } });
  expect(opened).toEqual(["https://auth.example/authorize?state=1"]);
  expect(row("linear").querySelector("a.agent-mcp-link")!.getAttribute("href")).toBe("https://auth.example/authorize?state=1");

  // The sign-in goes through in the browser: the list asks again by itself and the row turns.
  Object.assign(named("linear"), { status: "connected", tools: 12, canAuthenticate: false });
  const asked = posts.length;
  await act(() => Bun.sleep(2200));
  expect(posts.length).toBeGreaterThan(asked);
  expect(posts.at(-1)).toEqual({ url: "/api/agent/chat/s1/mcp", body: null });
  expect(row("linear").textContent).toContain("user · Connected · 12 tools");
  expect(row("linear").querySelector("button.agent-mcp-btn")).toBeNull();
  expect(row("linear").querySelector("a.agent-mcp-link")).toBeNull();
  // Nothing left to wait for: the list stops asking.
  const settled = posts.length;
  await act(() => Bun.sleep(2200));
  expect(posts.length).toBe(settled);

  window.open = realOpen;
  unmount();
}, 15_000);

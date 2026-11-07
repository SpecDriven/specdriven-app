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
import { agentChat, forgetFolderInfos } from "../src/frontend/agentChat";
import type { ChatContextUsage, ChatSessionMeta } from "../src/frontend/agentChat";
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
  startedAt: "2026-11-07T09:00:00.000Z",
  status: "idle",
  permissionMode: "auto",
  context: COUNT,
  lastSeq: 1,
};

/** A server where /w/code is a repo on main; the stream is the test's to feed. */
function server(posts: { url: string; body: unknown }[], feed: { push?: (line: string) => void }) {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
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

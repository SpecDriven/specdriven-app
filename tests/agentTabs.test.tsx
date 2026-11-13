// Session tabs in the coding agent pane (specs/agents/agent-pane.feature.md
// "Each session has its own tab, at most five"): one tab per open session in
// the order they started, every one followed live, + for a new session up
// to the cap, and × that asks first while the agent is at work. React needs
// a DOM for the effects, so this file borrows one the way
// tests/agentWorktreePane.test.tsx does.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

beforeEach(() => forgetFolderInfos());

afterEach(async () => {
  // Close whatever a test left open, under its own server, before the next.
  for (const m of [...agentChatState().list]) await agentChat.end(m.id).catch(() => undefined);
  agentChat.setActive(null);
  globalThis.fetch = realFetch;
  localStorage.clear();
  forgetFolderInfos();
  agentChat.setAgents([]);
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentPane, sessionTabTitle } from "../src/frontend/AgentPane";
import {
  MAX_OPEN_SESSIONS,
  agentChat,
  agentChatState,
  canOpenAnother,
  forgetFolderInfos,
  isBusy,
  neighborTab,
  tabOrder,
} from "../src/frontend/agentChat";
import type { ChatEvent, ChatSessionMeta, ChatStatus } from "../src/frontend/agentChat";
import type { ConfirmOptions } from "../src/frontend/ModalPrompts";
import { CLAUDE_AGENT } from "./fixtures/agents";

/** A session started `minute` minutes past ten, in the state given. */
function meta(id: string, minute: number, status: ChatStatus = "idle"): ChatSessionMeta {
  return {
    id,
    name: `Task ${id}`,
    agent: "claude",
    cwd: "/w/code",
    dataRepo: "/w/data",
    project: "/w/data",
    codeRepo: "/w/code",
    startedAt: `2026-11-08T10:${String(minute).padStart(2, "0")}:00.000Z`,
    status,
    permissionMode: "auto",
    lastSeq: 1,
  };
}

/** Each session's transcript is one user message naming it. */
function firstMessage(m: ChatSessionMeta): ChatEvent[] {
  return [{ kind: "user", id: `u-${m.id}`, text: `hello from ${m.id}`, seq: 1, at: m.startedAt } as ChatEvent];
}

interface Server {
  deleted: string[];
  loaded: string[];
}

/** A server holding `sessions` (newest first, as GET /api/agent/chat lists
    them); each DELETE takes one away. */
function server(sessions: ChatSessionMeta[]): Server {
  const kept = [...sessions].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const seen: Server = { deleted: [], loaded: [] };
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "/api/agent/chat" && (init.method ?? "GET") === "GET") return Response.json({ sessions: kept });
    const events = url.match(/^\/api\/agent\/chat\/([^/?]+)\/events/);
    if (events) return new Response(new ReadableStream());
    const one = url.match(/^\/api\/agent\/chat\/([^/?]+)$/);
    if (one) {
      const at = kept.findIndex((m) => m.id === one[1]);
      if (at < 0) return Response.json({ error: "coding agent session not found" }, { status: 404 });
      if (init.method === "DELETE") {
        seen.deleted.push(one[1]!);
        kept.splice(at, 1);
        return Response.json({ ok: true });
      }
      seen.loaded.push(one[1]!);
      return Response.json({ meta: kept[at], commands: [], events: firstMessage(kept[at]!) });
    }
    if (url.startsWith("/api/agent/folder?")) return Response.json({ canWorktree: false, reason: "Not a git repository" });
    return Response.json({ choices: null });
  }) as unknown as typeof fetch;
  return seen;
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

const pane = (confirm?: (opts: ConfirmOptions) => Promise<boolean>) => (
  <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" onClose={() => {}} confirm={confirm} />
);

const settle = () => act(() => Bun.sleep(5));

const tabs = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
const tabNames = (host: HTMLElement) => tabs(host).map((t) => t.querySelector(".agent-tab-name")!.textContent);
const selected = (host: HTMLElement) =>
  tabs(host)
    .find((t) => t.getAttribute("aria-selected") === "true")
    ?.querySelector(".agent-tab-name")?.textContent;
const newButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="New session"]')!;

/** Boot the pane on a server holding `sessions`, the way App.tsx does. */
async function boot(sessions: ChatSessionMeta[], confirm?: (opts: ConfirmOptions) => Promise<boolean>) {
  const seen = server(sessions);
  agentChat.setAgents([CLAUDE_AGENT]);
  const mounted = mount(pane(confirm));
  await act(() => agentChat.restore());
  await settle();
  return { ...mounted, seen };
}

describe("tab helpers", () => {
  test("tabs run in the order their sessions started, and a closed tab hands over to its right, else its left", () => {
    const list = [meta("c", 3), meta("a", 1), meta("b", 2)];
    expect(tabOrder(list).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(neighborTab(list, "b")).toBe("c");
    expect(neighborTab(list, "c")).toBe("b");
    expect(neighborTab([meta("a", 1)], "a")).toBeNull();
  });

  test("five open tabs, ended ones included, leave no room for another", () => {
    expect(MAX_OPEN_SESSIONS).toBe(5);
    const four = [1, 2, 3, 4].map((n) => meta(`s${n}`, n, n === 1 ? "ended" : "idle"));
    expect(canOpenAnother({ list: four })).toBe(true);
    expect(canOpenAnother({ list: [...four, meta("s5", 5, "error")] })).toBe(false);
  });

  test("a session asks before closing only while its agent is at work", () => {
    expect(isBusy("running")).toBe(true);
    expect(isBusy("awaiting_input")).toBe(true);
    for (const s of ["starting", "idle", "ended", "error"] as const) expect(isBusy(s)).toBe(false);
  });

  test("a tab's tooltip names the session, its agent, its state and its folder", () => {
    expect(sessionTabTitle(meta("a", 1, "running"), [CLAUDE_AGENT])).toBe("Task a\nClaude · Working… · /w/code");
  });
});

test("each open session has a tab in start order, every one followed, and a click shows its transcript", async () => {
  localStorage.setItem("sd-agent-session", "b");
  const { host, seen, unmount } = await boot([meta("a", 1), meta("b", 2, "running"), meta("c", 3)]);
  expect(tabNames(host)).toEqual(["Task a", "Task b", "Task c"]);
  // Every session is loaded and streamed, not only the one shown…
  expect(seen.loaded.sort()).toEqual(["a", "b", "c"]);
  // …and the remembered one is the one shown.
  expect(selected(host)).toBe("Task b");
  // One header line, as in Claude Code: the tabs and + sit in it, not on a row of their own.
  const tablist = host.querySelector(".agent-head .agent-tablist")!;
  expect(tablist.getAttribute("aria-label")).toBe("Sessions");
  expect(host.querySelector(".agent-head button[aria-label=\"New session\"]")).not.toBeNull();
  expect(host.querySelector(".agent-session-name")).toBeNull();
  expect(tabs(host)[1]!.querySelector(".agent-dot")!.getAttribute("data-status")).toBe("running");
  expect(host.textContent).toContain("hello from b");

  act(() => tabs(host)[2]!.click());
  expect(selected(host)).toBe("Task c");
  expect(host.textContent).toContain("hello from c");
  expect(host.textContent).not.toContain("hello from b");
  expect(localStorage.getItem("sd-agent-session")).toBe("c");
  unmount();
});

test("each tab leads with its agent's mark, as in the model picker, with the session's dot on it", async () => {
  const { host, unmount } = await boot([
    meta("a", 1),
    { ...meta("b", 2, "running"), agent: "codex" },
    { ...meta("c", 3, "ended"), agent: "someone-new" },
  ]);
  const marks = tabs(host).map((t) => t.querySelector(".agent-tab-mark")!);
  expect(marks.map((m) => m.querySelector("[data-agent-icon]")!.getAttribute("data-agent-icon"))).toEqual([
    "claude",
    "codex",
    "generic",
  ]);
  expect(marks.map((m) => m.querySelector(".agent-dot")!.getAttribute("data-status"))).toEqual([
    "idle",
    "running",
    "ended",
  ]);
  // The mark comes before the name, and is decoration: the tab is named by its session.
  expect(marks[0]!.nextElementSibling!.className).toBe("agent-tab-name");
  expect(marks[0]!.getAttribute("aria-hidden")).toBe("true");
  unmount();
});

test("the arrow keys, Home and End move between tabs", async () => {
  const { host, unmount } = await boot([meta("a", 1), meta("b", 2), meta("c", 3)]);
  expect(selected(host)).toBe("Task c");
  const key = (k: string) =>
    act(() => {
      const t = tabs(host).find((x) => x.getAttribute("aria-selected") === "true")!;
      t.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }) as unknown as Event);
    });
  key("ArrowRight");
  expect(selected(host)).toBe("Task a");
  key("ArrowLeft");
  expect(selected(host)).toBe("Task c");
  key("Home");
  expect(selected(host)).toBe("Task a");
  key("End");
  expect(selected(host)).toBe("Task c");
  unmount();
});

test("+ opens the new-session screen on a tab of its own, until five tabs are open", async () => {
  const { host, unmount } = await boot([meta("a", 1), meta("b", 2)]);
  expect(newButton(host).getAttribute("aria-disabled")).toBe("false");
  act(() => newButton(host).click());
  expect(tabNames(host)).toEqual(["Task a", "Task b", "New session"]);
  expect(selected(host)).toBe("New session");
  expect(host.querySelector('textarea[aria-label="Message"]')).not.toBeNull();
  // The draft tab has nothing to close, and goes when another tab is picked.
  expect(tabs(host)[2]!.querySelector(".agent-tab-close")).toBeNull();
  act(() => tabs(host)[0]!.click());
  expect(tabNames(host)).toEqual(["Task a", "Task b"]);
  unmount();
});

test("with five tabs open, ended ones among them, + and the message box wait for one to close", async () => {
  const five = [1, 2, 3, 4, 5].map((n) => meta(`s${n}`, n, n === 2 ? "ended" : "idle"));
  const { host, unmount } = await boot(five);
  expect(tabs(host)).toHaveLength(5);
  expect(newButton(host).getAttribute("aria-disabled")).toBe("true");
  act(() => newButton(host).click());
  expect(selected(host)).toBe("Task s5");

  // A new-session screen reached anyway (a tab opened elsewhere since) says why it cannot send.
  act(() => agentChat.setActive(null));
  expect(host.textContent).toContain("5 sessions are open — close one to start another.");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.disabled).toBe(true);
  unmount();
});

test("× closes an idle tab at once and shows the tab to its right", async () => {
  localStorage.setItem("sd-agent-session", "b");
  const asked: ConfirmOptions[] = [];
  const { host, seen, unmount } = await boot([meta("a", 1), meta("b", 2, "ended"), meta("c", 3)], async (o) => {
    asked.push(o);
    return true;
  });
  await act(async () => tabs(host)[1]!.querySelector<HTMLButtonElement>(".agent-tab-close")!.click());
  await settle();
  expect(asked).toHaveLength(0);
  expect(seen.deleted).toEqual(["b"]);
  expect(tabNames(host)).toEqual(["Task a", "Task c"]);
  expect(selected(host)).toBe("Task c");
  unmount();
});

test("× on a tab whose agent is at work asks first, and a no keeps the session", async () => {
  const answers = [false, true];
  const asked: ConfirmOptions[] = [];
  const { host, seen, unmount } = await boot([meta("a", 1, "running"), meta("b", 2, "awaiting_input")], async (o) => {
    asked.push(o);
    return answers.shift()!;
  });
  const closeFirst = () =>
    act(async () => tabs(host)[0]!.querySelector<HTMLButtonElement>(".agent-tab-close")!.click());
  await closeFirst();
  await settle();
  expect(asked[0]).toMatchObject({ title: "End this session?", confirmLabel: "End session", danger: true });
  expect(asked[0]!.body).toContain("Claude is still working in “Task a”");
  expect(seen.deleted).toEqual([]);
  expect(tabNames(host)).toEqual(["Task a", "Task b"]);

  await closeFirst();
  await settle();
  expect(seen.deleted).toEqual(["a"]);
  expect(tabNames(host)).toEqual(["Task b"]);
  unmount();
});

test("closing the last tab leaves the new-session screen", async () => {
  const { host, unmount } = await boot([meta("a", 1)]);
  await act(async () => tabs(host)[0]!.querySelector<HTMLButtonElement>(".agent-tab-close")!.click());
  await settle();
  expect(agentChatState().activeId).toBeNull();
  // No sessions left: no tabs at all, the pane's title back in the header, just the message box.
  expect(host.querySelector(".agent-tablist")).toBeNull();
  expect(host.querySelector(".agent-head")!.textContent).toContain("Coding agent");
  expect(host.querySelector('textarea[aria-label="Message"]')).not.toBeNull();
  unmount();
});

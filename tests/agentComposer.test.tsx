// The coding agent pane's message box beyond typing and sending
// (specs/agents/agent-pane.feature.md "Up and Down recall sent messages",
// "/help lists the commands", "The open feature or file goes with a
// message"): the pure rules in src/frontend/agentChat.ts, then the box
// itself. React needs a DOM for the keys, so this file borrows one the way
// tests/agentImagePaste.test.tsx does.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MutationObserver",
  "FocusEvent",
  "KeyboardEvent",
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
  globalThis.fetch = realFetch;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentPane } from "../src/frontend/AgentPane";
import {
  HISTORY_LIMIT,
  HISTORY_START,
  addToHistory,
  agentChat,
  composeRefs,
  filterCommands,
  historyStep,
  isHelpCommand,
  refLabel,
  withLocalCommands,
} from "../src/frontend/agentChat";
import { Toaster } from "../src/frontend/Toasts";
import { CLAUDE_AGENT } from "./fixtures/agents";

describe("the rules", () => {
  test("a sent message joins the history, once in a row, the oldest falling off", () => {
    expect(addToHistory([], "  one  ")).toEqual(["one"]);
    expect(addToHistory(["one"], "one")).toEqual(["one"]);
    expect(addToHistory(["one", "two"], "one")).toEqual(["one", "two", "one"]);
    expect(addToHistory(["one"], "   ")).toEqual(["one"]);
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => `m${i}`);
    const next = addToHistory(full, "new");
    expect(next).toHaveLength(HISTORY_LIMIT);
    expect(next[0]).toBe("m1");
    expect(next.at(-1)).toBe("new");
  });

  test("Up walks back through sent messages and Down returns to the draft", () => {
    const sent = ["first", "second"];
    const up1 = historyStep(sent, HISTORY_START, "up", "draft")!;
    expect(up1).toEqual({ cursor: { index: 1, stash: "draft" }, draft: "second" });
    const up2 = historyStep(sent, up1.cursor, "up", up1.draft)!;
    expect(up2.draft).toBe("first");
    // Nothing older: the box stays as it is.
    expect(historyStep(sent, up2.cursor, "up", up2.draft)).toBeNull();
    const down1 = historyStep(sent, up2.cursor, "down", up2.draft)!;
    expect(down1.draft).toBe("second");
    // Past the newest comes the draft that was being typed.
    expect(historyStep(sent, down1.cursor, "down", down1.draft)).toEqual({ cursor: HISTORY_START, draft: "draft" });
    // Down recalls nothing until Up has, and Up nothing with no history.
    expect(historyStep(sent, HISTORY_START, "down", "draft")).toBeNull();
    expect(historyStep([], HISTORY_START, "up", "")).toBeNull();
  });

  test("/help is the pane's own command, listed beside the agent's", () => {
    const agents = [{ name: "review", description: "Review code", argumentHint: "[files]" }];
    expect(withLocalCommands(agents).map((c) => c.name)).toEqual(["help", "review"]);
    expect(withLocalCommands([]).map((c) => c.name)).toEqual(["help"]);
    // An agent with a /help of its own keeps one row, with its words.
    const own = [{ name: "help", description: "Agent help", argumentHint: "" }];
    expect(withLocalCommands(own)).toEqual(own);
    expect(filterCommands(withLocalCommands(agents), "/he", 3).items.map((c) => c.name)).toEqual(["help"]);
    expect(isHelpCommand("/help")).toBe(true);
    expect(isHelpCommand("  /HELP  ")).toBe(true);
    expect(isHelpCommand("/help me")).toBe(false);
    expect(isHelpCommand("help")).toBe(false);
  });

  test("the open file goes with a message unless removed; pinned files stay", () => {
    const a = "specs/billing/quotes.feature.md";
    const b = "src/server/api.ts";
    expect(refLabel(a)).toBe("quotes");
    expect(refLabel(b)).toBe("api.ts");
    expect(composeRefs(a, { follow: true, pinned: [] })).toEqual({ refs: [{ path: a, auto: true }], offer: null });
    expect(composeRefs(null, { follow: true, pinned: [] })).toEqual({ refs: [], offer: null });
    // Removed: nothing goes, and the row offers it back.
    expect(composeRefs(a, { follow: false, pinned: [] })).toEqual({ refs: [], offer: a });
    // Pinned ones stay as the open file changes, each listed once.
    expect(composeRefs(b, { follow: true, pinned: [a] })).toEqual({
      refs: [
        { path: a, auto: false },
        { path: b, auto: true },
      ],
      offer: null,
    });
    expect(composeRefs(a, { follow: true, pinned: [a, a] })).toEqual({ refs: [{ path: a, auto: false }], offer: null });
    expect(composeRefs(a, { follow: false, pinned: [a] })).toEqual({ refs: [{ path: a, auto: false }], offer: null });
  });
});

function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return {
    host,
    render: (next: React.ReactElement) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const pane = (current: string | null = null) => (
  <>
    <AgentPane compact={false} demo={false} codeRepo={null} dataRepo="/w/data" current={current} onClose={() => {}} />
    <Toaster />
  </>
);

/** Type into the message box the way React hears it under happy-dom. */
function type(el: HTMLTextAreaElement, text: string) {
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

function key(el: HTMLElement, k: string) {
  act(() => {
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }) as unknown as Event);
  });
}

describe("the message box", () => {
  afterEach(() => {
    localStorage.clear();
    agentChat.setAgents([]);
  });

  test("Up and Down recall sent messages, from the box's first and last line only", () => {
    globalThis.fetch = (async () => Response.json({ choices: null })) as unknown as typeof fetch;
    localStorage.setItem("sd-agent-history", JSON.stringify(["first", "second"]));
    agentChat.setAgents([CLAUDE_AGENT]);
    const { host, unmount } = mount(pane());
    const box = host.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
    type(box, "draft");
    key(box, "ArrowUp");
    expect(box.value).toBe("second");
    key(box, "ArrowUp");
    expect(box.value).toBe("first");
    key(box, "ArrowUp");
    expect(box.value).toBe("first");
    key(box, "ArrowDown");
    expect(box.value).toBe("second");
    key(box, "ArrowDown");
    expect(box.value).toBe("draft");
    key(box, "ArrowDown");
    expect(box.value).toBe("draft");
    // On a later line, Up is the caret's.
    type(box, "one\ntwo");
    key(box, "ArrowUp");
    expect(box.value).toBe("one\ntwo");
    // From the first line it recalls, and the lines come back with Down.
    act(() => box.setSelectionRange(1, 1));
    key(box, "ArrowUp");
    expect(box.value).toBe("second");
    key(box, "ArrowDown");
    expect(box.value).toBe("one\ntwo");
    unmount();
  });

  test("/help lists the commands in the pane and sends nothing", async () => {
    const posts: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (init.method === "POST") posts.push(url);
      return Response.json({ choices: null });
    }) as unknown as typeof fetch;
    agentChat.setAgents([CLAUDE_AGENT]);
    const { host, unmount } = mount(pane());
    const box = host.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
    type(box, "/he");
    // The "/" popup offers it even before a session has any commands.
    expect([...host.querySelectorAll(".agent-slash [role=option]")].map((o) => o.textContent)).toEqual([
      "/helpList the available commands",
    ]);
    key(box, "Enter");
    expect(box.value).toBe("/help ");
    await act(async () => key(box, "Enter"));
    const help = host.querySelector('.agent-help[role="note"]')!;
    expect(help.textContent).toContain("/help");
    expect(help.textContent).toContain("List the available commands");
    expect(help.textContent).toContain("recall sent messages");
    expect(box.value).toBe("");
    expect(posts).toEqual([]);
    // It is not a message: Up does not bring it back.
    expect(localStorage.getItem("sd-agent-history")).toBeNull();
    key(box, "Escape");
    expect(host.querySelector(".agent-help")).toBeNull();
    unmount();
  });

  test("the open feature goes with a message; it can be kept, removed and added back", async () => {
    const posts: Record<string, unknown>[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/choices")) return Response.json({ choices: null });
      if (url === "/api/agent/chat" && init.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return Response.json({ id: "s1" });
      }
      if (url === "/api/agent/chat/s1") {
        const meta = {
          id: "s1",
          name: "Look",
          agent: "claude",
          cwd: "/w/data",
          dataRepo: "/w/data",
          startedAt: "2026-11-10T10:00:00.000Z",
          status: "ended",
          permissionMode: "auto",
          lastSeq: 1,
        };
        const user = {
          kind: "user",
          id: "u1",
          text: "Look",
          refs: ["specs/billing/quotes.feature.md"],
          seq: 1,
          at: "2026-11-10T10:00:00.000Z",
        };
        return Response.json({ meta, commands: [], events: [user] });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    agentChat.setAgents([CLAUDE_AGENT]);
    const quotes = "specs/billing/quotes.feature.md";
    const { host, render, unmount } = mount(pane(quotes));
    const chips = () => [...host.querySelectorAll(".agent-refs li.agent-ref")].map((li) => li.textContent);
    const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
    expect(chips()).toEqual(["quotes"]);
    expect(host.querySelector(".agent-ref[data-auto]")).not.toBeNull();

    // Kept: it stays when another file opens, and that one joins it.
    act(() => button("Keep quotes in context")!.click());
    expect(host.querySelector(".agent-ref[data-auto]")).toBeNull();
    render(pane("specs/billing/invoices.feature.md"));
    expect(chips()).toEqual(["quotes", "invoices"]);

    // Removed: the open file no longer goes, here or after a reload.
    act(() => button("Remove invoices from context")!.click());
    expect(chips()).toEqual(["quotes"]);
    expect(localStorage.getItem("sd-agent-follow")).toBe("0");
    expect(button("Add invoices to context")).not.toBeNull();
    act(() => button("Add invoices to context")!.click());
    expect(chips()).toEqual(["quotes", "invoices"]);
    act(() => button("Remove invoices from context")!.click());

    const box = host.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
    type(box, "Look");
    await act(async () => key(box, "Enter"));
    await act(() => Bun.sleep(5));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ prompt: "Look", refs: [quotes] });
    // The message is kept for Up, and its bubble names the file it went with.
    expect(JSON.parse(localStorage.getItem("sd-agent-history")!)).toEqual(["Look"]);
    expect(host.querySelector(".agent-msg.user .agent-msg-refs")!.textContent).toBe("quotes");
    unmount();
    await agentChat.end("s1").catch(() => undefined);
  });

  test("a message to a running session carries the files", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({});
    }) as unknown as typeof fetch;
    await agentChat.send("s9", "hello", [], ["src/a.ts"]);
    await agentChat.send("s9", "hello");
    expect(bodies).toEqual([{ text: "hello", refs: ["src/a.ts"] }, { text: "hello" }]);
  });
});

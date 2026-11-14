// Messages sent while the agent is at work, as the pane shows them
// (specs/agents/agent-pane.feature.md "A message sent while the agent works
// waits for the turn"): the reduction of the server's events in
// src/frontend/agentChat.ts, the waiting row, and then the pane itself — the
// message box takes a message mid-turn, and "Send now" and the remove button
// call the server. React needs a DOM for the clicks, so this file borrows one
// the way tests/agentComposer.test.tsx does.
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
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPane, WaitingRow } from "../src/frontend/AgentPane";
import {
  EMPTY_TRANSCRIPT,
  agentChat,
  applyEvent,
  takesMessages,
  waitingMessages,
  waitingState,
} from "../src/frontend/agentChat";
import type { ChatEvent } from "../src/frontend/agentChat";
import { Toaster } from "../src/frontend/Toasts";
import { CLAUDE_AGENT, agent } from "./fixtures/agents";

let seq = 0;
const ev = (body: object, at = "2026-11-13T10:00:00.000Z"): ChatEvent => ({ ...body, seq: ++seq, at }) as ChatEvent;
const reduce = (events: ChatEvent[]) => events.reduce(applyEvent, EMPTY_TRANSCRIPT);

/** An agent with no Stop, as Pi's plugin might declare one. */
const UNSTOPPABLE = agent({ id: "bare", label: "Bare", capabilities: { canInterrupt: false } as never });

describe("waiting messages in the transcript", () => {
  test("a queued message waits under the transcript, and joins it where it was sent", () => {
    const working = reduce([
      ev({ kind: "user", id: "u1", text: "go" }),
      ev({ kind: "queued", id: "q1", text: "and then this", refs: ["src/a.ts"] }),
      ev({ kind: "queued", id: "q2", text: "and this" }),
      ev({ kind: "assistant", messageId: "m1", turn: 1, blocks: [{ type: "text", text: "Working." }], parentToolUseId: null }),
    ]);
    // Not transcript items yet: what the agent says meanwhile stays above them.
    expect(working.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(waitingMessages(working)).toMatchObject([
      { id: "q1", text: "and then this", refs: ["src/a.ts"] },
      { id: "q2", text: "and this" },
    ]);
    // Sent: the `user` event with its id moves it into the transcript's end.
    const sent = applyEvent(working, ev({ kind: "user", id: "q1", text: "and then this", refs: ["src/a.ts"] }));
    expect(sent.items.map((i) => i.kind)).toEqual(["user", "assistant", "user"]);
    expect(sent.items.at(-1)).toMatchObject({ kind: "user", text: "and then this", refs: ["src/a.ts"] });
    expect(waitingMessages(sent).map((m) => m.id)).toEqual(["q2"]);
  });

  test("a message taken back leaves the waiting list, and a transcript with none has an empty one", () => {
    expect(waitingMessages(EMPTY_TRANSCRIPT)).toEqual([]);
    const t = reduce([
      ev({ kind: "user", id: "u1", text: "go" }),
      ev({ kind: "queued", id: "q1", text: "never mind" }),
      ev({ kind: "unqueued", id: "q1" }),
      // One for a message the transcript never saw (a replay) changes nothing.
      ev({ kind: "unqueued", id: "q9" }),
    ]);
    expect(waitingMessages(t)).toEqual([]);
    expect(t.items.map((i) => i.kind)).toEqual(["user"]);
  });

  test("the message box takes a message while the agent works, not while it starts or after it ended", () => {
    expect(takesMessages("idle")).toBe(true);
    expect(takesMessages("running")).toBe(true);
    expect(takesMessages("awaiting_input")).toBe(true);
    expect(takesMessages("starting")).toBe(false);
    expect(takesMessages("ended")).toBe(false);
    expect(takesMessages("error")).toBe(false);
  });

  test("a waiting message offers Send now where the agent can be stopped or is ready, and never after the end", () => {
    expect(waitingState("running", CLAUDE_AGENT)).toEqual({
      label: "Queued — sent when this turn ends",
      sendNow: true,
      hint: "Stop Claude and send this message now",
    });
    expect(waitingState("awaiting_input", CLAUDE_AGENT).sendNow).toBe(true);
    // No Stop, no Send now: the message goes when the turn ends.
    expect(waitingState("running", UNSTOPPABLE)).toMatchObject({ label: "Queued — sent when this turn ends", sendNow: false });
    // The turn before was stopped or failed: nothing to stop, it just goes.
    expect(waitingState("idle", UNSTOPPABLE)).toEqual({ label: "Not sent yet", sendNow: true, hint: "Send this message now" });
    expect(waitingState("starting", CLAUDE_AGENT)).toMatchObject({ label: "Queued — sent once Claude is ready", sendNow: false });
    expect(waitingState("ended", CLAUDE_AGENT)).toEqual({ label: "Not sent — the session ended", sendNow: false, hint: "" });
  });

  test("a waiting row shows the message, what it waits for, Send now and a way to take it back", () => {
    const message = { id: "q1", text: "and then this", at: "2026-11-13T10:00:00.000Z", refs: ["specs/billing/quotes.feature.md"] };
    const row = (status: Parameters<typeof waitingState>[0], who = CLAUDE_AGENT) =>
      renderToStaticMarkup(<WaitingRow message={message} status={status} agent={who} onSendNow={() => {}} onRemove={() => {}} />);
    const running = row("running");
    expect(running).toContain('class="agent-msg user agent-waiting"');
    expect(running).toContain("and then this");
    expect(running).toContain("quotes");
    expect(running).toContain("Queued — sent when this turn ends");
    expect(running).toContain(">Send now</button>");
    expect(running).toContain('aria-label="Remove waiting message"');
    expect(row("running", UNSTOPPABLE)).not.toContain("Send now");
    const ended = row("ended");
    expect(ended).toContain("Not sent — the session ended");
    expect(ended).not.toContain("Send now");
    expect(ended).not.toContain("Remove waiting message");
  });
});

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

/** Type into the message box the way React hears it under happy-dom. */
function type(el: HTMLTextAreaElement, text: string) {
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

describe("the pane with a session at work", () => {
  afterEach(() => {
    localStorage.clear();
    agentChat.setAgents([]);
  });

  test("the message box sends a message mid-turn, and Send now and remove on a waiting one call the server", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const at = "2026-11-13T10:00:00.000Z";
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/choices")) return Response.json({ choices: null });
      if (url === "/api/agent/chat/s1") {
        const meta = {
          id: "s1",
          name: "Work",
          agent: "claude",
          cwd: "/w/data",
          dataRepo: "/w/data",
          project: "/w/data",
          startedAt: at,
          status: "running",
          permissionMode: "auto",
          lastSeq: 4,
        };
        const events = [
          { kind: "status", status: "running", seq: 1, at },
          { kind: "user", id: "u1", text: "go", seq: 2, at },
          { kind: "queued", id: "q1", text: "and then this", seq: 3, at },
          { kind: "queued", id: "q2", text: "never mind", seq: 4, at },
        ];
        return Response.json({ meta, commands: [], events });
      }
      // The live stream: open, and silent, until the session is forgotten.
      if (url.startsWith("/api/agent/chat/s1/events")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener("abort", () => controller.close());
            },
          }),
        );
      }
      // What the pane reads on its own (the folder's branch) is not the point.
      if ((init.method ?? "GET") === "GET") return Response.json({});
      calls.push({
        method: init.method!,
        url,
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      // A message that went meanwhile: the server knows no such waiting one.
      if (url.includes("/waiting/q2")) return Response.json({ error: "no such waiting message — it may have been sent" }, { status: 404 });
      return Response.json({});
    }) as unknown as typeof fetch;
    agentChat.setAgents([CLAUDE_AGENT]);
    await act(() => agentChat.openSession("s1"));
    const { host, unmount } = mount(
      <>
        <AgentPane compact={false} demo={false} codeRepo={null} dataRepo="/w/data" onClose={() => {}} />
        <Toaster />
      </>,
    );
    await act(() => Bun.sleep(5));
    // The waiting messages sit under the transcript, each with Send now.
    const rows = () => [...host.querySelectorAll(".agent-msg.agent-waiting")];
    expect(rows().map((r) => r.textContent)).toEqual([
      "and then thisQueued — sent when this turn endsSend now",
      "never mindQueued — sent when this turn endsSend now",
    ]);
    expect(host.querySelector(".agent-transcript")!.lastElementChild).toBe(rows()[1]!);

    // The box is open while the agent works, and says what Enter does.
    const box = host.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(host.querySelector(".agent-composer-hint")!.textContent).toBe(
      "Claude is working — Enter queues a message for when this turn ends",
    );
    type(box, "one more");
    await act(async () => {
      box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await act(() => Bun.sleep(5));
    expect(calls).toEqual([{ method: "POST", url: "/api/agent/chat/s1/message", body: { text: "one more" } }]);
    expect(box.value).toBe("");

    // Send now names the message; so does the remove button.
    await act(async () => (rows()[0]!.querySelector("button.agent-waiting-send") as HTMLButtonElement).click());
    await act(async () => (rows()[0]!.querySelector('button[aria-label="Remove waiting message"]') as HTMLButtonElement).click());
    // One the server no longer has is no error to show.
    await act(async () => (rows()[1]!.querySelector("button.agent-waiting-send") as HTMLButtonElement).click());
    await act(() => Bun.sleep(5));
    expect(calls.slice(1)).toEqual([
      { method: "POST", url: "/api/agent/chat/s1/waiting/q1/send" },
      { method: "DELETE", url: "/api/agent/chat/s1/waiting/q1" },
      { method: "POST", url: "/api/agent/chat/s1/waiting/q2/send" },
    ]);
    // (Toasts other tests left up are not this one's.)
    const toasts = [...document.querySelectorAll(".toast-message")].map((t) => t.textContent ?? "");
    expect(toasts.filter((t) => t.includes("waiting message"))).toEqual([]);
    unmount();
    await agentChat.end("s1").catch(() => undefined);
  });
});

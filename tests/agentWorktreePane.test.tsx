// The Worktree checkbox in the coding agent pane's bar (specs/agents/
// agent-pane.feature.md "A session can run in its own git worktree"): it
// asks the server whether the folder can have a worktree, remembers the
// last pick, sends it with the first message, and a worktree session shows
// its branch beside the folder it was started in. React needs a DOM for the
// effects, so this file borrows one the way tests/agentImagePaste.test.tsx does.
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

afterEach(() => {
  globalThis.fetch = realFetch;
  localStorage.clear();
  forgetFolderInfos();
  agentChat.setAgents([]);
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentPane, knownFolders, sessionFolder } from "../src/frontend/AgentPane";
import { agentChat, forgetFolderInfos, worktreeClosedNote } from "../src/frontend/agentChat";
import type { ChatSessionMeta, ChatWorktree } from "../src/frontend/agentChat";
import { toast } from "../src/frontend/Toasts";
import { CLAUDE_AGENT } from "./fixtures/agents";

const WORKTREE: ChatWorktree = {
  folder: "/w/code",
  repo: "/w/code",
  path: "/home/.specdriven/worktrees/code-abc123/fix-login-1a2b3c",
  cwd: "/home/.specdriven/worktrees/code-abc123/fix-login-1a2b3c",
  branch: "specdriven/fix-login-1a2b3c",
  base: "main",
};

const META: ChatSessionMeta = {
  id: "s1",
  name: "Fix login",
  agent: "claude",
  cwd: WORKTREE.cwd,
  worktree: WORKTREE,
  dataRepo: "/w/data",
  project: "/w/data",
  codeRepo: WORKTREE.cwd,
  startedAt: "2026-11-06T10:00:00.000Z",
  status: "idle",
  permissionMode: "auto",
  lastSeq: 0,
};

/** A server where /w/code is a repo on main and /w/data is not; POSTs are kept. */
function server(posts: Record<string, unknown>[]) {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("/api/agent/folder?")) {
      const path = new URL(url, "http://x").searchParams.get("path");
      return Response.json(
        path === "/w/code"
          ? { canWorktree: true, repo: "/w/code", branch: "main" }
          : { canWorktree: false, reason: "Not a git repository" },
      );
    }
    if (url === "/api/agent/chat" && init.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Response.json(META);
    }
    if (url === "/api/agent/chat/s1" && init.method === "DELETE") {
      return Response.json({ ok: true, worktree: "kept" });
    }
    if (url === "/api/agent/chat/s1") return Response.json({ meta: META, commands: [], events: [] });
    if (url.startsWith("/api/agent/chat/s1/events")) return new Response(new ReadableStream());
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

const pane = (codeRepo: string | null = "/w/code", ghostty = false) => (
  <AgentPane
    compact={false}
    demo={false}
    codeRepo={codeRepo}
    dataRepo="/w/data"
    onClose={() => {}}
    ghostty={ghostty}
  />
);

/** Type into a controlled textarea the way React hears it under happy-dom. */
function type(el: HTMLTextAreaElement, text: string) {
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

const settle = () => act(() => Bun.sleep(5));

test("the Worktree box offers a worktree for a repo, remembers the pick, and the first message asks for one", async () => {
  const posts: Record<string, unknown>[] = [];
  server(posts);
  agentChat.setAgents([CLAUDE_AGENT]);
  const { host, unmount } = mount(pane());
  const box = () => host.querySelector<HTMLInputElement>('input[aria-label="Worktree"]')!;
  await settle();
  expect(box().disabled).toBe(false);
  expect(box().checked).toBe(false);

  act(() => box().click());
  expect(box().checked).toBe(true);
  expect(localStorage.getItem("sd-agent-worktree")).toBe("1");
  expect(host.textContent).toContain("in a git worktree of its own on a new branch");

  type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!, "Fix login");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  await settle();
  expect(posts[0]).toMatchObject({ name: "Fix login", agent: "claude", prompt: "Fix login", worktree: true });
  unmount();
  await agentChat.end("s1").catch(() => undefined);
});

test("a folder that is no repo greys the box out, and the remembered pick is not sent there", async () => {
  const posts: Record<string, unknown>[] = [];
  server(posts);
  localStorage.setItem("sd-agent-worktree", "1");
  agentChat.setAgents([CLAUDE_AGENT]);
  // No code repo: the session would start in the data repo, which is no repo.
  const { host, unmount } = mount(pane(null));
  await settle();
  const box = host.querySelector<HTMLInputElement>('input[aria-label="Worktree"]')!;
  expect(box.disabled).toBe(true);
  expect(box.checked).toBe(false);
  expect(host.querySelector(".agent-bar-check")!.className).toContain("is-disabled");

  type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!, "Tidy specs");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  await settle();
  expect(posts[0]).not.toHaveProperty("worktree");
  // The pick itself is kept for the next folder that can.
  expect(localStorage.getItem("sd-agent-worktree")).toBe("1");
  unmount();
  await agentChat.end("s1").catch(() => undefined);
});

test("a worktree session shows the folder it was started in and its branch, and closing it says a kept worktree's place", async () => {
  server([]);
  agentChat.setAgents([CLAUDE_AGENT]);
  await agentChat.openSession("s1");
  const { host, unmount } = mount(pane());
  expect(host.querySelector('[aria-label="Folder: /w/code"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Worktree branch: specdriven/fix-login-1a2b3c"]')).not.toBeNull();
  // Picking the folder it was started in is no move.
  expect(sessionFolder(META)).toBe("/w/code");
  expect(knownFolders("/w/code", "/w/data", [META])).toEqual(["/w/code", "/w/data"]);
  unmount();

  expect(worktreeClosedNote(META, "kept")).toBe(
    `Kept the worktree at ${WORKTREE.path} — it has uncommitted changes (branch ${WORKTREE.branch})`,
  );
  expect(worktreeClosedNote(META, "removed")).toBeNull();
  expect(worktreeClosedNote({}, "kept")).toBeNull();
  await agentChat.end("s1");
});

// specs/agents/agent-pane.feature.md "A worktree session opens in a Ghostty shell".
test("with Ghostty on, a click on the worktree's branch asks the server to open a shell there, and a refusal is toasted", async () => {
  server([]);
  const asked: string[] = [];
  let answer: Response = Response.json({ folder: WORKTREE.cwd });
  const serve = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    if (String(input) === "/api/agent/chat/s1/ghostty" && init.method === "POST") {
      asked.push(String(input));
      return answer;
    }
    return serve(input, init);
  }) as unknown as typeof fetch;
  const errors: string[] = [];
  const realError = toast.error;
  toast.error = (message: string) => {
    errors.push(message);
    return 0;
  };
  try {
    agentChat.setAgents([CLAUDE_AGENT]);
    await agentChat.openSession("s1");

    // Off, the branch is a label: nothing to click.
    const off = mount(pane());
    expect(off.host.querySelector('[aria-label="Worktree branch: specdriven/fix-login-1a2b3c"]')!.tagName).toBe("SPAN");
    expect(off.host.querySelector("button.agent-bar-branch")).toBeNull();
    off.unmount();

    const { host, unmount } = mount(pane("/w/code", true));
    const chip = host.querySelector<HTMLButtonElement>("button.agent-bar-branch")!;
    expect(chip.getAttribute("aria-label")).toBe("Worktree branch: specdriven/fix-login-1a2b3c — open in Ghostty");
    expect(chip.textContent).toBe("specdriven/fix-login-1a2b3c");
    act(() => chip.click());
    await settle();
    expect(asked).toEqual(["/api/agent/chat/s1/ghostty"]);
    expect(errors).toEqual([]);

    answer = Response.json({ error: "Ghostty not found" }, { status: 502 });
    act(() => chip.click());
    await settle();
    expect(asked).toHaveLength(2);
    expect(errors).toEqual(["Ghostty not found"]);
    unmount();
  } finally {
    toast.error = realError;
    await agentChat.end("s1");
  }
});

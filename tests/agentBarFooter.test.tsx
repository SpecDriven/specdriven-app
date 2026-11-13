// The footer of the coding agent pane's message box (specs/agents/
// agent-pane.feature.md "Footer cmponents"): the folder, then the branch it
// has checked out, then the Worktree box; the folder's and the branch's
// names capped so neither crowds out the other chips; and one row that stays
// usable down to the pane's narrowest, where nothing may sit on top of its
// neighbour. The order and the branch are checked on a mounted pane (React
// needs a DOM, borrowed the way tests/agentWorktreePane.test.tsx does); the
// widths are the stylesheet's, so they are read from it.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const realNow = Date.now;

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
  Date.now = realNow;
  localStorage.clear();
  forgetFolderInfos();
  agentChat.setAgents([]);
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentPane } from "../src/frontend/AgentPane";
import { agentChat, folderBranch, forgetFolderInfos, loadFolderInfo, useFolderInfo } from "../src/frontend/agentChat";
import type { ChatSessionMeta, FolderGitInfo } from "../src/frontend/agentChat";
import { CLAUDE_AGENT } from "./fixtures/agents";

/** A session in the folder itself: no worktree of its own. */
const META: ChatSessionMeta = {
  id: "s1",
  name: "Fix login",
  agent: "claude",
  cwd: "/w/code",
  dataRepo: "/w/data",
  project: "/w/data",
  codeRepo: "/w/code",
  startedAt: "2026-11-12T10:00:00.000Z",
  status: "idle",
  permissionMode: "auto",
  lastSeq: 0,
};

/** A server where /w/code is a repo on `branch()` and /w/data is not; folder asks are counted. */
function server(branch: () => string, asked: string[] = []) {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("/api/agent/folder?")) {
      const path = new URL(url, "http://x").searchParams.get("path")!;
      asked.push(path);
      return Response.json(
        path === "/w/code"
          ? { canWorktree: true, repo: "/w/code", branch: branch() }
          : { canWorktree: false, reason: "Not a git repository" },
      );
    }
    if (url === "/api/agent/chat/s1" && init.method === "DELETE") return Response.json({ ok: true });
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
    render: (next: React.ReactElement) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const pane = (codeRepo: string | null = "/w/code") => (
  <AgentPane compact={false} demo={false} codeRepo={codeRepo} dataRepo="/w/data" onClose={() => {}} />
);

const settle = () => act(() => Bun.sleep(5));

/** What the left of the bar holds, in order, by the names a reader would give them. */
function leftOfBar(host: HTMLElement): string[] {
  const side = host.querySelector(".agent-bar .agent-bar-side")!;
  return [...side.children].map((el) => {
    if (el.matches(".agent-bar-picker")) return el.getAttribute("data-picker")!;
    if (el.matches(".agent-bar-check")) return "worktree box";
    return el.getAttribute("aria-label") ?? el.className;
  });
}

test("a new session's bar shows the folder, then the branch it has checked out, then the Worktree box", async () => {
  server(() => "main");
  agentChat.setAgents([CLAUDE_AGENT]);
  const { host, unmount } = mount(pane());
  // While the folder is asked about there is no branch to name yet.
  expect(leftOfBar(host)).toEqual(["folder", "worktree box"]);
  await settle();
  expect(leftOfBar(host)).toEqual(["folder", "Branch: main", "worktree box"]);
  const branch = host.querySelector('[aria-label="Branch: main"]')!;
  expect(branch.textContent).toBe("main");
  // A fact, not a menu: the folder is picked on its chip, the branch in git.
  expect(branch.tagName).toBe("SPAN");
  unmount();

  // A folder that is in no repo has no branch, and the box stays where it was.
  const none = mount(pane(null));
  await settle();
  expect(leftOfBar(none.host)).toEqual(["folder", "worktree box"]);
  none.unmount();
});

test("a session in the folder itself shows the branch the folder has checked out", async () => {
  server(() => "feature/login");
  agentChat.setAgents([CLAUDE_AGENT]);
  await agentChat.openSession("s1");
  const { host, unmount } = mount(pane());
  await settle();
  // No Worktree box in a running session: it was picked when the session started.
  expect(leftOfBar(host)).toEqual(["folder", "Branch: feature/login"]);
  expect(host.querySelector('[aria-label^="Worktree branch"]')).toBeNull();
  unmount();
  await agentChat.end("s1");
});

test("the branch is read again when the stamp changes and when the window is looked at again", async () => {
  let branch = "main";
  const asked: string[] = [];
  server(() => branch, asked);
  // Every look at the clock is two seconds on: an answer is never fresh enough to keep.
  let clock = realNow();
  Date.now = () => (clock += 2_000);
  const seen: (string | undefined)[] = [];
  function Probe({ stamp }: { stamp: string }) {
    seen.push(useFolderInfo("/w/code", stamp)?.branch);
    return null;
  }
  const { render, unmount } = mount(<Probe stamp="idle" />);
  await settle();
  expect(asked).toEqual(["/w/code"]);
  expect(seen.at(-1)).toBe("main");

  // The agent switched branches in a turn: the session's status moved on.
  branch = "feature/login";
  render(<Probe stamp="running" />);
  await settle();
  expect(asked).toHaveLength(2);
  expect(seen.at(-1)).toBe("feature/login");

  // The same stamp again asks nothing.
  render(<Probe stamp="running" />);
  await settle();
  expect(asked).toHaveLength(2);

  // The user switched it in a terminal and came back to the window.
  branch = "main";
  act(() => void window.dispatchEvent(new window.Event("focus") as unknown as Event));
  await settle();
  expect(asked).toHaveLength(3);
  expect(seen.at(-1)).toBe("main");
  unmount();

  // Unmounted, the window is no longer listened to.
  act(() => void window.dispatchEvent(new window.Event("focus") as unknown as Event));
  await settle();
  expect(asked).toHaveLength(3);
});

test("two readers asking again in the same moment share one answer", async () => {
  const asked: string[] = [];
  server(() => "main", asked);
  function Probe() {
    useFolderInfo("/w/code");
    return null;
  }
  const { unmount } = mount(
    <>
      <Probe />
      <Probe />
    </>,
  );
  await settle();
  expect(asked).toHaveLength(1);
  // The bar and the session popover both hear the window's focus, some time
  // on: one more ask between them.
  Date.now = () => realNow() + 5_000;
  act(() => void window.dispatchEvent(new window.Event("focus") as unknown as Event));
  await settle();
  expect(asked).toHaveLength(2);
  unmount();
});

test("a folder's answer is kept for a while, asked for again once older than the reader allows, and a failed ask is no repository", async () => {
  let branch = "main";
  const asked: string[] = [];
  server(() => branch, asked);
  expect((await loadFolderInfo("/w/code")).branch).toBe("main");
  // The bar asks on every render: the kept answer serves it.
  branch = "feature/login";
  expect((await loadFolderInfo("/w/code")).branch).toBe("main");
  expect(asked).toHaveLength(1);
  // A reader that wants the branch as it is now takes no kept answer…
  expect((await loadFolderInfo("/w/code", 0)).branch).toBe("feature/login");
  expect(asked).toHaveLength(2);
  // …and what it learned is what the next patient reader gets.
  expect((await loadFolderInfo("/w/code")).branch).toBe("feature/login");
  expect(asked).toHaveLength(2);

  // A server that cannot say leaves the Worktree box greyed out, with why.
  globalThis.fetch = (async () => Response.json({ error: "No such folder" }, { status: 404 })) as unknown as typeof fetch;
  expect(await loadFolderInfo("/w/gone")).toEqual({ canWorktree: false, reason: "No such folder" });
});

test("a branch is named as git names it, a detached HEAD as detached, and no repository not at all", () => {
  const repo: FolderGitInfo = { canWorktree: true, repo: "/w/code", branch: "feature/login" };
  expect(folderBranch(repo)).toEqual({ name: "feature/login", tooltip: "Branch feature/login is checked out · /w/code" });
  expect(folderBranch({ ...repo, branch: "HEAD" })).toEqual({
    name: "detached",
    tooltip: "Detached HEAD — no branch is checked out · /w/code",
  });
  expect(folderBranch({ canWorktree: true, branch: "main" })!.tooltip).toBe("Branch main is checked out");
  expect(folderBranch({ canWorktree: false, reason: "Not a git repository" })).toBeNull();
  expect(folderBranch(null)).toBeNull();
});

// --- The stylesheet --------------------------------------------------------

const CSS = readFileSync(join(import.meta.dir, "../src/frontend/index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every rule whose selector list holds `selector`, later rules winning. */
function declarations(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(CSS))) {
    if (!m[1]!.split(",").some((s) => s.trim() === selector)) continue;
    for (const decl of m[2]!.split(";")) {
      const at = decl.indexOf(":");
      if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
  }
  return out;
}

/** How readily a chip gives way: the shrink factor of its `flex` shorthand (0 for `none`). */
function shrink(selector: string): number {
  const flex = declarations(selector).flex ?? "";
  return flex === "none" ? 0 : Number(flex.split(/\s+/)[1]);
}

const rem = (value: string | undefined) => (value?.endsWith("rem") ? Number(value.slice(0, -3)) : NaN);

/** The widest box (rem) at which a narrow-box rule for `selector` applies. */
function narrowStep(selector: string): number {
  const block = /@container agent-composer \(max-width: ([\d.]+)rem\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g;
  let widest = NaN;
  let m: RegExpExecArray | null;
  while ((m = block.exec(CSS))) {
    const selectors = [...m[2]!.matchAll(/([^{}]+)\{/g)].flatMap((s) => s[1]!.split(",").map((x) => x.trim()));
    if (selectors.includes(selector)) widest = Math.max(Number.isNaN(widest) ? 0 : widest, Number(m[1]));
  }
  return widest;
}

const FOLDER = '.agent-bar-picker[data-picker="folder"]';
const MODEL = '.agent-bar-picker[data-picker="model"]';

test("the folder's and the branch's names are capped below the width any chip may take", () => {
  const folderName = rem(declarations(`${FOLDER} .agent-bar-chip-text`)["max-width"]);
  const branchName = rem(declarations(".agent-bar-branch .agent-bar-chip-text")["max-width"]);
  const anyChip = rem(declarations(".agent-bar-chip")["max-width"]);
  expect(folderName).toBeGreaterThan(0);
  expect(branchName).toBe(folderName);
  expect(folderName).toBeLessThan(anyChip);
  // The cap is on the name: a capped chip would count its whole name when the
  // row shares out what to give up, and squeeze its neighbour in its place.
  expect(declarations(".agent-bar-branch")["max-width"]).toBeUndefined();
  expect(declarations(".agent-bar-chip.agent-bar-branch")["max-width"]).toBeUndefined();
  // A name cut off ends in an ellipsis.
  expect(declarations(".agent-bar-chip-text")).toMatchObject({ overflow: "hidden", "text-overflow": "ellipsis" });
});

test("the bar is one row laid out chip by chip, so a chip gives way and never sits on its neighbour", () => {
  expect(declarations(".agent-bar")).toMatchObject({ display: "flex", "flex-wrap": "nowrap" });
  // The two sides are no boxes of their own: a side narrower than its chips
  // is what put the Worktree box on top of the model's name.
  expect(declarations(".agent-bar-side").display).toBe("contents");
  // The folder and the branch give way first, then the model, then the rest;
  // the Worktree box and Send never do.
  expect(shrink(FOLDER)).toBe(shrink(".agent-bar-branch"));
  expect(shrink(FOLDER)).toBeGreaterThanOrEqual(shrink(MODEL) * 1e6);
  expect(shrink(MODEL)).toBeGreaterThanOrEqual(shrink(".agent-bar-picker") * 1e6);
  expect(shrink(".agent-bar-picker")).toBeGreaterThan(0);
  expect(shrink(".agent-bar-check")).toBe(0);
  // In the model's chip the effort gives way before the model's name, and
  // the agent's icon never does.
  expect(shrink(".agent-bar-chip-more")).toBeGreaterThanOrEqual(1e6);
  expect(declarations(".agent-bar-chip-more")).toMatchObject({ overflow: "hidden", "text-overflow": "ellipsis" });
  expect(shrink(".agent-icon")).toBe(0);
  expect(shrink(".agent-send")).toBe(0);
  // A chip cut down still shows a few letters.
  for (const chip of [FOLDER, ".agent-bar-branch", MODEL, ".agent-bar-picker"]) {
    expect(rem(declarations(chip)["min-width"])).toBeGreaterThanOrEqual(2);
  }
});

test("a narrowing bar drops its chevrons, the Worktree word, a new session's branch and the folder's icon, in that order", () => {
  const steps = [
    narrowStep(".agent-bar-chevron"),
    narrowStep(".agent-bar-check-text"),
    // Only beside the Worktree box: a running session keeps its branch.
    narrowStep(".agent-bar-side:has(.agent-bar-check) .agent-bar-branch"),
    narrowStep(`${FOLDER} .agent-bar-chip > svg:not(.agent-bar-chevron)`),
  ];
  expect(steps.every((s) => s > 0)).toBe(true);
  expect([...steps].sort((a, b) => b - a)).toEqual(steps);
  expect(new Set(steps).size).toBe(steps.length);
  // The last steps are still in force at the pane's narrowest: 420px less the
  // message box's own padding is under 25rem.
  expect(steps.at(-1)!).toBeGreaterThanOrEqual(24);
});

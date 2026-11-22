// The Resources tab (src/frontend/ResourcesPanel.tsx, specs/app/resource-
// usage.feature.md [proposed]) driven in a borrowed DOM against a fake
// /api/resources/*: memory groups and their total, measured again while the
// tab is shown and not while the window is hidden; disk groups with tags and
// cleanup buttons; a cleanup sent only after the user confirms, with what
// the server needs; a blocked one not offered; errors shown.
//
// The DOM is borrowed the way tests/imagesPage.test.tsx borrows it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/observability" });
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

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConfirmOptions } from "../src/frontend/ModalPrompts";
import { DISK_SECTION, MEMORY_SECTION, ResourcesPanel } from "../src/frontend/ResourcesPanel";
import {
  CLEANUP_URL,
  DISK_URL,
  MEMORY_POLL_MS,
  MEMORY_URL,
  cleanupPrompt,
  formatSize,
  shares,
  type DiskSnapshot,
  type MemorySnapshot,
} from "../src/frontend/resources";
import { toast } from "../src/frontend/Toasts";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const memory = (agentsMb: number): MemorySnapshot => ({
  at: 1,
  totalBytes: (300 + agentsMb) * MB,
  systemBytes: 32 * GB,
  desktop: true,
  groups: [
    { id: "app", label: "SpecDriven", bytes: 300 * MB, branches: [{ label: "Main process", bytes: 300 * MB, processes: [{ pid: 100, name: "SpecDriven", bytes: 300 * MB }] }] },
    {
      id: "agents",
      label: "Agents",
      bytes: agentsMb * MB,
      branches: [
        {
          label: "Claude Code",
          bytes: agentsMb * MB,
          processes: [
            { pid: 110, name: "claude", bytes: (agentsMb - 10) * MB },
            { pid: 111, name: "node", bytes: 10 * MB },
          ],
        },
      ],
    },
  ],
});

const WT_CLEAN = "/home/me/.specdriven/worktrees/code-abc/clean";
const WT_DIRTY = "/home/me/.specdriven/worktrees/code-abc/dirty";
const WT_BUSY = "/home/me/.specdriven/worktrees/code-abc/busy";

const disk = (withClean = true): DiskSnapshot => ({
  at: 1,
  totalBytes: 3 * GB,
  volumes: [{ path: "/home/me/.specdriven", freeBytes: 100 * GB, totalBytes: 500 * GB }],
  groups: [
    {
      id: "app",
      label: "App",
      bytes: 2 * GB,
      entries: [
        { id: "app-version:1.1", label: "Version 1.1", path: "/home/me/.specdriven/app/specdriven-1.1", bytes: GB, tags: ["running"] },
        {
          id: "app-version:1.0",
          label: "Version 1.0",
          path: "/home/me/.specdriven/app/specdriven-1.0",
          bytes: GB,
          tags: ["kept to go back to"],
          cleanup: { kind: "previous-version", target: "1.0", label: "Delete", warning: "Version 1.0 is deleted.", bytes: GB },
        },
      ],
    },
    {
      id: "agents",
      label: "Agents",
      bytes: GB,
      entries: [
        {
          id: "worktrees",
          label: "Agent worktrees",
          path: "/home/me/.specdriven/worktrees",
          bytes: GB,
          children: [
            ...(withClean
              ? [{ id: `worktree:${WT_CLEAN}`, label: "clean", path: WT_CLEAN, bytes: 300 * MB, tags: [], cleanup: { kind: "worktree" as const, target: WT_CLEAN, label: "Remove", warning: "The folder goes.", bytes: 300 * MB } }]
              : []),
            {
              id: `worktree:${WT_DIRTY}`,
              label: "dirty",
              path: WT_DIRTY,
              bytes: 400 * MB,
              tags: ["uncommitted changes"],
              cleanup: { kind: "worktree", target: WT_DIRTY, label: "Remove", warning: "It has uncommitted changes, and they are lost.", bytes: 400 * MB, force: true },
            },
            {
              id: `worktree:${WT_BUSY}`,
              label: "busy",
              path: WT_BUSY,
              bytes: 300 * MB,
              tags: ["in use"],
              cleanup: { kind: "worktree", target: WT_BUSY, label: "Remove", warning: "The folder goes.", bytes: 300 * MB, blocked: "A running agent session works in it" },
            },
          ],
        },
      ],
    },
  ],
});

/** The handlers React gave an element. */
function reactProps(el: Element): Record<string, (e: unknown) => void> {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key]!;
}

function click(el: Element) {
  reactProps(el).onClick!({ target: el, currentTarget: el, preventDefault() {} });
}

type Call = { url: string; init?: RequestInit };

function server(opts: { memoryStatus?: number } = {}) {
  const calls: Call[] = [];
  let memoryReads = 0;
  let cleaned = false;
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === MEMORY_URL) {
      if (opts.memoryStatus) return Response.json({ error: "Resources are not shown in the demo" }, { status: opts.memoryStatus });
      memoryReads++;
      return Response.json(memory(100 * memoryReads));
    }
    if (url.startsWith(DISK_URL)) return Response.json(disk(!cleaned));
    if (url === CLEANUP_URL) {
      cleaned = true;
      return Response.json({ freedBytes: 300 * MB });
    }
    return Response.json({ error: `unexpected ${url}` }, { status: 500 });
  };
  return { calls, fetcher, memoryReads: () => memoryReads };
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

async function mount(fetcher: (url: string, init?: RequestInit) => Promise<Response>, confirm: (o: ConfirmOptions) => Promise<boolean>, pollMs = 40) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => root.render(<ResourcesPanel fetcher={fetcher} confirm={confirm} pollMs={pollMs} />));
  await flush();
  return { container, root };
}

const button = (c: Element, row: string) => {
  const r = [...c.querySelectorAll(".res-row")].find((el) => el.querySelector(".res-row-label, .res-caret-btn")?.textContent === row);
  return r?.querySelector(".res-action button") as HTMLButtonElement | null | undefined;
};

describe("helpers", () => {
  test("memory is measured every 3 seconds by default", () => {
    expect(MEMORY_POLL_MS).toBe(3000);
  });

  test("sizes read as people read them", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(4.25 * MB)).toBe("4.3 MB");
    expect(formatSize(250 * MB)).toBe("250 MB");
    expect(formatSize(1.2 * GB)).toBe("1.2 GB");
  });

  test("a tiny group still shows in the bar; nothing at all is empty", () => {
    expect(shares([{ bytes: 1000 }, { bytes: 1 }, { bytes: 0 }])).toEqual([expect.closeTo(99.9, 1), 0.5, 0]);
    expect(shares([{ bytes: 0 }])).toEqual([0]);
  });

  test("the confirmation names what goes and how much it frees", () => {
    const d = disk();
    const wt = d.groups[1]!.entries[0]!.children![1]!;
    expect(cleanupPrompt(wt, wt.cleanup!)).toEqual({
      title: "Remove the worktree dirty?",
      body: "It has uncommitted changes, and they are lost. This frees about 400 MB.",
      confirmLabel: "Remove",
    });
    const version = d.groups[0]!.entries[1]!;
    expect(cleanupPrompt(version, version.cleanup!).title).toBe("Delete version 1.0?");
  });
});

describe("the tab", () => {
  // The toast store is one per test process; these tests keep it clean.
  const toasts: string[] = [];
  const real = { success: toast.success, error: toast.error };
  beforeAll(() => {
    toast.success = (m: string) => (toasts.push(`success: ${m}`), 0);
    toast.error = (m: string) => (toasts.push(`error: ${m}`), 0);
  });
  afterAll(() => Object.assign(toast, real));

  test("memory groups with the total, measured again while shown and not while the window is hidden", async () => {
    const s = server();
    const { container, root } = await mount(s.fetcher, async () => true);
    expect(container.textContent).toContain("400 MB");
    expect(container.textContent).toContain("of 32 GB on this computer");
    const heads = [...container.querySelectorAll(`#${MEMORY_SECTION} .res-group-head h3`)].map((h) => h.textContent);
    expect(container.querySelector(`#${DISK_SECTION}`)).not.toBeNull();
    expect(heads).toEqual(["SpecDriven", "Agents"]);
    // Claude Code has two processes: they open under it.
    const claude = [...container.querySelectorAll(".res-caret-btn")].find((b) => b.textContent === "Claude Code")!;
    expect(container.textContent).not.toContain("pid 111");
    await act(async () => click(claude));
    expect(container.textContent).toContain("pid 111");

    await wait(120);
    const shown = s.memoryReads();
    expect(shown).toBeGreaterThanOrEqual(2);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(10);
    const hidden = s.memoryReads();
    await wait(150);
    expect(s.memoryReads()).toBe(hidden);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(10);
    expect(s.memoryReads()).toBeGreaterThan(hidden);

    await act(async () => root.unmount());
    const gone = s.memoryReads();
    await wait(120);
    expect(s.memoryReads()).toBe(gone);
  });

  test("disk groups with free space, tags, and a cleanup only after confirming", async () => {
    const s = server();
    const asked: ConfirmOptions[] = [];
    let answer = false;
    const { container, root } = await mount(s.fetcher, async (o) => {
      asked.push(o);
      return answer;
    }, 60_000);
    expect(container.textContent).toContain("3 GB");
    expect(container.textContent).toContain("100 GB free of 500 GB");
    expect([...container.querySelectorAll(".res-tag")].map((t) => t.textContent)).toEqual(["running", "kept to go back to", "uncommitted changes", "in use"]);
    expect(container.querySelector(".res-tag.warn")!.textContent).toBe("uncommitted changes");
    expect(button(container, "Version 1.1")).toBeNull();
    expect(button(container, "busy")!.disabled).toBe(true);
    expect(button(container, "busy")!.title).toBe("A running agent session works in it");

    // Declined: nothing is sent.
    await act(async () => click(button(container, "dirty")!));
    await flush();
    expect(asked[0]).toMatchObject({ title: "Remove the worktree dirty?", confirmLabel: "Remove", danger: true });
    expect(s.calls.some((c) => c.url === "/api/resources/cleanup")).toBe(false);

    // Confirmed: the server gets what it needs, then the disk is measured again.
    answer = true;
    await act(async () => click(button(container, "clean")!));
    await flush();
    await flush();
    const sent = s.calls.find((c) => c.url === "/api/resources/cleanup")!;
    expect(sent.init?.method).toBe("POST");
    expect(JSON.parse(String(sent.init?.body))).toEqual({ kind: "worktree", target: WT_CLEAN });
    expect(s.calls.at(-1)!.url).toBe("/api/resources/disk?refresh=1");
    expect(button(container, "clean")).toBeUndefined();
    expect(toasts).toEqual(["success: Freed 300 MB"]);

    // A worktree with changes is sent with force.
    await act(async () => click(button(container, "dirty")!));
    await flush();
    const forced = s.calls.filter((c) => c.url === "/api/resources/cleanup").at(-1)!;
    expect(JSON.parse(String(forced.init?.body))).toEqual({ kind: "worktree", target: WT_DIRTY, force: true });
    await act(async () => root.unmount());
  });

  test("a refused request shows the server's reason", async () => {
    const s = server({ memoryStatus: 403 });
    const { container, root } = await mount(s.fetcher, async () => true, 60_000);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Resources are not shown in the demo");
    await act(async () => root.unmount());
  });
});

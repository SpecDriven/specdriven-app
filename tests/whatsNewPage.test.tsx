// What's new (src/frontend/WhatsNewPage.tsx, specs/app/release-notes.feature.md
// [proposed]) rendered in a borrowed DOM: every release CHANGELOG.md lists,
// newest first, each change linked to its pull request and the installed
// version marked; the user menu's entry and the mark an update leaves until
// its notes are opened.
//
// The DOM is borrowed the way tests/dataPage.test.tsx borrows it.
import { afterAll, beforeAll, expect, test } from "bun:test";
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
  happyWindow = new Window({ url: "http://localhost/whats-new" });
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
import { createRoot } from "react-dom/client";
import pkg from "../package.json";
import { whatsNewMenuItem } from "../src/frontend/App";
import type { Release } from "../src/frontend/releaseNotes";
import { RELEASES, WhatsNewPage, hasUnseenNotes, markNotesSeen } from "../src/frontend/WhatsNewPage";

const releases: Release[] = [
  { version: "0.2.0", date: "2026-11-03", entries: [{ title: "Search every feature", pr: 12 }, { title: "A direct commit", pr: null }] },
  { version: "0.1.9", date: "2026-11-01", entries: [] },
];

async function mount(installed: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<WhatsNewPage installed={installed} releases={releases} onClose={() => {}} />));
  return { container, root };
}

test("What's new lists every release newest first, each change linked to its pull request", async () => {
  const { container, root } = await mount("0.1.9");
  try {
    const headings = [...container.querySelectorAll(".page-section h2")].map((h) => h.textContent);
    expect(headings).toEqual(["v0.2.0", "v0.1.9"]);
    const items = [...container.querySelectorAll("#release-0-2-0 li")].map((li) => li.textContent);
    expect(items).toEqual(["Search every feature #12", "A direct commit"]);
    const link = container.querySelector("#release-0-2-0 a")!;
    expect(link.getAttribute("href")).toBe("https://github.com/SpecDriven/specdriven-app/pull/12");
    expect(link.getAttribute("target")).toBe("_blank");
    // A release that merged nothing of note still says so.
    expect(container.querySelector("#release-0-1-9 li")?.textContent).toBe("Maintenance release.");
  } finally {
    act(() => root.unmount());
  }
});

test("the installed version's release is marked as installed", async () => {
  const { container, root } = await mount("0.1.9");
  try {
    expect(container.querySelector("#release-0-1-9 .release-installed")?.textContent).toBe("Installed");
    expect(container.querySelector("#release-0-2-0 .release-installed")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

test("the build carries the notes for the version it is", () => {
  expect(RELEASES[0]?.version).toBe(pkg.version);
});

test("an update is marked until its notes are opened; a first run is not", () => {
  const storage = new Map<string, string>();
  const fake = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  } as unknown as Storage;
  // First run: nothing new to point at, and this version is now the one seen.
  expect(hasUnseenNotes("0.1.9", fake)).toBe(false);
  expect(hasUnseenNotes("0.1.9", fake)).toBe(false);
  // Updated: the new version's notes are news until What's new is opened.
  expect(hasUnseenNotes("0.2.0", fake)).toBe(true);
  markNotesSeen("0.2.0", fake);
  expect(hasUnseenNotes("0.2.0", fake)).toBe(false);
  // No version known yet, or no storage: nothing is marked.
  expect(hasUnseenNotes(null, fake)).toBe(false);
  expect(hasUnseenNotes("0.3.0", null)).toBe(false);
});

test("the user menu's What's new opens the page, with a dot while there are unread notes", async () => {
  let opened = 0;
  const item = whatsNewMenuItem(true, () => opened++);
  expect(item.id).toBe("whats-new");
  item.onSelect!();
  expect(opened).toBe(1);

  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<>{item.label}</>));
    expect(container.textContent).toBe("What's new");
    expect(container.querySelector(".unseen-dot")?.getAttribute("aria-label")).toBe("new release notes");
    await act(async () => root.render(<>{whatsNewMenuItem(false, () => {}).label}</>));
    expect(container.querySelector(".unseen-dot")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

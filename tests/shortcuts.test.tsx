// The app's keyboard registry (specs/ui/ui.feature.md "Design system",
// src/frontend/shortcuts.tsx): one window listener dispatches every
// shortcut. A browser's autofill into a field — an email field, a password
// manager — fires a keydown with no key at all, which must be nobody's
// shortcut rather than a crash of the whole page (seen on the Settings
// page's Claude account email, 2026-10-19).

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { sharedKeys, useShortcuts, type Shortcut } from "../src/frontend/shortcuts";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "Element",
  "Node",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

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
  await new Promise((r) => setTimeout(r, 0));
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

let root: Root | undefined;
let host: HTMLElement | undefined;
let fired: string[];

beforeEach(() => {
  fired = [];
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

function Keys({ shortcuts }: { shortcuts: Shortcut[] }) {
  useShortcuts(shortcuts);
  return <input aria-label="email" type="email" />;
}

const shortcut = (id: string, keys: string, inFields = false): Shortcut => ({
  id,
  keys,
  label: id,
  group: "test",
  inFields,
  run: () => {
    fired.push(id);
  },
});

const press = (init: KeyboardEventInit, target: EventTarget = window) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
};

test("a keydown with no key — a browser's autofill — matches no shortcut and throws nothing", () => {
  root = createRoot(host!);
  act(() => root!.render(<Keys shortcuts={[shortcut("search", "mod+k", true), shortcut("create", "c")]} />));
  const field = host!.querySelector("input")!;
  // No `key` at all, as Chrome's autofill sends it into the focused field.
  const blank = new KeyboardEvent("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(blank, "key", { value: undefined });
  expect(() => act(() => void field.dispatchEvent(blank))).not.toThrow();
  expect(fired).toEqual([]);
  expect(blank.defaultPrevented).toBe(false);
});

test("real keys still dispatch — a field keeps single letters, takes shortcuts marked for fields", () => {
  root = createRoot(host!);
  act(() => root!.render(<Keys shortcuts={[shortcut("search", "mod+k", true), shortcut("create", "c")]} />));
  const field = host!.querySelector("input")!;
  press({ key: "c" }, field);
  expect(fired).toEqual([]);
  press({ key: "k", metaKey: true }, field);
  expect(fired).toEqual(["search"]);
  press({ key: "c" });
  expect(fired).toEqual(["search", "create"]);
});

// The pane's `c` (specs/editor/spec-editor.feature.md "Spec editor pane"):
// a new scenario after the open one — but a `c` typed into the body
// (CodeMirror's contenteditable) is just a c, and a shortcut whose `when`
// says no stays quiet.
test("single letters stand down in a contenteditable body and behind a false `when`", () => {
  root = createRoot(host!);
  let allowed = false;
  const create: Shortcut = { ...shortcut("create", "c"), when: () => allowed };
  act(() => root!.render(<Keys shortcuts={[create]} />));
  const body = document.createElement("div");
  body.setAttribute("contenteditable", "true");
  host!.appendChild(body);
  press({ key: "c" });
  expect(fired).toEqual([]);
  allowed = true;
  press({ key: "c" }, body);
  expect(fired).toEqual([]);
  press({ key: "c" });
  expect(fired).toEqual(["create"]);
});

// One chord, one owner (src/frontend/shortcuts.tsx sharedKeys): dispatch is
// first-match, so a second claim on `g i` — the Issues tab's and Images' —
// left Images' key dead while its menu row still showed it.
test("sharedKeys names a combo two shortcuts claim, and nothing a display-only one shares", () => {
  const issues: Shortcut = shortcut("go-issues", "g i");
  const images: Shortcut = shortcut("images", "g m");
  expect(sharedKeys([issues, images])).toEqual([]);
  expect(sharedKeys([issues, { ...images, keys: ["mod+i", "g i"] }])).toEqual(["g i"]);
  expect(sharedKeys([issues, { ...images, keys: "g i", displayOnly: true }])).toEqual([]);
});

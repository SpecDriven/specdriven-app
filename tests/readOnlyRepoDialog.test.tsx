// git-operations.md "a spec folder that cannot be pushed to opens read
// only" (issue #467), the dialog and the words around it: what it says for a
// folder with no remote and for a remote that turned the account down, the
// remote named the way people read it, the way into Settings for a sign-in
// problem, and Check again — closing once the folder unlocks, saying so when
// it is still read only.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/" });
  const w = happyWindow as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    let value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (w[key] ?? w.window);
    if (typeof value === "function" && /^[a-z]/.test(key)) value = (value as Function).bind(w);
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

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReadOnlyRepoDialog } from "../src/frontend/ReadOnlyRepoDialog";
import {
  currentRepoReadOnly,
  fixedInSettings,
  parseRepoReadOnly,
  readOnlySummary,
  remoteLabel,
  setRepoReadOnly,
  useRepoReadOnly,
} from "../src/frontend/repoReadOnly";
import type { RepoReadOnly } from "../src/frontend/repoReadOnly";

let reactRoot: Root | undefined;
let host: HTMLElement | undefined;

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  host?.remove();
  reactRoot = undefined;
  setRepoReadOnly(null);
});

async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  reactRoot = createRoot(host);
  await act(async () => reactRoot!.render(node));
}

const button = (label: string) =>
  [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label) ?? null;

const DENIED: RepoReadOnly = {
  kind: "denied",
  remote: "git@github.com:SpecDriven/specs-private.git",
  reason: "ERROR: Write access to repository not granted.",
};

test("a folder with no remote is told to add one and check again, with no way into Settings", async () => {
  await render(
    <ReadOnlyRepoDialog why={{ kind: "no-remote" }} folder="local" onClose={() => {}} onCheckAgain={async () => null} onOpenSettings={() => {}} />,
  );
  const text = host!.textContent ?? "";
  expect(text).toContain("This folder is read only");
  expect(text).toContain("The git repository of local has no remote");
  expect(text).toContain("git remote add origin <url>");
  expect(button("Open Settings")).toBeNull();
  expect(button("Check again")).not.toBeNull();
});

test("a refused push names the remote as people read it and shows what it said", async () => {
  let settings = 0;
  let closed = 0;
  await render(
    <ReadOnlyRepoDialog
      why={DENIED}
      folder="specs-private"
      onClose={() => closed++}
      onCheckAgain={async () => DENIED}
      onOpenSettings={() => settings++}
    />,
  );
  const text = host!.textContent ?? "";
  expect(text).toContain("You cannot push to github.com/SpecDriven/specs-private");
  expect(text).toContain("ERROR: Write access to repository not granted.");
  await act(async () => button("Open Settings")!.click());
  expect(settings).toBe(1);
  expect(closed).toBe(1);
});

test("Check again says when the folder is still read only, and closes once it unlocks", async () => {
  let answer: RepoReadOnly | null = DENIED;
  let closed = 0;
  await render(
    <ReadOnlyRepoDialog why={DENIED} folder="specs-private" onClose={() => closed++} onCheckAgain={async () => answer} />,
  );
  // Without Settings to open (the hosted app), there is no such button.
  expect(button("Open Settings")).toBeNull();
  await act(async () => button("Check again")!.click());
  expect(host!.textContent).toContain("Checked again: still read only.");
  expect(closed).toBe(0);
  answer = null;
  await act(async () => button("Check again")!.click());
  expect(closed).toBe(1);
});

test("the remote is shown without its scheme, a credential or .git", () => {
  expect(remoteLabel("git@github.com:o/r.git")).toBe("github.com/o/r");
  expect(remoteLabel("https://user:token@github.com/o/r.git")).toBe("github.com/o/r");
  expect(remoteLabel("ssh://git@ghe.example.com/o/r")).toBe("ghe.example.com/o/r");
  expect(remoteLabel("/srv/git/specs.git")).toBe("/srv/git/specs");
});

test("the Read only line says why in one sentence, and a sign-in problem points to Settings", () => {
  expect(readOnlySummary({ kind: "no-remote" })).toContain("has no remote");
  expect(readOnlySummary(DENIED)).toBe("Read only — you cannot push to github.com/SpecDriven/specs-private");
  expect(fixedInSettings(DENIED)).toBe(false);
  expect(fixedInSettings({ kind: "denied", remote: "x", reason: "authentication required — sign in with GitHub in Settings" })).toBe(true);
  expect(fixedInSettings({ kind: "no-remote" })).toBe(false);
});

test("only no remote and a refusal lock the folder; anything else the server says leaves it editable", async () => {
  expect(parseRepoReadOnly({ kind: "no-remote" })).toEqual({ kind: "no-remote" });
  expect(parseRepoReadOnly({ kind: "denied", remote: "r", reason: "no" })).toEqual({ kind: "denied", remote: "r", reason: "no" });
  expect(parseRepoReadOnly({ kind: "unknown", reason: "offline" })).toBeNull();
  expect(parseRepoReadOnly(null)).toBeNull();

  // Every reader of the store follows one answer.
  const seen: (RepoReadOnly | null)[] = [];
  function Probe() {
    seen.push(useRepoReadOnly());
    return null;
  }
  await render(<Probe />);
  await act(async () => setRepoReadOnly({ kind: "no-remote" }));
  expect(currentRepoReadOnly()).toEqual({ kind: "no-remote" });
  expect(seen.at(-1)).toEqual({ kind: "no-remote" });
  await act(async () => setRepoReadOnly(null));
  expect(seen.at(-1)).toBeNull();
});

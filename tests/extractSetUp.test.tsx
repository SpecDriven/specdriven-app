// specs/app/extract-specs-from-code.feature.md "Target specs repo is not
// initialized" as the dialog plays it: the server answers an empty
// repository named as the existing folder with a question, the dialog asks
// it, and only on a yes is the folder sent again to be set up. React needs a
// DOM for the clicks, so this file borrows one the way
// tests/agentWorktreePane.test.tsx does.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "HTMLInputElement",
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

// Every dialog is unmounted before the next test, and all of them before
// this file hands its DOM back: a root left mounted would commit into
// whatever DOM the next test file brings, and fail its tests instead.
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExtractSpecsDialog, type ExtractAnalysis, type ExtractCreated } from "../src/frontend/ExtractSpecsDialog";
import { analyseModules } from "../src/server/intentModules";

const FRESH = "/work/specs-jitter";
const analysis: ExtractAnalysis = {
  codeDir: "/work/shop",
  proposal: analyseModules({
    name: "shop",
    files: ["package.json", "packages/api/package.json", "packages/api/src/server.ts"].map((path) => ({ path, size: 100 })),
    manifests: { "package.json": '{"workspaces":["packages/*"]}', "packages/api/package.json": '{"name":"api"}' },
  }),
  name: "specs-shop",
  target: "/work/specs-shop",
  targetState: "free",
  specsLink: "missing",
  existing: FRESH,
};

/** The dialog on its last step, adding to FRESH, with the server answering `answers` in turn. */
async function mount(answers: { status: number; body: unknown }[], start: ExtractAnalysis = analysis) {
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body ?? "{}")));
    const answer = answers.shift()!;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  const created: ExtractCreated[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <ExtractSpecsDialog agents={[]} initialAnalysis={start} initialStep="repo" onCreated={(c) => created.push(c)} onClose={() => {}} />,
    );
  });
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  const click = async (label: string) => {
    await act(async () => {
      button(label)!.click();
    });
    await act(async () => {});
  };
  return { host, sent, created, button, click };
}

const ASKED = { status: 409, body: { error: `${FRESH} is not set up as a specification folder yet`, initialize: true, dir: FRESH } };
const ADDED = { status: 201, body: { dir: FRESH, existing: true, setUp: true, folders: ["specs/api"], github: null } };

test("an empty repository is asked about, and set up only on a yes", async () => {
  const dialog = await mount([ASKED, ADDED]);
  await dialog.click("Add and open");
  expect(dialog.sent).toHaveLength(1);
  expect(dialog.sent[0]!.initialize).toBeUndefined();
  // A question, not a refusal: no error, and nothing opened yet.
  expect(dialog.host.querySelector(".error")).toBeNull();
  expect(dialog.host.querySelector('[aria-label="Set up the folder"]')?.textContent).toContain(
    `${FRESH} is not set up as a specification folder yet. Set it up?`,
  );
  expect(dialog.created).toHaveLength(0);
  await dialog.click("Set it up and add");
  expect(dialog.sent[1]).toMatchObject({ existing: FRESH, initialize: true });
  expect(dialog.created).toHaveLength(1);
  expect(dialog.created[0]!.created).toMatchObject({ dir: FRESH, setUp: true });
});

test("Not now leaves the folder as it is", async () => {
  const dialog = await mount([ASKED]);
  await dialog.click("Add and open");
  await dialog.click("Not now");
  expect(dialog.host.querySelector('[aria-label="Set up the folder"]')).toBeNull();
  expect(dialog.sent).toHaveLength(1);
  expect(dialog.created).toHaveLength(0);
});

test("set up from where the new folder would go, the yes is already given", async () => {
  const beside = { ...analysis, existing: null, targetState: "unset" as const };
  const dialog = await mount([{ status: 201, body: { ...ADDED.body, dir: beside.target } }], beside);
  await dialog.click("Set it up and add to it");
  expect(dialog.host.textContent).toContain("It is set up as a specification folder first");
  await dialog.click("Add and open");
  expect(dialog.sent).toEqual([expect.objectContaining({ existing: beside.target, initialize: true })]);
  expect(dialog.created).toHaveLength(1);
});

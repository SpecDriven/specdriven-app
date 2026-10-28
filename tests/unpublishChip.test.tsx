// specs/editor/spec-editor.feature.md "Unpublish a Spec": in a published
// scenario's editor pane the status chip is a menu with Back to proposed
// while Settings allows deleting published specs, and a plain badge
// otherwise. Picking it moves the scenario back to [proposed] and leaves the
// pane on it, now with the proposed chip.
//
// This mounts the real App in happy-dom, routes its fetches to the real API
// over a temporary data folder, and opens a published scenario by its link
// (the same harness as scenarioEditorDraft.test.tsx).
// over a temporary data folder, and opens a draft scenario by its link.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLFormElement",
  "Element",
  "Node",
  "Text",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "PopStateEvent",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
  "sessionStorage",
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
import { App } from "../src/frontend/App";
import { readFeature } from "../src/server/features";
import { handleApi, reloader } from "../src/server/api";
import { writeState } from "../src/server/state";

const FEATURE = "# Quotes\n\n## Renewal @v1 [published]\n\nGiven a quote for {amount}\n";

let root: string;
let home: string;
let data: string;
let reactRoot: Root | undefined;
let host: HTMLElement | undefined;
const realFetch = globalThis.fetch;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

async function setUp(deletePublished: boolean) {
  root = await mkdtemp(join(tmpdir(), "specdriven-unpublish-chip-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-unpublish-chip-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  await Bun.write(join(data, "specs/quotes.feature.md"), FEATURE);
  await writeState(
    { dataRepo: data, reloadFrequencySeconds: 0, ...(deletePublished ? { deletePublished } : {}) },
    root,
  );
  // The app's relative fetches go to the real API; anything it has no route
  // for answers 404, the way the server would.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost/");
    const res = await handleApi(new Request(url, init));
    return res ?? new Response("Not found", { status: 404 });
  }) as typeof fetch;
}

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  host?.remove();
  reactRoot = undefined;
  globalThis.fetch = realFetch;
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function openLink(path: string) {
  happyWindow!.happyDOM.setURL(`http://localhost${path}`);
  host = document.createElement("div");
  document.body.appendChild(host);
  reactRoot = createRoot(host);
  await act(async () => reactRoot!.render(<App />));
}

/** Waits for the app's fetches and renders to settle on `done`. */
async function until(done: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (done()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  throw new Error(`gave up waiting for ${what}; the page shows: ${host?.textContent?.slice(0, 400)}`);
}

const chipButton = (status: string) =>
  host!.querySelector<HTMLButtonElement>(`button.status-chip[aria-label="Status: ${status}"]`);

describe("the published status chip", () => {
  test("with the setting on, Back to proposed moves the scenario back", async () => {
    await setUp(true);
    await openLink("/features/quotes/scenarios/renewal");
    await until(() => chipButton("published") !== null, "the published status chip menu");

    await act(async () => chipButton("published")!.click());
    const item = [...host!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes("Back to proposed"),
    );
    expect(item).toBeDefined();
    await act(async () => item!.click());
    await until(() => chipButton("proposed") !== null, "the proposed status chip");

    expect(await readFeature(data, "specs/quotes.feature.md")).toContain(
      "## S1: Renewal @v1 [proposed]",
    );
  });

  test("with the setting off, it is a plain badge", async () => {
    await setUp(false);
    await openLink("/features/quotes/scenarios/renewal");
    await until(() => Boolean(host?.querySelector(".status-chip")), "the status chip");
    expect(chipButton("published")).toBeNull();
    expect(host!.querySelector("span.status-chip.static")?.textContent).toContain("published");
  });
});

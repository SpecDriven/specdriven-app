// specs/editor/spec-editor.feature.md "Spec editor pane": a draft scenario
// opens in the editor pane with its body ready to edit. #275 deleted the
// scenario table component but left one use of it under the body, behind
// `!editingPublished`, so every draft or proposed scenario replaced the pane
// with "This view hit an error" while published ones opened fine. Bun builds
// without type checking, so nothing caught it before release.
//
// This mounts the real App in happy-dom, routes its fetches to the real API
// over a temporary data folder, and opens a draft scenario by its link.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import { handleApi, reloader } from "../src/server/api";
import { writeState } from "../src/server/state";

const FEATURE = "# Quotes\n\n## Renewal @v1\n\nGiven a quote for {amount}\n";

let root: string;
let home: string;
let reactRoot: Root | undefined;
let host: HTMLElement | undefined;
const realFetch = globalThis.fetch;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-draft-editor-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-draft-editor-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  const data = join(root, "data");
  await Bun.write(join(data, "specs/quotes.feature.md"), FEATURE);
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);
  // The app's relative fetches go to the real API; anything it has no route
  // for answers 404, the way the server would.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost/");
    const res = await handleApi(new Request(url, init));
    return res ?? new Response("Not found", { status: 404 });
  }) as typeof fetch;
});

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

describe("opening a draft scenario", () => {
  test("shows its editor, not the error note", async () => {
    await openLink("/features/quotes/scenarios/renewal");
    await until(
      () => Boolean(host?.textContent?.includes("Given a quote")) || Boolean(host?.textContent?.includes("hit an error")),
      "the scenario editor",
    );

    expect(host!.textContent).not.toContain("This view hit an error");
    expect(host!.textContent).toContain("Given a quote for {amount}");
    expect(host!.querySelector('[aria-label="Resize the body editor"]')).not.toBeNull();
  });
});

// git-operations.md "a push that fails is shown, and tried again", on the
// page: while the app cannot push, the Sync button says so, a toast gives
// the reason, and the editors stop promising that the next sync pushes the
// edit — until a push goes through, when all three go back to normal.
//
// Before this the commits piled up on the computer in silence: the tick's
// result only reached the log, the Sync button ignored it, and every editor
// kept reading "the next sync pushes it".
//
// This mounts the real App in happy-dom over the real API and a real clone
// (the harness of unpublishChip.test.tsx). The remote is taken away and put
// back by renaming the bare origin.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mkdtemp, rename, rm } from "node:fs/promises";
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
import { App, fetchListing } from "../src/frontend/App";
import { pushHint, setSyncProblem } from "../src/frontend/syncProblem";
import { handleApi, reloader } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import { reloadData } from "../src/server/reload";
import { writeState } from "../src/server/state";
import { twoClones } from "./helpers/fixtures";

let root: string;
let home: string;
let reactRoot: Root | undefined;
let host: HTMLElement | undefined;
const realFetch = globalThis.fetch;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  host?.remove();
  reactRoot = undefined;
  globalThis.fetch = realFetch;
  setSyncProblem(null);
  reloader.stop();
  setGitEngine(null);
  if (root) await rm(root, { recursive: true, force: true });
  if (home) await rm(home, { recursive: true, force: true });
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
  for (let i = 0; i < 150; i++) {
    if (done()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  throw new Error(`gave up waiting for ${what}; the page shows: ${host?.textContent?.slice(0, 400)}`);
}

const syncButton = () => host!.querySelector<HTMLButtonElement>("button.repo-sync");
const toasts = (kind: string) =>
  [...host!.querySelectorAll<HTMLElement>(`.toast.${kind} .toast-message`)].map((el) => el.textContent ?? "");
const hint = () => host!.querySelector<HTMLElement>(".readme-hint");

test("while a push fails the Sync button, a toast and the autosave hint say so, and all clear once it goes through", async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-syncproblem-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-syncproblem-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  setGitEngine("cli");
  const { a: data, originDir } = await twoClones(root);
  // No cron: the ticks below are the test's own, and the Sync button's.
  await writeState({ dataRepo: "a", reloadFrequencySeconds: 0 }, root);
  await reloadData(root);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost/");
    const res = await handleApi(new Request(url, init));
    return res ?? new Response("Not found", { status: 404 });
  }) as typeof fetch;

  // An edit is committed by a tick that cannot push it.
  await rename(originDir, `${originDir}.away`);
  await Bun.write(join(data, "README.md"), "# Project\n\nedited\n");
  expect(await reloadData(root)).toContain("push failed");

  await openLink("/");
  await until(() => syncButton()?.classList.contains("failing") === true, "the Sync button to show the failing push");
  expect(syncButton()!.getAttribute("aria-label")).toBe("Sync — saved changes are not being pushed");
  expect(toasts("error").some((m) => m.startsWith("Saved changes are not being pushed: "))).toBe(true);
  await until(() => hint()?.textContent?.includes("Autosaves") === true, "the home page's autosave hint");
  expect(hint()!.textContent).toContain("saved on this computer only — the push is failing.");
  expect(hint()!.textContent).not.toContain("the next sync pushes it");

  // The remote is back: Sync pushes what was waiting, with nothing new to save.
  await rename(`${originDir}.away`, originDir);
  await act(async () => syncButton()!.click());
  await until(() => syncButton()?.classList.contains("failing") === false && !syncButton()!.disabled, "the Sync button to recover");

  expect(syncButton()!.getAttribute("aria-label")).toBe("Sync");
  expect(toasts("error")).toEqual([]);
  expect(toasts("success")).toContain("Saved changes pushed");
  expect(hint()!.textContent).toContain("the next sync pushes it.");
});

test("the listing carries the push problem to the page, and null when there is none", async () => {
  const reply = (body: object) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const failing = await fetchListing(reply({ features: [], syncProblem: "authentication required — add a GitHub personal access token in Settings" }));
  expect("listing" in failing && failing.listing.syncProblem).toBe(
    "authentication required — add a GitHub personal access token in Settings",
  );
  const fine = await fetchListing(reply({ features: [], syncProblem: null }));
  expect("listing" in fine && fine.listing.syncProblem).toBeNull();
  // An older server sends no such field.
  const older = await fetchListing(reply({ features: [] }));
  expect("listing" in older && older.listing.syncProblem).toBeNull();
});

test("an autosave hint promises a push only while pushes go through", () => {
  expect(pushHint(null)).toBe("the next sync pushes it.");
  expect(pushHint("authentication required — add a GitHub personal access token in Settings")).toBe(
    "saved on this computer only — the push is failing.",
  );
});

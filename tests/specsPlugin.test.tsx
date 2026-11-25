// specs/app/plugins.feature.md "Specs is a built-in plugin" and "A folder's
// plugins are picked from its data the first time it opens": the Specs tab,
// its rail icon and its tree are there only while the plugin is on in the
// open folder, and a folder that holds notebook entries and no feature opens
// on the Notebook alone, with the folder's README in the pane.
//
// This mounts the real App in happy-dom and routes its fetches to the real
// API over a temporary data folder (the harness of unpublishChip.test.tsx).
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
  "HTMLSelectElement",
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
import { handleApi, reloader, syncedOnStart } from "../src/server/api";
import { syncPlugins } from "../src/plugins/host/loader";
import { syncClientPlugins } from "../src/plugins/client/loader";
import { writeState } from "../src/server/state";

const ENTRY = "# Chose the queue\n\n**Author:** Dana\n**Date:** 2026-11-20\n**Kind:** decision\n\nWe went with the queue.\n";
const FEATURE = "# Quotes\n\n## Renewal @v1 [proposed]\n\nGiven a quote\n";

let root: string;
let home: string;
let data: string;
let reactRoot: Root | undefined;
let host: HTMLElement | undefined;
const realFetch = globalThis.fetch;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return (await handleApi(new Request(`http://localhost${path}`, init))) ?? new Response("Not found", { status: 404 });
}

const putState = (body: unknown) =>
  api("/api/state", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

async function setUp(files: Record<string, string>) {
  root = await mkdtemp(join(tmpdir(), "specdriven-specs-plugin-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-specs-plugin-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  // No plugin mounted from a test file before this one: each half's store
  // loads from this folder.
  await syncClientPlugins([]);
  await syncPlugins({});
  data = join(root, "data");
  await Bun.write(join(data, "README.md"), "# The folder\n");
  for (const [name, text] of Object.entries(files)) await Bun.write(join(data, name), text);
  // A file this app wrote: it keeps per-folder lists and has none for the
  // folder yet, so opening it is the first look at its data.
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0, plugins: { repos: {} } }, root);
  localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost/");
    return api(url.pathname + url.search, init);
  }) as typeof fetch;
}

async function unmount() {
  await act(async () => reactRoot?.unmount());
  host?.remove();
  reactRoot = undefined;
}

afterEach(async () => {
  // Error toasts never expire and their store is process-wide: a note left
  // here would show in the next file's App.
  for (const close of host?.querySelectorAll<HTMLElement>(".toast-close") ?? []) {
    await act(async () => close.click());
  }
  await unmount();
  await syncedOnStart();
  globalThis.fetch = realFetch;
  reloader.stop();
  await syncClientPlugins([]);
  await syncPlugins({});
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

async function open(path: string) {
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

const sideTabs = () => [...host!.querySelectorAll<HTMLElement>('.side-tabs [role="tab"]')].map((el) => el.textContent?.trim());
const railLinks = () => [...host!.querySelectorAll<HTMLElement>("a.rail-link")].map((el) => el.getAttribute("aria-label"));
// Booleans, not elements: a failed expectation on an element prints the whole DOM.
const specsPanel = () => host!.querySelector("#side-panel-specs") !== null;
const sidebarText = () => host!.querySelector("aside:not(.rail)")?.textContent ?? "";
const readmeOpen = () => [...host!.querySelectorAll(".crumb.current")].some((el) => el.textContent === "README.md");

describe("Specs is a built-in plugin", () => {
  test("a folder of notebook entries opens on the Notebook alone, with the README in the pane", async () => {
    await setUp({ "notebook/2026-11-20-chose-the-queue.md": ENTRY });
    await open("/");
    await until(() => sidebarText().includes("Chose the queue"), "the notebook's list in the sidebar");

    // One tab is no tab bar, and Specs has no panel.
    expect(sideTabs()).toEqual([]);
    expect(specsPanel()).toBe(false);
    expect(readmeOpen()).toBe(true);
    const rows = (await (await api("/api/state")).json()).plugins as { id: string; enabled: boolean }[];
    expect(rows.filter((p) => p.enabled).map((p) => p.id)).toEqual(["notebook"]);
  });

  test("switched on, Specs is a tab where the list puts it, and its tree is the sidebar when picked", async () => {
    await setUp({ "notebook/2026-11-20-chose-the-queue.md": ENTRY });
    await open("/");
    await until(() => sidebarText().includes("Chose the queue"), "the notebook's list in the sidebar");
    await unmount();

    expect((await putState({ plugins: { enabled: ["notebook", "specs"] } })).status).toBe(200);
    await open("/");
    await until(() => sideTabs().length === 2, "the tab bar");
    expect(sideTabs()).toEqual(["Notebook", "Specs"]);
    // The notebook is first, so it is the tab shown; Specs' tree follows a click.
    expect(specsPanel()).toBe(false);
    await act(async () => host!.querySelector<HTMLElement>("#side-tab-specs")!.click());
    expect(specsPanel()).toBe(true);
    expect(host!.querySelector("#side-tab-specs")!.getAttribute("aria-selected")).toBe("true");
  });

  test("a folder with features and notebook entries shows both, Specs first", async () => {
    await setUp({ "notebook/2026-11-20-chose-the-queue.md": ENTRY, "specs/quotes.feature.md": FEATURE });
    await open("/");
    await until(() => sideTabs().length === 2, "the tab bar");
    expect(sideTabs()).toEqual(["Specs", "Notebook"]);
    expect(specsPanel()).toBe(true);
    expect(sidebarText()).toContain("Quotes");
  });

  test("the rail carries the tabs in the list's order, Specs only while it is on", async () => {
    await setUp({ "notebook/2026-11-20-chose-the-queue.md": ENTRY, "specs/quotes.feature.md": FEATURE });
    localStorage.setItem("sd-sidebar-collapsed", "1");
    await open("/");
    await until(() => railLinks().includes("Notebook"), "the rail's tabs");
    expect(railLinks().filter((label) => label === "Specs" || label === "Notebook")).toEqual(["Specs", "Notebook"]);
    await unmount();

    expect((await putState({ plugins: { enabled: ["notebook"] } })).status).toBe(200);
    await open("/");
    await until(() => railLinks().includes("Notebook"), "the rail's tabs");
    expect(railLinks()).not.toContain("Specs");
  });

  test("with Specs switched off a feature's link opens home", async () => {
    await setUp({ "notebook/2026-11-20-chose-the-queue.md": ENTRY, "specs/quotes.feature.md": FEATURE });
    await api("/api/state");
    expect((await putState({ plugins: { enabled: ["notebook"] } })).status).toBe(200);
    await open("/features/quotes");
    await until(() => sidebarText().includes("Chose the queue"), "the notebook's list in the sidebar");
    expect(readmeOpen()).toBe(true);
    expect(specsPanel()).toBe(false);
    expect(host!.textContent).not.toContain("Renewal");
  });

  test("with every plugin switched off the sidebar says where to switch one on", async () => {
    await setUp({});
    await api("/api/state");
    expect((await putState({ plugins: { enabled: [] } })).status).toBe(200);
    await open("/");
    await until(() => sidebarText().includes("No plugin is on in this folder"), "the empty sidebar's hint");
    expect(host!.querySelector('aside:not(.rail) a[href="/plugins"]') !== null).toBe(true);
  });
});

// What the Specs tab does today, pinned before it moves out of App.tsx into
// its plugin (the client-half series): each of these must pass unchanged
// after every step of that move.

/** Presses one key the way a person does, outside any field. */
async function press(key: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** Types into a React-controlled input: in happy-dom React hears the prototype's
    setter followed by a keyup, not an `input` event. */
async function typeInto(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    input.focus();
    setValue.call(input, text);
    input.dispatchEvent(new KeyboardEvent("keyup", { key: text.slice(-1), bubbles: true }));
  });
}

const dialogTitle = () => host!.querySelector(".modal-dialog h3")?.textContent ?? null;
const paletteInput = () => host!.querySelector<HTMLInputElement>('.palette input[role="combobox"]');
const paletteLabels = () => [...host!.querySelectorAll(".palette-item .palette-label")].map((el) => el.textContent);
const toasts = () => [...host!.querySelectorAll(".toast-message")].map((el) => el.textContent ?? "");
const featureOpen = () => (host!.textContent ?? "").includes("Renewal");

const BOTH = { "notebook/2026-11-20-chose-the-queue.md": ENTRY, "specs/quotes.feature.md": FEATURE };

describe("The Specs tab's behaviour, kept through its move into the plugin", () => {
  test("a feature's link opens that feature, with its url and the window's title", async () => {
    await setUp(BOTH);
    await open("/features/quotes");
    await until(() => document.title === "SpecDriven — Quotes", "the feature's title");
    expect(location.pathname).toBe("/features/quotes");
    expect(featureOpen()).toBe(true);
    expect(readmeOpen()).toBe(false);
    expect(specsPanel()).toBe(true);
  });

  test("a versionless scenario link opens the scenario and settles on its versioned url", async () => {
    await setUp(BOTH);
    await open("/features/quotes/scenarios/renewal");
    await until(() => location.pathname === "/features/quotes/scenarios/renewal/v1", "the canonical scenario url");
    await until(() => document.title === "SpecDriven — Quotes · Renewal v1", "the scenario's title");
  });

  test("a feature picked in the tree goes back home on Back", async () => {
    await setUp(BOTH);
    await open("/");
    await until(() => sidebarText().includes("Quotes"), "the tree");
    const row = [...host!.querySelectorAll<HTMLElement>("#side-panel-specs .tree-feature")].find(
      (el) => el.textContent?.includes("Quotes"),
    )!;
    const entries = history.length;
    await act(async () => row.click());
    await until(() => location.pathname === "/features/quotes", "the feature's url");
    // The click pushed an entry for Back to leave...
    expect(history.length).toBe(entries + 1);
    // ...and Back is the browser's half, played here: happy-dom's
    // history.back() reloads the page instead of firing popstate.
    await act(async () => {
      history.replaceState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await until(() => readmeOpen(), "home");
    expect(location.pathname).toBe("/");
  });

  test("`g s` on a notebook entry turns the sidebar to the tree and opens the README", async () => {
    await setUp(BOTH);
    await open("/notebook/2026-11-20-chose-the-queue");
    await until(() => document.title === "SpecDriven — Chose the queue", "the notebook entry");
    expect(specsPanel()).toBe(false);
    await press("g");
    await press("s");
    await until(() => readmeOpen(), "home");
    expect(specsPanel()).toBe(true);
    expect(location.pathname).toBe("/");
  });

  test("the rail's Specs icon on a notebook entry does the same as `g s`", async () => {
    await setUp(BOTH);
    localStorage.setItem("sd-sidebar-collapsed", "1");
    await open("/notebook/2026-11-20-chose-the-queue");
    await until(() => document.title === "SpecDriven — Chose the queue", "the notebook entry");
    const specs = host!.querySelector<HTMLElement>('a.rail-link[aria-label="Specs"]')!;
    expect(specs.getAttribute("href")).toBe("/");
    await act(async () => specs.click());
    await until(() => readmeOpen(), "home");
    expect(location.pathname).toBe("/");
  });

  test("the palette finds a feature while Specs is on, and none while it is off", async () => {
    await setUp(BOTH);
    await open("/");
    await until(() => sidebarText().includes("Quotes"), "the tree");
    await press("/");
    await until(() => paletteInput() !== null, "the palette");
    await typeInto(paletteInput()!, "quotes");
    await until(() => paletteLabels().includes("Quotes"), "the feature in the palette");
    await unmount();

    expect((await putState({ plugins: { enabled: ["notebook"] } })).status).toBe(200);
    await open("/");
    await until(() => sidebarText().includes("Chose the queue"), "the notebook's list");
    await press("/");
    await until(() => paletteInput() !== null, "the palette");
    await typeInto(paletteInput()!, "quotes");
    await until(() => (host!.querySelector(".palette-list")?.textContent ?? "").includes("No matches"), "no match");
    expect(paletteLabels()).not.toContain("Quotes");
  });

  test("`c` makes a feature from home and a scenario on a feature page", async () => {
    await setUp(BOTH);
    await open("/");
    await until(() => sidebarText().includes("Quotes"), "the tree");
    await press("c");
    await until(() => dialogTitle() !== null, "the new feature dialog");
    expect(dialogTitle()).toBe("New feature");
    await unmount();

    await open("/features/quotes");
    await until(() => document.title === "SpecDriven — Quotes", "the feature");
    await press("c");
    await until(() => dialogTitle() !== null, "the new scenario dialog");
    expect(dialogTitle()).toBe("New scenario");
  });

  test("switching Specs off with a feature open goes home", async () => {
    await setUp(BOTH);
    await open("/features/quotes");
    await until(() => document.title === "SpecDriven — Quotes", "the feature");
    await act(async () => {
      await putState({ plugins: { enabled: ["notebook"] } });
      const state = await (await api("/api/state")).json();
      await syncClientPlugins(state.plugins);
    });
    await until(() => readmeOpen(), "home");
    expect(featureOpen()).toBe(false);
    expect(location.pathname).toBe("/");
  });

  test("a link to a feature that is not there says so and opens home", async () => {
    await setUp(BOTH);
    await open("/features/gone");
    await until(() => toasts().some((t) => t.includes("gone")), "the missed link's note");
    expect(readmeOpen()).toBe(true);
    expect(featureOpen()).toBe(false);
  });
});

// specs/app/public-specs-site.feature.md "A change pushed to the spec repo
// shows up on the site": the server's snapshot follows the repo, and an open
// page re-reads on the same cadence. A scenario's page is the editor pane,
// which the page's refresh tick left alone (so it cannot clobber an edit) —
// on the read-only site a visitor looking at a scenario kept the version the
// page loaded with until they reloaded.
//
// This mounts the real App in happy-dom, routes its fetches to the real API
// over a temporary data folder, and reports the site as read-only with a
// one-second cadence, the way /api/state does on specs.specdriven.app.
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
import { syncDataDir } from "../src/server/reload";
import { writeState } from "../src/server/state";

const feature = (body: string) =>
  `# Quotes\n\n## S1: Renewal @v1 [proposed]\n\n${body}\n\n## S2: Cancel @v1 [proposed]\n\nGiven a quote to cancel\n`;

let root: string;
let home: string;
let data: string;
let reactRoot: Root | undefined;
let host: HTMLElement | undefined;
/** Every request the page sent that was not a read. */
let writes: string[] = [];
/** What the site's /api/state adds in a test: the projects it shows. */
let stateExtra: Record<string, unknown> = {};
const realFetch = globalThis.fetch;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-readonly-page-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-readonly-page-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  writes = [];
  stateExtra = {};
  await Bun.write(join(data, "specs/quotes.feature.md"), feature("Given a quote for {amount}"));
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);
  await syncDataDir(data);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost/");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") writes.push(`${method} ${url.pathname}`);
    const res = await handleApi(new Request(url, init));
    if (!res) return new Response("Not found", { status: 404 });
    // The site's state: read-only, re-read every second.
    if (url.pathname === "/api/state" && res.ok) {
      const state = await res.json();
      return Response.json({ ...state, readOnly: true, reloadFrequencySeconds: 1, ...stateExtra });
    }
    return res;
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

/** Waits for the app's fetches, renders and timers to settle on `done`. */
async function until(done: () => boolean, what: string, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (done()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`gave up waiting for ${what}; the page shows: ${host?.textContent?.slice(0, 400)}`);
}

/** The scenario as a push brings it: the file changed and absorbed, as a new snapshot is. */
async function push(body: string) {
  await Bun.write(join(data, "specs/quotes.feature.md"), feature(body));
  await syncDataDir(data);
}

describe("an open scenario page on the public specs site", () => {
  test("shows a pushed change to its scenario after the next refresh", async () => {
    await openLink("/features/quotes/scenarios/renewal/v1");
    await until(() => Boolean(host?.textContent?.includes("Given a quote for {amount}")), "the scenario page");

    await push("Given a renewal quote for {amount}");
    await until(
      () => Boolean(host?.textContent?.includes("Given a renewal quote for {amount}")),
      "the pushed change",
    );

    expect(host!.textContent).not.toContain("Given a quote for {amount}");
    expect(location.pathname).toBe("/features/quotes/scenarios/renewal/v1");
    expect(writes).toEqual([]);
  }, 15_000);

  test("is left as it is while nothing changed", async () => {
    await openLink("/features/quotes/scenarios/renewal/v1");
    await until(() => Boolean(host?.textContent?.includes("Given a quote for {amount}")), "the scenario page");
    const pane = host!.querySelector('.read-only-scenario');
    expect(pane).not.toBeNull();

    // Two ticks go by with the feature as it was.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2500));
    });

    expect(host!.querySelector('.read-only-scenario')).toBe(pane);
    expect(writes).toEqual([]);
  }, 15_000);
});

describe("a public specs site showing several projects", () => {
  test("lists them under the folder name's ▾, the visitor's ticked, and links name the project", async () => {
    stateExtra = {
      readOnlyProject: "quotes",
      readOnlyProjects: [
        { id: "quotes", repo: "https://github.com/acme/quotes" },
        { id: "claims", repo: "https://github.com/acme/claims" },
      ],
    };
    await openLink("/");
    await until(() => host!.querySelector('button[aria-label="Projects"]') !== null, "the projects toggle");
    await act(async () => (host!.querySelector('button[aria-label="Projects"]') as HTMLElement).click());
    const items = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')];
    expect(items.map((i) => i.textContent?.trim())).toEqual(["quotes", "claims"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(items.map((i) => i.getAttribute("title"))).toEqual([
      "https://github.com/acme/quotes",
      "https://github.com/acme/claims",
    ]);
    const { shareUrl } = await import("../src/frontend/shareLink");
    expect(shareUrl("/features/quotes")).toBe("http://localhost/features/quotes?project=quotes");
    expect(writes).toEqual([]);
  }, 15_000);

  test("the address bar names the visitor's project, on every page the app opens", async () => {
    stateExtra = {
      readOnlyProject: "quotes",
      readOnlyProjects: [
        { id: "quotes", repo: "https://github.com/acme/quotes" },
        { id: "claims", repo: "https://github.com/acme/claims" },
      ],
    };
    await openLink("/features/quotes/scenarios/renewal/v1");
    await until(() => Boolean(host?.textContent?.includes("Given a quote for {amount}")), "the scenario page");
    expect(location.pathname + location.search).toBe("/features/quotes/scenarios/renewal/v1?project=quotes");
    // The folder name goes home.
    await act(async () => (host!.querySelector(".repo-name") as HTMLElement).click());
    await until(() => location.pathname === "/", "the home page");
    expect(location.search).toBe("?project=quotes");
    expect(writes).toEqual([]);
  }, 15_000);

  test("with one project there is no ▾ and links name none", async () => {
    stateExtra = { readOnlyProject: "quotes", readOnlyProjects: [{ id: "quotes", repo: "https://github.com/acme/quotes" }] };
    await openLink("/");
    await until(() => Boolean(host?.querySelector(".repo-name")), "the folder name");
    expect(host!.querySelector('button[aria-label="Projects"]')).toBeNull();
    const { shareUrl } = await import("../src/frontend/shareLink");
    expect(shareUrl("/features/quotes")).toBe("http://localhost/features/quotes");
    expect(location.search).toBe("");
  }, 15_000);
});

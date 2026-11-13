// The Plugins page's way back from a bad update (src/frontend/PluginsPage
// .tsx; specs/app/plugins.feature.md "A plugin that fails after an update
// offers its previous version"): under the error of a plugin whose install
// record remembers the version it replaced, "Roll back to v…" asks the
// server for that version; a plugin that is fine, one with no previous
// version, and the hosted demo offer nothing. A held plugin says so beside
// its version.
//
// As tests/pluginMarketplacePage.test.tsx does, only the handful of globals
// React needs are taken from happy-dom and given back after.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
  happyWindow = new Window({ url: "http://localhost/plugins" });
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
import { PluginsPage } from "../src/frontend/PluginsPage";
import type { PluginStatus } from "../src/plugins/client/loader";

function click(el: Element) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key]!.onClick!({
    target: el,
    currentTarget: el,
    preventDefault() {},
  });
}

const realFetch = globalThis.fetch;
let requests: { url: string; body?: unknown }[] = [];
let refuse: string | null = null;
let changed = 0;
afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

const plugin = (id: string, extra: Partial<PluginStatus> = {}): PluginStatus => ({
  id,
  enabled: true,
  displayName: id,
  version: "1.19.0",
  source: "home",
  installed: true,
  install: { marketplace: "specdriven", name: id, version: "1.19.0" },
  ...extra,
});

async function mount(plugins: PluginStatus[], opts: { demo?: boolean; loadErrors?: Map<string, string> } = {}) {
  requests = [];
  refuse = null;
  changed = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    return new Response(JSON.stringify(refuse ? { error: refuse } : {}), {
      status: refuse ? 400 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () =>
    createRoot(container).render(
      <PluginsPage
        plugins={plugins}
        loadErrors={opts.loadErrors ?? new Map()}
        hasIssuesRepo={false}
        demo={opts.demo === true}
        sources={[]}
        marketplaces={[]}
        error={null}
        setEnabled={async () => {}}
        move={async () => {}}
        patchSettings={async () => true}
        prompt={async () => null}
        confirm={async () => false}
        onChanged={async () => void changed++}
        onOpenSettings={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  return container;
}
const rowOf = (container: Element, id: string) => container.querySelector(`.plugin-row[data-plugin="${id}"]`)!;
const rollback = (row: Element) => row.querySelector("button.plugin-row-rollback");

test("a plugin that fails after a version change offers the version it replaced, and nothing else does", async () => {
  const container = await mount(
    [
      plugin("broken", { error: "host.js threw", install: { marketplace: "specdriven", name: "broken", version: "1.19.0", previous: "1.18.0" } }),
      // Fine: nothing to roll back from.
      plugin("fine", { install: { marketplace: "specdriven", name: "fine", version: "1.19.0", previous: "1.18.0" } }),
      // Failing, but it never was on another version.
      plugin("first", { error: "host.js threw" }),
      // Its browser half failed to load.
      plugin("halfway", { install: { marketplace: "specdriven", name: "halfway", version: "2.0.0", previous: "1.4.0" } }),
    ],
    { loadErrors: new Map([["halfway", "client.js did not load"]]) },
  );
  expect(rollback(rowOf(container, "broken"))!.textContent).toBe("Roll back to v1.18.0");
  expect(rollback(rowOf(container, "fine"))).toBeNull();
  expect(rollback(rowOf(container, "first"))).toBeNull();
  expect(rollback(rowOf(container, "halfway"))!.textContent).toBe("Roll back to v1.4.0");

  await act(async () => click(rollback(rowOf(container, "broken"))!));
  await flush();
  expect(requests).toEqual([{ url: "/api/plugins/broken/update", body: { version: "1.18.0" } }]);
  // The plugins are read again once it is back.
  expect(changed).toBe(1);
});

test("a roll back the server refuses says why under the plugin", async () => {
  const container = await mount([
    plugin("broken", { error: "host.js threw", install: { marketplace: "specdriven", name: "broken", version: "1.19.0", previous: "1.18.0" } }),
  ]);
  refuse = "broken has no released version 1.18.0";
  await act(async () => click(rollback(rowOf(container, "broken"))!));
  await flush();
  expect(rowOf(container, "broken").textContent).toContain("broken has no released version 1.18.0");
  expect(changed).toBe(0);
  expect(rollback(rowOf(container, "broken"))!.textContent).toBe("Roll back to v1.18.0");
});

test("a held plugin says so beside its version, and the hosted demo offers no roll back", async () => {
  const held = await mount([plugin("held", { version: "1.18.0", install: { marketplace: "specdriven", name: "held", version: "1.18.0", held: true } })]);
  expect(rowOf(held, "held").querySelector(".plugin-row-meta")!.textContent).toBe("Marketplace specdriven · v1.18.0 · held");
  const demo = await mount(
    [plugin("broken", { error: "host.js threw", install: { marketplace: "specdriven", name: "broken", version: "1.19.0", previous: "1.18.0" } })],
    { demo: true },
  );
  expect(rollback(rowOf(demo, "broken"))).toBeNull();
});

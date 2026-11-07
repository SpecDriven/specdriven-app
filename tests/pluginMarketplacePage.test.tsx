// Plugins → Marketplaces (src/frontend/PluginMarketplace.tsx; specs/app/
// plugins.feature.md "The marketplace is a git repository with an index"):
// Refresh sits in the toolbar whether or not the list has been browsed, and
// there is no separate Re-clone — the server clones a marketplace afresh when
// a Refresh cannot pull it. Driven in a borrowed DOM against a fake
// /api/plugins/marketplaces.
//
// As tests/projectSettingsPage.test.tsx does, only the handful of globals
// React needs are taken from happy-dom and given back after.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
import { PluginMarketplace } from "../src/frontend/PluginMarketplace";

function click(el: Element) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key]!.onClick!({
    target: el,
    currentTarget: el,
    preventDefault() {},
  });
}

const buttonLabels = (root: Element) => [...root.querySelectorAll("button")].map((b) => b.textContent);
const buttonNamed = (root: Element, label: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === label)!;

describe("the marketplace toolbar", () => {
  const realFetch = globalThis.fetch;
  let requests: string[] = [];
  afterEach(() => {
    globalThis.fetch = realFetch;
    document.body.innerHTML = "";
  });
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

  async function mount() {
    requests = [];
    globalThis.fetch = (async (url: string) => {
      requests.push(url);
      return new Response(
        JSON.stringify({
          marketplaces: [
            { name: "local", source: "https://example.test/plugins", index: { name: "Local", plugins: [] } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <PluginMarketplace
          marketplaces={[{ name: "local", source: "https://example.test/plugins" }]}
          plugins={[]}
          patchSettings={async () => true}
          prompt={async () => null}
          confirm={async () => false}
          onChanged={async () => {}}
        />,
      ),
    );
    return container;
  }

  test("offers Refresh before the list is browsed, and no Re-clone", async () => {
    const container = await mount();
    expect(buttonLabels(container)).toContain("Browse plugins");
    expect(buttonLabels(container)).toContain("Refresh");
    expect(buttonLabels(container).some((l) => /re-?clone/i.test(l ?? ""))).toBe(false);
    expect(requests).toEqual([]);
  });

  test("Refresh before browsing opens the list with a single pulling read", async () => {
    const container = await mount();
    await act(async () => click(buttonNamed(container, "Refresh")));
    await flush();
    expect(requests).toEqual(["/api/plugins/marketplaces?refresh=1"]);
    expect(buttonLabels(container)).not.toContain("Browse plugins");
    expect(buttonLabels(container)).toContain("Refresh");
    expect(container.textContent).toContain("This marketplace lists no plugins yet.");
  });

  test("Browse reads the cache, and Refresh afterwards pulls", async () => {
    const container = await mount();
    await act(async () => click(buttonNamed(container, "Browse plugins")));
    await flush();
    expect(requests).toEqual(["/api/plugins/marketplaces"]);
    await act(async () => click(buttonNamed(container, "Refresh")));
    await flush();
    expect(requests).toEqual(["/api/plugins/marketplaces", "/api/plugins/marketplaces?refresh=1"]);
  });
});

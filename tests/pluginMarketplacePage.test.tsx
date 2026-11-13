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
import { PluginMarketplace, newestOffered, switchPluginVersion, versionItems } from "../src/frontend/PluginMarketplace";
import type { PluginStatus } from "../src/plugins/client/loader";

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

// A plugin released in versions (specs/app/plugins.feature.md "Any released
// version of a plugin can be installed", "A plugin rolled back to an older
// version stays there until the user updates it"): a version chip whose
// menu lists what the marketplace holds — the version this app cannot run
// greyed with the reason, a withdrawn one left out — picks what Install
// fetches, switches an installed plugin at once, and Update names where it
// would go.
describe("a released plugin's row", () => {
  const realFetch = globalThis.fetch;
  let requests: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  afterEach(() => {
    globalThis.fetch = realFetch;
    document.body.innerHTML = "";
  });
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  const sha = "a".repeat(64);
  const releases = [
    { version: "2.0.0", file: "hello-2.0.0.zip", sha256: sha, refusal: "version 2.0.0 needs SpecDriven 9.0.0 or newer; this is 0.1.270" },
    { version: "1.3.0", file: "hello-1.3.0.zip", sha256: sha, yanked: "loses settings", refusal: "version 1.3.0 was withdrawn: loses settings" },
    { version: "1.2.0", file: "hello-1.2.0.zip", sha256: sha, date: "2026-11-12", notes: "Faster start" },
    { version: "1.1.0", file: "hello-1.1.0.zip", sha256: sha, date: "2026-11-01" },
    { version: "1.0.0", file: "hello-1.0.0.zip", sha256: sha },
  ];
  const index = {
    name: "Local",
    plugins: [
      { name: "hello", source: "./plugins/hello", description: "Says hello", version: "2.0.0", category: "tabs", releases },
      { name: "plain", source: "./plugins/plain", description: "No releases", version: "0.4.0" },
    ],
  };

  async function mount(plugins: PluginStatus[] = []) {
    requests = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      requests.push({ method: init?.method ?? "GET", url, ...(body ? { body } : {}) });
      const answer = url.endsWith("/install")
        ? { preview: { id: "hello", displayName: "Hello", description: "Says hello", version: body?.version ?? "1.2.0", permissions: [] } }
        : url.includes("/marketplaces")
          ? { marketplaces: [{ name: "local", source: "https://example.test/plugins", index }] }
          : {};
      return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <PluginMarketplace
          marketplaces={[{ name: "local", source: "https://example.test/plugins" }]}
          plugins={plugins}
          patchSettings={async () => true}
          prompt={async () => null}
          confirm={async () => true}
          onChanged={async () => {}}
        />,
      ),
    );
    await act(async () => click(buttonNamed(container, "Browse plugins")));
    await flush();
    requests = [];
    return container;
  }
  const rowOf = (container: Element, name: string) => container.querySelector(`.plugin-market-row[data-plugin="${name}"]`)!;
  const chip = (row: Element) => row.querySelector("button.plugin-version-chip")!;
  const menuItems = (row: Element) => [...row.querySelectorAll("[role=menuitemradio]")] as HTMLButtonElement[];
  const installed = (version: string, install: Partial<NonNullable<PluginStatus["install"]>> = {}): PluginStatus => ({
    id: "hello",
    enabled: true,
    displayName: "Hello",
    version,
    install: { marketplace: "local", name: "hello", version, ...install },
  });

  test("the chip names the newest version this app can run, and its menu the others with why one cannot be picked", async () => {
    const container = await mount();
    const row = rowOf(container, "hello");
    // 2.0.0 is the row's version, but not one this app runs.
    expect(chip(row).textContent).toBe("v1.2.0");
    expect(row.querySelector(".plugin-row-meta")!.textContent).toBe("tabs");
    expect(menuItems(row)).toEqual([]);
    await act(async () => click(chip(row)));
    const items = menuItems(row);
    // Newest first; the withdrawn 1.3.0 is not offered.
    expect(items.map((i) => i.querySelector(".menu-label")!.textContent)).toEqual(["v2.0.0", "v1.2.0", "v1.1.0", "v1.0.0"]);
    expect(items[0]!.disabled).toBe(true);
    expect(items[0]!.querySelector(".menu-desc")!.textContent).toBe("needs SpecDriven 9.0.0 or newer; this is 0.1.270");
    expect(items[1]!.getAttribute("aria-checked")).toBe("true");
    expect(items[1]!.querySelector(".menu-desc")!.textContent).toBe("2026-11-12 · Faster start");
    expect(items[2]!.querySelector(".menu-desc")!.textContent).toBe("2026-11-01");
    expect(items[3]!.querySelector(".menu-desc")).toBeNull();
    // A plugin with no releases has no chip and installs as before.
    const plain = rowOf(container, "plain");
    expect(plain.querySelector(".plugin-version-chip")).toBeNull();
    expect(plain.querySelector(".plugin-row-meta")!.textContent).toBe("v0.4.0");
  });

  test("the version picked is the one Install stages and confirms", async () => {
    const container = await mount();
    const row = rowOf(container, "hello");
    await act(async () => click(chip(row)));
    await act(async () => click(menuItems(row)[3]!));
    expect(chip(row).textContent).toBe("v1.0.0");
    expect(menuItems(row)).toEqual([]);
    expect(requests).toEqual([]);
    await act(async () => click(buttonNamed(row, "Install")));
    await flush();
    expect(requests).toEqual([
      { method: "POST", url: "/api/plugins/install", body: { marketplace: "local", name: "hello", step: "stage", version: "1.0.0" } },
      { method: "POST", url: "/api/plugins/install", body: { marketplace: "local", name: "hello", step: "confirm", version: "1.0.0" } },
    ]);
    // Untouched, Install asks for the newest this app runs by name.
    const fresh = await mount();
    await act(async () => click(buttonNamed(rowOf(fresh, "hello"), "Install")));
    await flush();
    expect(requests.map((r) => r.body?.version)).toEqual(["1.2.0", "1.2.0"]);
    // A plugin with no releases is asked for with no version.
    requests = [];
    await act(async () => click(buttonNamed(rowOf(fresh, "plain"), "Install")));
    await flush();
    expect(requests[0]!.body).toEqual({ marketplace: "local", name: "plain", step: "stage" });
  });

  test("an installed plugin switches to the version picked at once; held, it says so and Update names where it goes", async () => {
    const container = await mount([installed("1.0.0", { held: true })]);
    const row = rowOf(container, "hello");
    expect(chip(row).textContent).toBe("v1.0.0");
    expect(row.querySelector(".plugin-row-meta")!.textContent).toBe("tabs · Installed · held");
    expect(buttonLabels(row)).toContain("Update to v1.2.0");

    await act(async () => click(chip(row)));
    expect(menuItems(row).find((i) => i.getAttribute("aria-checked") === "true")!.textContent).toContain("v1.0.0");
    // Picking the version that is installed changes nothing.
    await act(async () => click(menuItems(row)[3]!));
    await flush();
    expect(requests).toEqual([]);
    await act(async () => click(chip(row)));
    await act(async () => click(menuItems(row)[2]!));
    await flush();
    expect(requests).toEqual([{ method: "POST", url: "/api/plugins/hello/update", body: { version: "1.1.0" } }]);

    // Update asks for no version: the newest this app runs.
    requests = [];
    await act(async () => click(buttonNamed(row, "Update to v1.2.0")));
    await flush();
    expect(requests).toEqual([{ method: "POST", url: "/api/plugins/hello/update", body: {} }]);
    // Reinstall unpacks the version that is installed, not the newest.
    requests = [];
    await act(async () => click(buttonNamed(row, "Reinstall")));
    await flush();
    expect(requests[0]!.body).toMatchObject({ step: "stage", version: "1.0.0" });
  });

  test("on the newest version this app runs there is no Update; on a withdrawn one, Move names the way off", async () => {
    const newest = rowOf(await mount([installed("1.2.0")]), "hello");
    expect(newest.querySelector(".plugin-row-meta")!.textContent).toBe("tabs · Installed");
    expect(buttonLabels(newest).some((l) => /^(Update|Move)/.test(l ?? ""))).toBe(false);
    expect(buttonLabels(newest)).toContain("Reinstall");

    const withdrawn = rowOf(await mount([installed("1.3.0")]), "hello");
    expect(withdrawn.querySelector(".plugin-row-meta")!.textContent).toBe("tabs · Installed · withdrawn");
    expect(buttonLabels(withdrawn)).toContain("Move to v1.2.0");
    // The withdrawn version shows in the menu while it is the one installed.
    await act(async () => click(chip(withdrawn)));
    expect(menuItems(withdrawn).map((i) => i.querySelector(".menu-label")!.textContent)).toContain("v1.3.0");
  });

  test("the menu's rows say what each version is; the newest offered passes over what this app cannot run", () => {
    const picks: string[] = [];
    const items = versionItems(releases, "1.3.0", (v) => picks.push(v));
    // The withdrawn 1.3.0 is listed because it is the one installed, and stays pickable.
    expect(items.map((i) => [i.id, i.checked, i.disabled])).toEqual([
      ["2.0.0", false, true],
      ["1.3.0", true, false],
      ["1.2.0", false, false],
      ["1.1.0", false, false],
      ["1.0.0", false, false],
    ]);
    expect(items[0]!.description).toBe("needs SpecDriven 9.0.0 or newer; this is 0.1.270");
    expect(items[1]!.description).toBe("was withdrawn: loses settings");
    expect(items[4]!.description).toBeUndefined();
    items[2]!.onSelect!();
    expect(picks).toEqual(["1.2.0"]);
    // With none installed, no row is ticked and the withdrawn one is gone.
    expect(versionItems(releases, undefined, () => {}).map((i) => i.id)).toEqual(["2.0.0", "1.2.0", "1.1.0", "1.0.0"]);

    expect(newestOffered(releases)?.version).toBe("1.2.0");
    // A pre-release is never what Install means, and with nothing runnable there is none.
    expect(newestOffered([{ version: "1.4.0-beta", file: "b.zip", sha256: sha }, ...releases.slice(3)])?.version).toBe("1.1.0");
    expect(newestOffered(releases.slice(0, 2))).toBeUndefined();
  });

  test("a switch asks the server for the version by the plugin's id, a scope encoded", async () => {
    await mount();
    await switchPluginVersion("@acme/jira-tab", "0.3.1");
    expect(requests).toEqual([
      { method: "POST", url: "/api/plugins/%40acme%2Fjira-tab/update", body: { version: "0.3.1" } },
    ]);
  });
});

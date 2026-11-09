// The start's plugin update dialog (src/frontend/PluginUpdatesDialog.tsx;
// specs/app/plugins.feature.md "Plugins with an update are offered in a
// dialog at start"): each plugin ticked with its version step; Update runs
// the ticked ones one after another and keeps going past a failure, shown
// beside its row; Not now updates nothing. Driven in a borrowed DOM.
//
// As tests/pluginMarketplacePage.test.tsx does, only the handful of globals
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
import { PluginUpdatesDialog, fetchPluginUpdates } from "../src/frontend/PluginUpdatesDialog";
import type { PluginUpdate } from "../src/plugins/marketplace";

function props(el: Element): Record<string, (e: unknown) => void> {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key]!;
}
const click = (el: Element) => props(el).onClick!({ target: el, currentTarget: el, preventDefault() {} });
const buttonNamed = (root: Element, label: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === label)!;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

const updates: PluginUpdate[] = [
  { id: "agent-claude", displayName: "Claude", marketplace: "plugins", from: "1.16.0", to: "1.17.0" },
  { id: "agent-codex", displayName: "Codex", marketplace: "plugins", from: "1.2.0", to: "1.3.0" },
  { id: "agent-pi", displayName: "Pi", marketplace: "plugins", to: "1.1.0" },
];

describe("the plugin update dialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function mount(update: (id: string) => Promise<void>) {
    let closed = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(<PluginUpdatesDialog updates={updates} update={update} onClose={() => void closed++} />),
    );
    return { container, closed: () => closed };
  }

  test("lists each plugin ticked, with the version installed and the one offered", async () => {
    const { container } = await mount(async () => {});
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((r) => r.getAttribute("data-plugin"))).toEqual(["agent-claude", "agent-codex", "agent-pi"]);
    expect(rows[0]!.textContent).toContain("Claude");
    expect(rows[0]!.textContent).toContain("1.16.0 → 1.17.0");
    expect(rows[2]!.textContent).toContain("→ 1.1.0");
    expect([...container.querySelectorAll("input[type=checkbox]")].every((c) => (c as HTMLInputElement).checked)).toBe(true);
    expect(container.textContent).toContain("3 installed plugins have a newer version");
  });

  test("Update runs the ticked plugins in order and closes once all are updated", async () => {
    const ran: string[] = [];
    const { container, closed } = await mount(async (id) => void ran.push(id));
    // Untick Codex.
    const codex = container.querySelector('li[data-plugin="agent-codex"] input')!;
    await act(async () => props(codex).onChange!({ target: codex }));
    await act(async () => click(buttonNamed(container, "Update")));
    await flush();
    expect(ran).toEqual(["agent-claude", "agent-pi"]);
    expect(closed()).toBe(1);
  });

  test("a failure is shown beside its row, the others still update, and Close answers", async () => {
    const ran: string[] = [];
    const { container, closed } = await mount(async (id) => {
      ran.push(id);
      if (id === "agent-codex") throw new Error("the marketplace no longer lists agent-codex");
    });
    await act(async () => click(buttonNamed(container, "Update")));
    await flush();
    expect(ran).toEqual(["agent-claude", "agent-codex", "agent-pi"]);
    expect(closed()).toBe(0);
    const codex = container.querySelector('li[data-plugin="agent-codex"]')!;
    expect(codex.textContent).toContain("Failed");
    expect(codex.textContent).toContain("the marketplace no longer lists agent-codex");
    expect(container.querySelector('li[data-plugin="agent-pi"]')!.textContent).toContain("Updated");
    await act(async () => click(buttonNamed(container, "Close")));
    expect(closed()).toBe(1);
  });

  test("Not now updates nothing", async () => {
    const ran: string[] = [];
    const { container, closed } = await mount(async (id) => void ran.push(id));
    await act(async () => click(buttonNamed(container, "Not now")));
    expect(ran).toEqual([]);
    expect(closed()).toBe(1);
  });

  test("the offer is empty when the server refuses or answers none", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
      expect(await fetchPluginUpdates()).toEqual([]);
      globalThis.fetch = (async () => Response.json({ updates })) as unknown as typeof fetch;
      expect(await fetchPluginUpdates()).toEqual(updates);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

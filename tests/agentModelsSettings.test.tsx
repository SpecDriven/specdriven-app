// An agent's model list, in its Settings section (specs/agents/agent-plugins.feature.md "Each agent
// offers the models the data repo lists"): a list per installed agent, a
// model per line, saved on blur to /api/agent-models/<agent>; and the model
// dropdown every agent model field uses. React needs a DOM to handle the
// edits, so this file borrows one the way tests/qtestFailureDetails.test.tsx
// does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  "FocusEvent",
  "KeyboardEvent",
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
  globalThis.fetch = realFetch;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentModelList,
  agentsWithoutSection,
  ModelSelect,
  chosenModel,
  agentModelsOf,
  parseModelList,
  type AgentModels,
} from "../src/frontend/AgentModels";
import type { AgentDescriptor } from "../src/server/agentTypes";

function agent(id: string): AgentDescriptor {
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    description: "",
    available: true,
    missingMessage: `${id} not found`,
    plugin: `agent-${id}`,
    capabilities: {
      permissionModes: ["default"],
      canInterrupt: true,
      canChangeModeMidSession: true,
      hasAccount: false,
      rememberPermissions: "session",
      oneShot: true,
    },
    defaultPermissionMode: "default",
    rank: 10,
  };
}

function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, unmount };
}

// React's onChange under happy-dom: focus, the prototype setter, then keyup.
const type = (el: HTMLTextAreaElement, value: string) =>
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", bubbles: true }) as unknown as Event);
  });

describe("an agent's model list, in its Settings section", () => {
  test("a list per agent, a model per line, saved on blur to that agent's key", async () => {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { models: string[] };
      calls.push({ url, body });
      return Response.json({ agentModels: { claude: body.models, codex: ["gpt-5-codex"] } });
    }) as unknown as typeof fetch;
    const savedLists: AgentModels[] = [];
    const { host, unmount } = mount(
      <>
        <AgentModelList agent={agent("claude")} models={[]} onSaved={(next) => savedLists.push(next)} />
        <AgentModelList agent={agent("codex")} models={["gpt-5-codex"]} onSaved={(next) => savedLists.push(next)} />
      </>,
    );
    const list = (label: string) => host.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement;
    expect(list("Claude models").value).toBe("");
    expect(list("Codex models").value).toBe("gpt-5-codex");
    expect(host.textContent).toContain("One per line, as Claude names them");
    expect(host.textContent).toContain("Kept in the data repo's .specdriven/claude-models.json, shared with the team");

    type(list("Claude models"), "opus\n  sonnet \n\nopus\n");
    await act(async () => list("Claude models").blur());
    expect(calls).toEqual([{ url: "/api/agent-models/claude", body: { models: ["opus", "sonnet"] } }]);
    expect(savedLists).toEqual([{ claude: ["opus", "sonnet"], codex: ["gpt-5-codex"] }]);
    expect(list("Claude models").value).toBe("opus\nsonnet");

    // Leaving an unchanged list saves nothing.
    await act(async () => {
      list("Codex models").focus();
      list("Codex models").blur();
    });
    expect(calls).toHaveLength(1);
    unmount();
  });

  test("a refused list says why and is kept to fix", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: "Not a model name: claude sonnet" }, { status: 400 })) as unknown as typeof fetch;
    const savedLists: AgentModels[] = [];
    const { host, unmount } = mount(
      <AgentModelList agent={agent("claude")} models={[]} onSaved={(next) => savedLists.push(next)} />,
    );
    const list = host.querySelector('textarea[aria-label="Claude models"]') as HTMLTextAreaElement;
    type(list, "claude sonnet");
    await act(async () => list.blur());
    expect(host.textContent).toContain("Not a model name: claude sonnet");
    expect(list.value).toBe("claude sonnet");
    expect(savedLists).toEqual([]);
    unmount();
  });
});

test("an agent whose plugin adds no Settings section gets one of its own for its list", () => {
  // Claude's plugin has Settings → Claude; Codex's has none.
  expect(agentsWithoutSection([agent("claude"), agent("codex")], ["claude", "qtest-extra"]).map((a) => a.id)).toEqual([
    "codex",
  ]);
  expect(agentsWithoutSection([agent("claude")], ["claude"])).toEqual([]);
});

describe("the model dropdown", () => {
  test("only the agent's list, its first chosen until another is; a value the list lost stays on offer", () => {
    const html = (value: string, models = ["opus", "sonnet"]) =>
      renderToStaticMarkup(<ModelSelect ariaLabel="Model" models={models} value={value} onChange={() => {}} />);
    expect(html("")).toBe(
      '<select aria-label="Model"><option value="opus" selected="">opus</option><option value="sonnet">sonnet</option></select>',
    );
    expect(html("sonnet")).toContain('<option value="sonnet" selected="">sonnet</option>');
    expect(html("haiku")).toContain('<option value="sonnet">sonnet</option><option value="haiku" selected="">haiku</option>');
    expect(html("", [])).toBe(
      '<select aria-label="Model" disabled=""><option value="" selected="">No models listed</option></select>',
    );
    expect(chosenModel(["opus", "sonnet"], "")).toBe("opus");
    expect(chosenModel(["opus"], "haiku")).toBe("haiku");
    expect(chosenModel([], "")).toBe("");
    // An agent's rows show their names; its own default is chosen while
    // nothing is, and one the menu lacks stays on offer.
    const rows = [{ value: "opus", displayName: "Opus" }, { value: "claude-sonnet-4-6", displayName: "claude-sonnet-4-6" }];
    expect(chosenModel(rows, "", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(chosenModel(rows, "", null)).toBe("opus");
    expect(chosenModel(rows, "haiku", "opus")).toBe("haiku");
    expect(renderToStaticMarkup(<ModelSelect ariaLabel="Model" models={rows} value="" fallback="claude-sonnet-4-6" onChange={() => {}} />)).toBe(
      '<select aria-label="Model"><option value="opus">Opus</option><option value="claude-sonnet-4-6" selected="">claude-sonnet-4-6</option></select>',
    );
    expect(renderToStaticMarkup(<ModelSelect ariaLabel="Model" models={rows} value="" fallback="haiku" onChange={() => {}} />)).toContain(
      '<option value="haiku" selected="">haiku</option>',
    );
  });

  test("the lists come from the state payload; anything else is none", () => {
    expect(agentModelsOf({ agentModels: { claude: ["opus", 3], codex: "x" } })).toEqual({ claude: ["opus"] });
    expect(agentModelsOf({})).toEqual({});
    expect(agentModelsOf({ agentModels: [] })).toEqual({});
    expect(parseModelList(" opus \n\nsonnet\nopus")).toEqual(["opus", "sonnet"]);
  });
});

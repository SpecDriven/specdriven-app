// The pane's model list goes stale (specs/agents/agent-pane.feature.md "The
// composer bar picks the folder, model, effort and mode"): the list is what
// the agent's sign-in offers, and that changes under an open window — an
// account given another model. The store loads it again once it is a minute
// old (src/frontend/agentChat.ts), and the model menu loads it as it opens
// (src/frontend/AgentPane.tsx), so the menu never lists what the sign-in
// stopped offering until the plugin is switched off and on again. React
// needs a DOM to open the menu, so this file borrows one the way
// tests/agentModelsSettings.test.tsx does.
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
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;
const realFetch = globalThis.fetch;
const realNow = Date.now;

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
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentPane } from "../src/frontend/AgentPane";
import { CHOICES_TTL_MS, agentChat, agentChatState } from "../src/frontend/agentChat";
import type { AgentModelOption } from "../src/frontend/agentChat";
import { CLAUDE_AGENT } from "./fixtures/agents";

const OPUS: AgentModelOption = { value: "opus", displayName: "Opus 5.5" };
const FABLE: AgentModelOption = { value: "fable", displayName: "Fable 5.1" };

/** A fetch that answers the choices route with `models()`, counting the asks. */
function answering(models: () => AgentModelOption[]): { asked: () => number } {
  let asked = 0;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/choices")) {
      asked++;
      return Response.json({ choices: { models: models(), model: models()[0]!.value, effort: null } });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return { asked: () => asked };
}

test("the pane's model list is loaded again once it has gone stale, and readers at once share the load", async () => {
  let models = [OPUS];
  const fetched = answering(() => models);
  const first = await agentChat.loadChoices("gemini");
  expect(first?.models).toEqual([OPUS]);
  expect(fetched.asked()).toBe(1);

  // The sign-in gains a model. Within the minute the loaded list serves.
  models = [OPUS, FABLE];
  expect((await agentChat.loadChoices("gemini"))?.models).toEqual([OPUS]);
  expect(fetched.asked()).toBe(1);

  // Past it, the next reader loads what the sign-in offers now — and two
  // readers at the same moment make one request between them.
  const later = realNow() + CHOICES_TTL_MS;
  const both = await Promise.all([
    agentChat.loadChoices("gemini", false, later),
    agentChat.loadChoices("gemini", false, later),
  ]);
  expect(fetched.asked()).toBe(2);
  expect(both[0]?.models).toEqual([OPUS, FABLE]);
  expect(both[1]).toEqual(both[0]);
  expect(agentChatState().choices.gemini?.models).toEqual([OPUS, FABLE]);

  // `force` loads a list that has only just arrived.
  expect((await agentChat.loadChoices("gemini", true))?.models).toEqual([OPUS, FABLE]);
  expect(fetched.asked()).toBe(3);
});

test("the pane's model list is loaded again when the model menu opens, and the menu lists what came back", async () => {
  let models = [OPUS];
  const fetched = answering(() => models);
  agentChat.setAgents([CLAUDE_AGENT]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" onClose={() => {}} />);
    });
    expect(fetched.asked()).toBe(1);
    const chip = host.querySelector<HTMLButtonElement>('[data-picker="model"] button')!;
    expect(chip.getAttribute("aria-label")).toBe("Model: Opus 5.5");

    // The account is given Fable while the window stays open. The list the
    // pane holds is still fresh, so opening the menu does not ask again.
    models = [OPUS, FABLE];
    await act(async () => chip.click());
    expect(fetched.asked()).toBe(1);
    expect(host.textContent).not.toContain("Fable 5.1");
    await act(async () => chip.click());

    // A minute on, opening it asks again and the menu lists the new model.
    Date.now = () => realNow() + CHOICES_TTL_MS + 1;
    await act(async () => chip.click());
    expect(fetched.asked()).toBe(2);
    expect(host.textContent).toContain("Fable 5.1");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    agentChat.setAgents([]);
  }
});

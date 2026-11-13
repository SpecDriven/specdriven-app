// The model chip's picker in the coding agent pane (specs/agents/
// agent-pane.feature.md "The composer bar picks the folder, model, effort and
// mode"): one chip — the agent's icon, the model, the effort — opens one
// picker holding the agents that can start (before a session), the models the
// agent offers, searchable once the list is long, and the effort levels the
// model takes. The rows' data is checked in tests/agentPane.test.tsx; here
// the picker is opened on a mounted pane, so React needs a DOM, borrowed the
// way tests/agentModelRefresh.test.tsx does.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "HTMLTextAreaElement",
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

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AgentPane } from "../src/frontend/AgentPane";
import { AgentIcon, hasAgentMark } from "../src/frontend/AgentIcons";
import { EFFORT_DESCRIPTION, MAX_KEYED_MODELS, ModelPicker } from "../src/frontend/AgentModelPicker";
import { agentChat, forgetFolderInfos } from "../src/frontend/agentChat";
import type { AgentChoices, AgentModelOption, ChatSessionMeta } from "../src/frontend/agentChat";
import type { AgentDescriptor } from "../src/server/agentTypes";
import { CLAUDE_AGENT, CODEX_AGENT, agent } from "./fixtures/agents";

/** Claude and Codex as their plugins describe them: both take an effort. */
const CLAUDE: AgentDescriptor = {
  ...CLAUDE_AGENT,
  capabilities: { ...CLAUDE_AGENT.capabilities, effort: true, canChangeModelMidSession: true },
};
const CODEX: AgentDescriptor = { ...CODEX_AGENT, capabilities: { ...CODEX_AGENT.capabilities, effort: true } };

const CLAUDE_MODELS: AgentModelOption[] = [
  { value: "opus", displayName: "Opus 5.5", description: "Most capable", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", displayName: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
  { value: "haiku", displayName: "Haiku 5.5", efforts: [] },
];
const CODEX_MODELS: AgentModelOption[] = [
  { value: "gpt-6-sol", displayName: "6-Sol", efforts: ["low", "medium", "high"] },
  { value: "gpt-6-luna", displayName: "6-Luna", efforts: ["low", "medium"] },
];

/** What each agent offers, as the server holds it; a pick here changes it. */
let offered: Record<string, AgentChoices | null>;
/** Every write the pane made: "PUT /api/… {body}". */
let wrote: string[];

/** A session of Claude's in the folder itself. */
const META: ChatSessionMeta = {
  id: "s1",
  name: "Fix login",
  agent: "claude",
  cwd: "/w/code",
  dataRepo: "/w/data",
  project: "/w/data",
  codeRepo: "/w/code",
  startedAt: "2026-11-12T10:00:00.000Z",
  status: "idle",
  permissionMode: "auto",
  model: "opus",
  effort: "high",
  lastSeq: 0,
};

beforeEach(() => {
  forgetFolderInfos();
  wrote = [];
  offered = {
    claude: { models: CLAUDE_MODELS, model: "opus", effort: "high" },
    codex: { models: CODEX_MODELS, model: "gpt-6-sol", effort: null },
  };
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (method !== "GET") wrote.push(`${method} ${url} ${String(init.body ?? "")}`);
    const about = /^\/api\/agent\/agents\/([^/]+)\/(choices|defaults)$/.exec(url);
    if (about) {
      const id = about[1]!;
      if (method === "PUT" && offered[id]) offered[id] = { ...offered[id]!, ...JSON.parse(String(init.body)) };
      return Response.json({ choices: offered[id] ?? null });
    }
    if (url.startsWith("/api/agent/folder?")) return Response.json({ canWorktree: false, reason: "Not a git repository" });
    if (url === "/api/agent/chat/s1" && method === "DELETE") return Response.json({ ok: true });
    if (url === "/api/agent/chat/s1") return Response.json({ meta: META, commands: [], events: [] });
    if (url.startsWith("/api/agent/chat/s1/events")) return new Response(new ReadableStream());
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  localStorage.clear();
  forgetFolderInfos();
  agentChat.setAgents([]);
  for (const id of ["claude", "codex", "gemini"]) agentChat.setChoices(id, undefined);
  document.body.innerHTML = "";
});

async function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await doing(() => root.render(el));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const pane = <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" onClose={() => {}} />;

const chipOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-picker="model"] > button')!;
const pickerOf = (host: HTMLElement) => host.querySelector<HTMLElement>(".agent-model-popover");
/** Do something to the pane and wait, inside one act, for what it asked the server to come back. */
const doing = (what: () => void) =>
  act(async () => {
    what();
    await Bun.sleep(5);
  });
const click = (el: Element) => doing(() => (el as HTMLElement).click());
const press = (el: Element, key: string) =>
  doing(() => void el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event));

/** The names in one of the picker's groups, and which is on. */
function group(host: HTMLElement, name: string): { names: string[]; on: string[] } {
  const all = [...host.querySelectorAll<HTMLElement>(`[role="radiogroup"][aria-label="${name}"] [role="radio"]`)];
  const say = (el: HTMLElement) => el.getAttribute("aria-label") ?? el.querySelector(".menu-label")?.firstChild?.textContent ?? el.textContent ?? "";
  return { names: all.map(say), on: all.filter((el) => el.getAttribute("aria-checked") === "true").map(say) };
}

const radio = (host: HTMLElement, groupName: string, name: string) =>
  [...host.querySelectorAll<HTMLElement>(`[role="radiogroup"][aria-label="${groupName}"] [role="radio"]`)].find(
    (el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").startsWith(name),
  )!;

/** Type into the search field the way React hears it under happy-dom. */
const type = (input: HTMLInputElement, value: string) =>
  doing(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", bubbles: true }) as unknown as Event);
  });

test("one chip names the agent by its icon, the model and the effort, and opens one picker for all three", async () => {
  agentChat.setAgents([CLAUDE, CODEX]);
  const { host, unmount } = await mount(pane);
  const chip = chipOf(host);
  expect(chip.getAttribute("aria-label")).toBe("Agent: Claude · Model: Opus 5.5 · Effort: High");
  expect(chip.querySelector("[data-agent-icon]")!.getAttribute("data-agent-icon")).toBe("claude");
  expect(chip.textContent).toBe("Opus 5.5· High");
  // No chips of their own for the agent or the effort.
  expect(host.querySelector('[data-picker="agent"]')).toBeNull();
  expect(host.querySelector('[data-picker="effort"]')).toBeNull();
  expect(pickerOf(host)).toBeNull();

  await click(chip);
  const picker = pickerOf(host)!;
  expect(picker.getAttribute("role")).toBe("dialog");
  expect(picker.getAttribute("aria-label")).toBe("Agent, model and effort");
  expect(group(host, "Agent")).toEqual({ names: ["Claude", "Codex"], on: ["Claude"] });
  expect(group(host, "Model")).toEqual({ names: ["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"], on: ["Opus 5.5"] });
  expect(group(host, "Effort")).toEqual({ names: ["Default", "Low", "Medium", "High", "Extra high", "Max"], on: ["High"] });
  // The model new sessions start on is badged, and a line says what a model is.
  const opus = radio(host, "Model", "Opus 5.5");
  expect(opus.querySelector(".menu-badge")!.textContent).toBe("Default");
  expect(opus.querySelector(".menu-desc")!.textContent).toBe("Most capable");
  // A short list picks by number and has no search field.
  expect([...picker.querySelectorAll('[aria-label="Model"] kbd')].map((k) => k.textContent)).toEqual(["1", "2", "3"]);
  expect(picker.querySelector(".agent-model-search")).toBeNull();
  // Focus starts on the model that is on, not on the first agent icon.
  expect(document.activeElement).toBe(opus);
  await unmount();
});

test("each agent is an icon named by its label, and its tooltip gives the name and what the agent is", async () => {
  const gemini = agent({ id: "gemini", label: "Gemini", description: "Google's CLI agent" });
  agentChat.setAgents([CLAUDE, CODEX, gemini]);
  const { host, unmount } = await mount(pane);
  await click(chipOf(host));
  const icons = [...host.querySelectorAll<HTMLElement>('[aria-label="Agent"] [role="radio"]')];
  expect(icons.map((el) => el.getAttribute("aria-label"))).toEqual(["Claude", "Codex", "Gemini"]);
  // An icon and nothing else: the label is what names it.
  expect(icons.map((el) => el.textContent)).toEqual(["", "", ""]);
  // Known agents carry their own mark; another plugin's agent the robot.
  expect(icons.map((el) => el.querySelector("[data-agent-icon]")!.getAttribute("data-agent-icon"))).toEqual([
    "claude",
    "codex",
    "generic",
  ]);
  expect(["claude", "codex", "opencode", "pi"].every(hasAgentMark)).toBe(true);
  expect(hasAgentMark("gemini")).toBe(false);
  expect(hasAgentMark("constructor")).toBe(false);

  // Keyboard focus shows the tooltip at once: the name over the description.
  await doing(() => icons[1]!.focus());
  const tip = document.querySelector('[role="tooltip"]')!;
  expect(tip.querySelector("strong")!.textContent).toBe("Codex");
  expect(tip.textContent).toContain(CODEX.description);
  expect(icons[1]!.getAttribute("aria-describedby")).toBe(tip.id);
  await unmount();
});

test("an agent's mark is drawn in the text colour, hidden from assistive tech", async () => {
  const { host, unmount } = await mount(
    <>
      <AgentIcon agent="opencode" size={16} />
      <AgentIcon agent="someone-elses" />
    </>,
  );
  const [mark, robot] = [...host.querySelectorAll("svg")];
  expect(mark!.getAttribute("fill")).toBe("currentColor");
  expect(mark!.getAttribute("width")).toBe("16");
  expect(mark!.getAttribute("aria-hidden")).toBe("true");
  expect(mark!.querySelectorAll("path").length).toBeGreaterThan(0);
  expect(robot!.getAttribute("data-agent-icon")).toBe("generic");
  expect(robot!.getAttribute("aria-hidden")).toBe("true");
  await unmount();
});

test("picking another agent swaps the models and the effort levels under it, and the session it starts", async () => {
  agentChat.setAgents([CLAUDE, CODEX]);
  const { host, unmount } = await mount(pane);
  await click(chipOf(host));
  await click(radio(host, "Agent", "Codex"));
  // The picker stays open on the other agent's list.
  expect(group(host, "Agent").on).toEqual(["Codex"]);
  expect(group(host, "Model")).toEqual({ names: ["6-Sol", "6-Luna"], on: ["6-Sol"] });
  expect(group(host, "Effort")).toEqual({ names: ["Default", "Low", "Medium", "High"], on: ["Default"] });
  expect(host.textContent).toContain("New Codex session");
  const chip = chipOf(host);
  expect(chip.getAttribute("aria-label")).toBe("Agent: Codex · Model: 6-Sol · Effort: default");
  expect(chip.querySelector("[data-agent-icon]")!.getAttribute("data-agent-icon")).toBe("codex");
  // The mode is the agent's own default again.
  expect(host.querySelector('[data-picker="mode"] button')!.getAttribute("aria-label")).toBe("Permission mode: Manual");
  // Picking an agent writes nothing: it is not a default.
  expect(wrote).toEqual([]);
  await unmount();
});

test("picking a model keeps the picker open with that model's effort levels, and picking an effort closes it", async () => {
  agentChat.setAgents([CLAUDE, CODEX]);
  const { host, unmount } = await mount(pane);
  await click(chipOf(host));
  await click(radio(host, "Model", "Sonnet 5.5"));
  // Before a session the pick is what the agent's sessions start on.
  expect(wrote).toEqual(['PUT /api/agent/agents/claude/defaults {"model":"sonnet"}']);
  expect(pickerOf(host)).not.toBeNull();
  expect(group(host, "Model").on).toEqual(["Sonnet 5.5"]);
  expect(group(host, "Effort").names).toEqual(["Default", "Low", "Medium", "High"]);

  await click(radio(host, "Effort", "Low"));
  expect(wrote.at(-1)).toBe('PUT /api/agent/agents/claude/defaults {"effort":"low"}');
  expect(pickerOf(host)).toBeNull();
  expect(chipOf(host).textContent).toBe("Sonnet 5.5· Low");

  // A model that takes no level has no effort row, and the chip names none.
  await click(chipOf(host));
  await click(radio(host, "Model", "Haiku 5.5"));
  expect(host.querySelector('[role="radiogroup"][aria-label="Effort"]')).toBeNull();
  expect(chipOf(host).textContent).toBe("Haiku 5.5");
  // ESC closes it.
  await press(pickerOf(host)!, "Escape");
  expect(pickerOf(host)).toBeNull();
  await unmount();
});

test("a short list picks a model by its number, and the arrows move through the models and the levels", async () => {
  agentChat.setAgents([CLAUDE]);
  const { host, unmount } = await mount(pane);
  await click(chipOf(host));
  // One agent: nothing to pick between, so no agent row.
  expect(host.querySelector('[role="radiogroup"][aria-label="Agent"]')).toBeNull();
  expect(pickerOf(host)!.getAttribute("aria-label")).toBe("Model and effort");
  const opus = radio(host, "Model", "Opus 5.5");
  await press(opus, "ArrowDown");
  expect(document.activeElement).toBe(radio(host, "Model", "Sonnet 5.5"));
  await press(document.activeElement!, "ArrowUp");
  await press(document.activeElement!, "ArrowUp");
  expect(document.activeElement).toBe(radio(host, "Model", "Haiku 5.5"));
  const high = radio(host, "Effort", "High");
  await doing(() => high.focus());
  // A level's button says what the level means in its tooltip.
  expect(document.querySelector('[role="tooltip"]')!.textContent).toBe(EFFORT_DESCRIPTION.high);
  await press(high, "ArrowRight");
  expect(document.activeElement).toBe(radio(host, "Effort", "Extra high"));

  await press(document.activeElement!, "2");
  expect(wrote).toEqual(['PUT /api/agent/agents/claude/defaults {"model":"sonnet"}']);
  await unmount();
});

test("a list of nine models still picks by number, and a tenth brings the search field", async () => {
  const list = (n: number): AgentModelOption[] => Array.from({ length: n }, (_, i) => ({ value: `m-${i + 1}`, displayName: `Model ${i + 1}` }));
  expect(MAX_KEYED_MODELS).toBe(9);
  offered.claude = { models: list(MAX_KEYED_MODELS), model: "m-1", effort: null };
  agentChat.setAgents([CLAUDE]);
  const nine = await mount(pane);
  await click(chipOf(nine.host));
  expect(nine.host.querySelector(".agent-model-search")).toBeNull();
  expect([...pickerOf(nine.host)!.querySelectorAll('[aria-label="Model"] kbd')].map((k) => k.textContent)).toEqual([
    "1", "2", "3", "4", "5", "6", "7", "8", "9",
  ]);
  await press(document.activeElement!, "9");
  expect(wrote).toEqual(['PUT /api/agent/agents/claude/defaults {"model":"m-9"}']);
  await nine.unmount();

  agentChat.setChoices("claude", undefined);
  offered.claude = { models: list(MAX_KEYED_MODELS + 1), model: "m-1", effort: null };
  const ten = await mount(pane);
  await click(chipOf(ten.host));
  expect(ten.host.querySelector(".agent-model-search input")).not.toBeNull();
  expect(pickerOf(ten.host)!.querySelector("kbd")).toBeNull();
  await ten.unmount();
});

test("a long list gets a search field where typing narrows it, Enter picks the first match and digits are text", async () => {
  const many: AgentModelOption[] = Array.from({ length: 12 }, (_, i) => ({ value: `m-${i + 1}`, displayName: `Model ${i + 1}` }));
  many.push({ value: "claude-fable-5-2", displayName: "Fable 5.2" });
  offered.claude = { models: many, model: "m-1", effort: null };
  agentChat.setAgents([CLAUDE]);
  const { host, unmount } = await mount(pane);
  await click(chipOf(host));
  const field = host.querySelector<HTMLInputElement>(".agent-model-search input")!;
  expect(field.getAttribute("aria-label")).toBe("Search models");
  // Focus is in the field, and a long list has no numbers to pick by.
  expect(document.activeElement).toBe(field);
  expect(pickerOf(host)!.querySelector("kbd")).toBeNull();
  expect(group(host, "Model").names).toHaveLength(13);

  await press(field, "2");
  expect(wrote).toEqual([]);
  await type(field, "model 1");
  expect(group(host, "Model").names).toEqual(["Model 1", "Model 10", "Model 11", "Model 12"]);
  await type(field, "nothing like it");
  expect(group(host, "Model").names).toEqual([]);
  expect(pickerOf(host)!.textContent).toContain("No model matches “nothing like it”");
  // The value the agent takes is searched too.
  await type(field, "claude-fable");
  expect(group(host, "Model").names).toEqual(["Fable 5.2"]);
  // Down goes into the list, Up from its first row back to the field.
  await press(field, "ArrowDown");
  expect(document.activeElement).toBe(radio(host, "Model", "Fable 5.2"));
  await press(document.activeElement!, "ArrowUp");
  expect(document.activeElement).toBe(field);
  await press(field, "Enter");
  expect(wrote).toEqual(['PUT /api/agent/agents/claude/defaults {"model":"claude-fable-5-2"}']);
  await unmount();
});

test("a running session picks only its model and effort, switching the session itself", async () => {
  agentChat.setAgents([CLAUDE, CODEX]);
  await agentChat.openSession("s1");
  const { host, unmount } = await mount(pane);
  const chip = chipOf(host);
  // The agent is fixed once a session runs: its icon stays, the agent row goes.
  expect(chip.getAttribute("aria-label")).toBe("Model: Opus 5.5 · Effort: High");
  expect(chip.querySelector("[data-agent-icon]")!.getAttribute("data-agent-icon")).toBe("claude");
  await click(chip);
  expect(host.querySelector('[role="radiogroup"][aria-label="Agent"]')).toBeNull();
  await click(radio(host, "Model", "Sonnet 5.5"));
  expect(wrote).toEqual(['PUT /api/agent/chat/s1/model {"model":"sonnet"}']);
  await click(radio(host, "Effort", "Max"));
  expect(wrote.at(-1)).toBe('PUT /api/agent/chat/s1/effort {"effort":"max"}');
  expect(pickerOf(host)).toBeNull();
  await unmount();
  await agentChat.end("s1");
});

test("an agent that cannot switch models in a session still picks its effort, and one with nothing to pick is plain text", async () => {
  const picked: (string | null)[] = [];
  const choices: AgentChoices = { models: CLAUDE_MODELS, model: "opus", effort: null };
  const fixed: AgentDescriptor = { ...CLAUDE, capabilities: { ...CLAUDE.capabilities, canChangeModelMidSession: false } };
  const props = { choices, model: "opus", effort: null, canPickModel: false, disabled: false, onModel: () => {}, onEffort: (e: string | null) => picked.push(e) };
  const { host, unmount } = await mount(<ModelPicker agent={fixed} {...props} />);
  expect(chipOf(host).getAttribute("aria-label")).toBe("Model: Opus 5.5 · Effort: default");
  await click(chipOf(host));
  expect(pickerOf(host)!.getAttribute("aria-label")).toBe("Effort");
  expect(host.querySelector('[role="radiogroup"][aria-label="Model"]')).toBeNull();
  expect(pickerOf(host)!.textContent).toContain("Claude runs on Opus 5.5 for the whole session");
  await click(radio(host, "Effort", "Medium"));
  expect(picked).toEqual(["medium"]);
  await unmount();

  // No effort either: the model the agent reports, and nothing to open.
  const plain: AgentDescriptor = { ...fixed, capabilities: { ...fixed.capabilities, effort: false } };
  const text = await mount(<ModelPicker agent={plain} {...props} />);
  expect(text.host.querySelector("button")).toBeNull();
  expect(text.host.textContent).toBe("Opus 5.5");
  await text.unmount();
});

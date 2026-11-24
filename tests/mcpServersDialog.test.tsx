// The "MCP servers…" dialog of the coding agent pane (specs/agents/agent-pane
// .feature.md "MCP servers before a session"): the header's ⋯ menu on the
// new-session screen opens it; it lists the agent's servers for the folder
// a session would start in, acts on them, shows one server's details, its
// context cost and its use, adds one and deletes one. The words and numbers
// are pinned through the pure helpers and static markup; the behaviour
// needs a DOM, borrowed the way tests/agentRail.test.tsx does.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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

afterEach(() => {
  globalThis.fetch = realFetch;
  localStorage.clear();
  forgetFolderInfos();
  agentChat.setAgents([]);
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPane } from "../src/frontend/AgentPane";
import {
  MCP_SCOPE_LABEL,
  MCP_TRANSPORT_LABEL,
  McpAddForm,
  McpServerDetails,
  McpServersDialog,
  draftOf,
  linesOf,
  mcpToolRows,
  mcpTotals,
  mcpTotalsLine,
  pairsOf,
  type McpCatalogApi,
  type McpDraftFields,
} from "../src/frontend/McpServersDialog";
import { McpServerRow } from "../src/frontend/SessionRail";
import { Toaster } from "../src/frontend/Toasts";
import { agentChat, forgetFolderInfos } from "../src/frontend/agentChat";
import type { McpCatalog, McpServerDetail, McpServerDraft, McpServerUsage } from "../src/frontend/agentChat";
import { MCP_SCOPES, MCP_TRANSPORTS, type McpManageCapability } from "../src/server/agentTypes";
import { CLAUDE_AGENT, CODEX_AGENT, agent } from "./fixtures/agents";

const CAN: McpManageCapability = { scopes: MCP_SCOPES, transports: MCP_TRANSPORTS };
const CLAUDE = agent({ ...CLAUDE_AGENT, capabilities: { ...CLAUDE_AGENT.capabilities, hasAccount: false, mcpManage: CAN } });

const STUB: McpServerDetail = {
  name: "stub",
  status: "connected",
  source: "user",
  scope: "user",
  transport: "stdio",
  command: "bun",
  args: ["stub.ts", "--fast"],
  envNames: ["API_KEY"],
  serverName: "stub-server",
  version: "9.9.1",
  tools: 2,
  toolList: [
    { name: "search", tokens: 700, loaded: false },
    { name: "read", tokens: 1_300, loaded: true },
  ],
  context: { loaded: 1_300, deferred: 700 },
  canToggle: true,
  canAuthenticate: false,
  canDelete: true,
};
const LINEAR: McpServerDetail = {
  name: "linear",
  status: "needs-auth",
  source: "claude.ai",
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  headerNames: ["X-Team"],
  canToggle: true,
  canAuthenticate: true,
  canDelete: false,
};
const FIGMA: McpServerDetail = {
  name: "figma",
  status: "failed",
  source: "project",
  scope: "project",
  transport: "sse",
  url: "http://127.0.0.1:3845/sse",
  error: "ECONNREFUSED",
  canToggle: true,
  canAuthenticate: false,
  canDelete: true,
};
const USAGE: McpServerUsage = {
  calls: 12,
  errors: 3,
  sessions: 2,
  lastAt: "2026-11-23T16:20:00.000Z",
  tools: { search: { calls: 9, errors: 1 }, read: { calls: 1, errors: 0 }, old_tool: { calls: 2, errors: 2 } },
};

// --- Words and numbers -------------------------------------------------------------

test("the line under the title counts the servers, their tools and what they take of the window", () => {
  const totals = mcpTotals([STUB, LINEAR, FIGMA]);
  expect(totals).toEqual({ servers: 3, tools: 2, loaded: 1_300, deferred: 700 });
  expect(mcpTotalsLine(totals, 200_000)).toBe("3 servers · 2 tools · 1.3k tokens in a new session (0.7% of the window) · 700 more once their tools load");
  // No window known: no share. Nothing loaded: only what loads later.
  expect(mcpTotalsLine(totals)).toBe("3 servers · 2 tools · 1.3k tokens in a new session · 700 more once their tools load");
  expect(mcpTotalsLine({ servers: 1, tools: 1, loaded: 0, deferred: 90 }, 200_000)).toBe("1 server · 1 tool · 90 more once their tools load");
  expect(mcpTotalsLine(mcpTotals([]), 200_000)).toBe("No MCP servers");
  // A server that says only how many tools it has still counts them.
  expect(mcpTotals([{ ...LINEAR, status: "connected", tools: 5 }]).tools).toBe(5);
});

test("a server's tools stand with their use, the costliest first, then the ones only the count knows", () => {
  expect(mcpToolRows(STUB.toolList, USAGE)).toEqual([
    { name: "read", tokens: 1_300, loaded: true, calls: 1, errors: 0 },
    { name: "search", tokens: 700, loaded: false, calls: 9, errors: 1 },
    { name: "old_tool", calls: 2, errors: 2 },
  ]);
  expect(mcpToolRows(STUB.toolList, undefined).map((r) => r.calls)).toEqual([0, 0]);
  // A server that is off lists no tools, yet its calls were counted.
  expect(mcpToolRows(undefined, USAGE).map((r) => r.name)).toEqual(["search", "old_tool", "read"]);
  expect(mcpToolRows(undefined, undefined)).toEqual([]);
});

test("the form's lines become arguments and name–value pairs, and a draft the server would take", () => {
  expect(linesOf(" -y \n\n @example/server \n")).toEqual(["-y", "@example/server"]);
  expect(pairsOf("API_KEY=a=b\n EMPTY= ", "=")).toEqual({ API_KEY: "a=b", EMPTY: "" });
  expect(pairsOf("Authorization: Bearer x:y", ":")).toEqual({ Authorization: "Bearer x:y" });
  expect(pairsOf("no separator", "=")).toBe('"no separator" is not a name=value pair');
  expect(pairsOf(": value", ":")).toBe('": value" is not a name: value pair');

  const fields: McpDraftFields = { name: "weather", scope: "local", transport: "stdio", command: "npx", args: "-y\nweather-mcp", env: "KEY=v", url: "https://ignored", headers: "X: ignored" };
  expect(draftOf(fields, CAN, [])).toEqual({ name: "weather", scope: "local", transport: "stdio", command: "npx", args: ["-y", "weather-mcp"], env: { KEY: "v" } });
  expect(draftOf({ ...fields, transport: "http", url: "https://w.example/mcp", headers: "X-Key: abc" }, CAN, [])).toEqual({
    name: "weather",
    scope: "local",
    transport: "http",
    url: "https://w.example/mcp",
    headers: { "X-Key": "abc" },
  });
  expect(draftOf(fields, CAN, ["weather"])).toBe('There is already an MCP server named "weather"');
  expect(draftOf({ ...fields, env: "broken" }, CAN, [])).toBe('"broken" is not a name=value pair');
  expect(draftOf({ ...fields, command: " " }, CAN, [])).toBe("Give the command that starts the server");
  expect(MCP_SCOPE_LABEL).toEqual({ local: "This folder only", user: "All my folders", project: "Shared with the repo" });
  expect(MCP_TRANSPORT_LABEL).toEqual({ stdio: "Command", http: "HTTP", sse: "SSE" });
});

test("a server's details say where it is kept, how it is reached, what it costs and how it was used", () => {
  const html = renderToStaticMarkup(
    <McpServerDetails server={STUB} usage={USAGE} usageSince="2026-11-20T10:00:00.000Z" contextWindow={200_000} onDelete={() => {}} />,
  );
  expect(html).toContain("<h4>stub</h4>");
  expect(html).toContain("Connected · 2 tools");
  for (const fact of [
    "<dt>Kept in</dt><dd>All my folders</dd>",
    "<dt>Kind</dt><dd>Command (stdio)</dd>",
    "<dt>Command</dt><dd>bun stub.ts --fast</dd>",
    "<dt>Environment</dt><dd>API_KEY</dd>",
    "<dt>Server</dt><dd>stub-server 9.9.1</dd>",
  ]) {
    expect(html).toContain(fact);
  }
  expect(html).toContain("1.3k tokens in a new session · 0.7% of the window · 700 more once its tools load");
  expect(html).toContain('aria-label="0.7% of the context window"');
  expect(html).toContain("12 calls in 2 sessions · 3 errors · last used ");
  expect(html).toContain("Counted in the sessions run here since ");
  expect(html).toContain("<h5>Tools (3)</h5>");
  expect(html).toMatch(/<tr data-tool="search"><td title="search">search<\/td><td class="num">700<span class="mcp-detail-deferred"> on demand<\/span><\/td><td class="num">9<\/td><td class="num">1<\/td><\/tr>/);
  expect(html).toMatch(/<tr data-tool="old_tool"><td title="old_tool">old_tool<\/td><td class="num">–<\/td>/);
  expect(html).toContain('<button type="button" class="btn btn-danger">Delete server…</button>');

  // A failed server says why; one the agent cannot delete has no Delete; a
  // source that is no place to delete from is where it comes "From".
  const failed = renderToStaticMarkup(<McpServerDetails server={FIGMA} onDelete={() => {}} />);
  expect(failed).toContain('<p class="error mcp-detail-error" role="alert">ECONNREFUSED</p>');
  expect(failed).toContain("<dt>Kind</dt><dd>SSE</dd>");
  expect(failed).toContain("Counted once the server is connected.");
  expect(failed).toContain("No calls counted yet.");
  expect(failed).toContain("The app counts the calls of the sessions it runs in this folder, from now on.");
  expect(failed).not.toContain("<h5>Tools");
  const remote = renderToStaticMarkup(<McpServerDetails server={LINEAR} onDelete={() => {}} />);
  expect(remote).toContain("<dt>From</dt><dd>claude.ai</dd>");
  expect(remote).toContain("<dt>Headers</dt><dd>X-Team</dd>");
  expect(remote).not.toContain("Delete server");
  // Every button carries a class of its own.
  for (const markup of [html, failed, remote]) expect(markup).not.toMatch(/<button(?![^>]*class=)/);
});

test("the dialog's row picks its server, and the form offers what the agent takes", () => {
  const row = renderToStaticMarkup(<McpServerRow server={STUB} busy={false} onAction={() => {}} selected onSelect={() => {}} />);
  expect(row).toContain('<li data-server="stub" data-status="connected" data-selected="true">');
  expect(row).toContain('<button type="button" class="agent-mcp-pick" aria-current="true">');
  expect(row).toContain("user · Connected · 2 tools");
  // The popover's row is as it was: no button around the name.
  expect(renderToStaticMarkup(<McpServerRow server={STUB} busy={false} onAction={() => {}} />)).not.toContain("agent-mcp-pick");

  const form = renderToStaticMarkup(<McpAddForm can={{ scopes: ["user", "local"], transports: ["http", "stdio"] }} taken={[]} onAdd={async () => {}} onCancel={() => {}} />);
  // The first of each the agent takes is the one picked.
  expect(form).toContain('<input type="radio" name="mcp-scope" checked="" value="user"/>');
  expect(form).toContain('<input type="radio" name="mcp-transport" checked="" value="http"/>');
  expect(form).not.toContain('value="project"');
  expect(form).not.toContain('value="sse"');
  expect(form).toContain('name="mcp-url"');
  expect(form).not.toContain('name="mcp-command"');
  expect(form).not.toMatch(/<button(?![^>]*class=)/);
});

// --- In a page -----------------------------------------------------------------------

function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const settle = () => act(() => Bun.sleep(10));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="MCP servers"]');
const rowOf = (name: string) => dialog()!.querySelector<HTMLElement>(`.mcp-dialog-list li[data-server="${name}"]`)!;
const buttonNamed = (within: Element, text: string) => [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;

/** Type into a field the way React hears it under happy-dom. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", bubbles: true }) as unknown as Event);
  });
}

/** A catalog the test owns behind the dialog's five calls; `calls` is what was asked. */
function fakeApi(servers: McpServerDetail[], usage: Record<string, McpServerUsage> = {}) {
  const calls: string[] = [];
  const state = { addError: null as string | null };
  const catalog = (url?: string): McpCatalog => ({
    servers: servers.map((s) => ({ ...s })),
    contextWindow: 200_000,
    usage,
    ...(url ? { url } : {}),
  });
  const named = (name: string) => servers.find((s) => s.name === name)!;
  const api: McpCatalogApi = {
    async mcpCatalog(agentId, cwd) {
      calls.push(`list ${agentId} ${cwd ?? "-"}`);
      return catalog();
    },
    async mcpCatalogAction(agentId, server, action, cwd) {
      calls.push(`${action} ${server} ${cwd ?? "-"}`);
      if (action === "disable") named(server).status = "disabled";
      if (action === "enable") throw new Error("Claude could not enable it: timed out");
      return catalog(action === "authenticate" ? "https://auth.example/authorize?state=1" : undefined);
    },
    async addMcpServer(agentId, draft: McpServerDraft, cwd) {
      calls.push(`add ${JSON.stringify(draft)} ${cwd ?? "-"}`);
      if (state.addError) throw new Error(state.addError);
      servers.push({ name: draft.name, status: "connected", source: draft.scope, scope: draft.scope, transport: draft.transport, canToggle: true, canAuthenticate: false, canDelete: true });
      return catalog();
    },
    async removeMcpServer(agentId, name, cwd) {
      calls.push(`remove ${name} ${cwd ?? "-"}`);
      servers.splice(servers.findIndex((s) => s.name === name), 1);
      return catalog();
    },
    async releaseMcp(agentId, cwd) {
      calls.push(`release ${agentId} ${cwd ?? "-"}`);
    },
  };
  return { api, calls, state };
}

test("the dialog lists the agent's servers, shows the one picked, and turns one off", async () => {
  const { api, calls } = fakeApi([{ ...STUB }, { ...LINEAR }, { ...FIGMA }], { stub: USAGE });
  let closed = 0;
  const { unmount } = mount(
    <>
      <McpServersDialog agent={CLAUDE} folder="/w/code" cwd="/w/code" homeDir="/w" onClose={() => (closed += 1)} api={api} />
      <Toaster />
    </>,
  );
  // Asked once, for the folder; until then the dialog says it is asking.
  expect(dialog()!.textContent).toContain("Asking the agent for its MCP servers…");
  await settle();
  expect(calls).toEqual(["list claude /w/code"]);
  expect(dialog()!.querySelector(".mcp-dialog-where")!.textContent).toBe("Claude · ~/code");
  expect(dialog()!.querySelector(".mcp-dialog-totals")!.textContent).toContain("3 servers · 2 tools · 1.3k tokens in a new session");
  expect([...dialog()!.querySelectorAll(".mcp-dialog-list li")].map((li) => li.getAttribute("data-server"))).toEqual(["stub", "linear", "figma"]);
  // The first server is shown without a click.
  expect(rowOf("stub").hasAttribute("data-selected")).toBe(true);
  expect(dialog()!.querySelector(".mcp-detail")!.getAttribute("data-server")).toBe("stub");
  expect(dialog()!.querySelector(".mcp-detail-usage")!.textContent).toContain("12 calls in 2 sessions");

  // Picking another shows that one.
  act(() => rowOf("figma").querySelector<HTMLButtonElement>(".agent-mcp-pick")!.click());
  expect(dialog()!.querySelector(".mcp-detail")!.getAttribute("data-server")).toBe("figma");
  expect(dialog()!.querySelector(".mcp-detail-error")!.textContent).toBe("ECONNREFUSED");
  expect(rowOf("stub").hasAttribute("data-selected")).toBe(false);

  // The switch turns a server off, and the row follows the agent's answer.
  await act(async () => rowOf("stub").querySelector<HTMLInputElement>('input[role="switch"]')!.click());
  await settle();
  expect(calls.at(-1)).toBe("disable stub /w/code");
  expect(rowOf("stub").getAttribute("data-status")).toBe("disabled");
  // An action the agent refuses is said in a toast, and the row stays.
  await act(async () => rowOf("stub").querySelector<HTMLInputElement>('input[role="switch"]')!.click());
  await settle();
  // By its words: the toast store is the whole test run's, and error toasts stay up.
  const refusals = () => [...document.querySelectorAll(".toast")].filter((t) => t.textContent?.includes("could not enable it"));
  expect(refusals().map((t) => t.querySelector(".toast-message")?.textContent)).toEqual(["Claude could not enable it: timed out"]);
  for (const t of refusals()) await act(async () => t.querySelector<HTMLButtonElement>("button.toast-close")!.click());
  expect(rowOf("stub").getAttribute("data-status")).toBe("disabled");

  // Esc closes; shutting the dialog tells the agent it can let go.
  act(() => {
    dialog()!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  });
  expect(closed).toBe(1);
  unmount();
  expect(calls.at(-1)).toBe("release claude /w/code");
  expect(dialog()).toBeNull();
});

test("Sign in opens the agent's page, keeps a link to it, and the list asks again until the server connects", async () => {
  const servers = [{ ...LINEAR }];
  const { api, calls } = fakeApi(servers);
  const opened: string[] = [];
  const realOpen = window.open;
  window.open = ((url: string) => {
    opened.push(url);
    return null;
  }) as unknown as typeof window.open;
  const { unmount } = mount(<McpServersDialog agent={CLAUDE} folder="/w/code" onClose={() => {}} api={api} />);
  await settle();
  // No folder was picked: the server's default is asked about.
  expect(calls).toEqual(["list claude -"]);
  await act(async () => buttonNamed(rowOf("linear"), "Sign in").click());
  await settle();
  expect(calls.at(-1)).toBe("authenticate linear -");
  expect(opened).toEqual(["https://auth.example/authorize?state=1"]);
  expect(rowOf("linear").querySelector<HTMLAnchorElement>(".agent-mcp-link")!.href).toBe("https://auth.example/authorize?state=1");
  // The sign-in went through in the browser: the next ask shows it connected.
  servers[0]!.status = "connected";
  const asked = calls.length;
  await act(() => Bun.sleep(2_200));
  expect(calls.length).toBeGreaterThan(asked);
  expect(calls.at(-1)).toBe("list claude -");
  expect(rowOf("linear").getAttribute("data-status")).toBe("connected");
  window.open = realOpen;
  unmount();
});

test("Add server takes the form's draft to the agent, and Delete asks once more before it deletes", async () => {
  const { api, calls, state } = fakeApi([{ ...STUB }, { ...LINEAR }]);
  const { unmount } = mount(<McpServersDialog agent={CLAUDE} folder="/w/code" cwd="/w/code" onClose={() => {}} api={api} />);
  await settle();
  act(() => buttonNamed(dialog()!, "Add server").click());
  const form = () => dialog()!.querySelector<HTMLFormElement>(".mcp-add-form")!;
  const field = <T extends HTMLInputElement | HTMLTextAreaElement>(name: string) => form().querySelector<T>(`[name="${name}"]`)!;
  const submit = () => act(async () => form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(form()).not.toBeNull();
  // The form stands where the details stood; no server is marked picked.
  expect(dialog()!.querySelector(".mcp-detail")).toBeNull();
  expect(dialog()!.querySelector(".mcp-dialog-list li[data-selected]")).toBeNull();

  // What is missing is said in the form, and nothing is sent.
  await submit();
  expect(form().querySelector(".mcp-add-problem")!.textContent).toBe("Give the server a name");
  type(field("mcp-name"), "stub");
  type(field("mcp-command"), "npx");
  await submit();
  expect(form().querySelector(".mcp-add-problem")!.textContent).toBe('There is already an MCP server named "stub"');
  expect(calls.filter((c) => c.startsWith("add"))).toEqual([]);

  // A url server, shared with the repo: the form warns what that means.
  type(field("mcp-name"), "weather");
  act(() => form().querySelector<HTMLInputElement>('input[name="mcp-scope"][value="project"]')!.click());
  expect(form().querySelector(".mcp-add-choice .hint")!.textContent).toContain("secrets included");
  act(() => form().querySelector<HTMLInputElement>('input[name="mcp-transport"][value="http"]')!.click());
  expect(form().querySelector('[name="mcp-command"]')).toBeNull();
  type(field("mcp-url"), "https://weather.example/mcp");
  type(field<HTMLTextAreaElement>("mcp-headers"), "X-Key: abc");
  // The agent's refusal is said in the form, which stays for another try.
  state.addError = "MCP server weather already exists in .mcp.json";
  await submit();
  await settle();
  expect(form().querySelector(".mcp-add-problem")!.textContent).toBe("MCP server weather already exists in .mcp.json");
  state.addError = null;
  await submit();
  await settle();
  const draft = { name: "weather", scope: "project", transport: "http", url: "https://weather.example/mcp", headers: { "X-Key": "abc" } };
  expect(calls.at(-1)).toBe(`add ${JSON.stringify(draft)} /w/code`);
  // Added: the form is gone and the new server is the one shown.
  expect(dialog()!.querySelector(".mcp-add-form")).toBeNull();
  expect(dialog()!.querySelector(".mcp-detail")!.getAttribute("data-server")).toBe("weather");
  expect(rowOf("weather").hasAttribute("data-selected")).toBe(true);

  // Cancel leaves the form without sending anything.
  act(() => buttonNamed(dialog()!, "Add server").click());
  act(() => buttonNamed(form(), "Cancel").click());
  expect(dialog()!.querySelector(".mcp-add-form")).toBeNull();

  // Delete asks once more, in place, saying where the server is taken from.
  const detail = () => dialog()!.querySelector<HTMLElement>(".mcp-detail")!;
  act(() => buttonNamed(detail(), "Delete server…").click());
  expect(detail().querySelector(".mcp-detail-confirm")!.textContent).toBe("Delete weather from the file the repo shares?");
  act(() => buttonNamed(detail(), "Cancel").click());
  expect(calls.some((c) => c.startsWith("remove"))).toBe(false);
  act(() => buttonNamed(detail(), "Delete server…").click());
  await act(async () => buttonNamed(detail(), "Delete").click());
  await settle();
  expect(calls.at(-1)).toBe("remove weather /w/code");
  expect(dialog()!.querySelector(`.mcp-dialog-list li[data-server="weather"]`)).toBeNull();
  // The first server is shown again; one the agent cannot delete offers no Delete.
  expect(detail().getAttribute("data-server")).toBe("stub");
  act(() => rowOf("linear").querySelector<HTMLButtonElement>(".agent-mcp-pick")!.click());
  expect(detail().textContent).not.toContain("Delete server");
  unmount();
});

test("an agent that cannot be asked says why, and one with no servers says so", async () => {
  const failing = fakeApi([]);
  failing.api.mcpCatalog = async () => {
    throw new Error("Claude CLI not found");
  };
  const first = mount(<McpServersDialog agent={CLAUDE} folder="/w/code" onClose={() => {}} api={failing.api} />);
  await settle();
  expect(dialog()!.querySelector(".mcp-dialog-error")!.textContent).toBe("Claude CLI not found");
  expect(dialog()!.querySelector(".mcp-dialog-list")).toBeNull();
  expect(buttonNamed(dialog()!, "Add server").disabled).toBe(true);
  first.unmount();

  const empty = mount(<McpServersDialog agent={CLAUDE} folder="/w/code" onClose={() => {}} api={fakeApi([]).api} />);
  await settle();
  expect(dialog()!.querySelector(".mcp-dialog-totals")!.textContent).toBe("No MCP servers");
  expect(dialog()!.querySelector(".mcp-dialog-empty")!.textContent).toBe("Claude has no MCP servers for this folder. Add server sets one up.");
  empty.unmount();
});

// --- The header's ⋯ menu ---------------------------------------------------------------

/** A server with no sessions that answers the dialog's list. */
function server(asked: string[]) {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("/api/agent/agents/") && url.includes("/mcp")) {
      asked.push(`${init.method ?? "GET"} ${url}`);
      return Response.json({ servers: [STUB], contextWindow: 200_000, usage: {} } satisfies McpCatalog);
    }
    if (url.startsWith("/api/agent/folder?")) return Response.json({ canWorktree: true, repo: "/w/code", branch: "main" });
    return Response.json({ choices: null });
  }) as unknown as typeof fetch;
}

test("the header's ⋯ menu offers MCP servers… before a session, for an agent that manages them", async () => {
  const asked: string[] = [];
  server(asked);
  agentChat.setAgents([CLAUDE]);
  const { host, unmount } = mount(
    <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" homeDir="/w" onClose={() => {}} />,
  );
  await settle();
  const more = () => host.querySelector<HTMLButtonElement>('.agent-head button[aria-label="More for Claude"]');
  expect(more()).not.toBeNull();
  expect(more()!.getAttribute("aria-haspopup")).toBe("menu");
  // Nothing is asked of the agent until the dialog opens.
  expect(asked).toEqual([]);
  act(() => more()!.click());
  const items = [...host.querySelectorAll<HTMLElement>('.agent-head-menu [role="menuitem"]')];
  expect(items.map((i) => i.textContent)).toEqual(["MCP servers…"]);
  act(() => items[0]!.click());
  await settle();
  // The dialog is about the folder a session would start in — the default
  // one, so no folder is named to the server.
  expect(dialog()).not.toBeNull();
  expect(dialog()!.querySelector(".mcp-dialog-where")!.textContent).toBe("Claude · ~/code");
  expect(asked).toEqual(["GET /api/agent/agents/claude/mcp"]);
  expect(rowOf("stub").textContent).toContain("user · Connected · 2 tools");
  // Closing it tells the agent.
  act(() => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  await settle();
  expect(dialog()).toBeNull();
  expect(asked.at(-1)).toBe("POST /api/agent/agents/claude/mcp/release");
  unmount();
});

test("an agent that does not manage its MCP servers has no ⋯ menu", async () => {
  server([]);
  agentChat.setAgents([agent({ ...CODEX_AGENT })]);
  const { host, unmount } = mount(
    <AgentPane compact={false} demo={false} codeRepo="/w/code" dataRepo="/w/data" onClose={() => {}} />,
  );
  await settle();
  expect(host.querySelector(".agent-head-menu")).toBeNull();
  expect(host.querySelector('.agent-head button[aria-label="Close the coding agent pane"]')).not.toBeNull();
  unmount();
});

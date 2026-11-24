// MCP servers before a session (specs/agents/agent-pane.feature.md "MCP
// servers before a session"): the pane's "MCP servers…" dialog asks the
// agent itself, with no session running — AgentProvider.mcp, relayed by
// src/server/agentChat.ts over /api/agent/agents/:agent/mcp — and the app
// adds its own count of how each server was used (src/server/mcpUsage.ts).
// Driven by a fake provider (tests/helpers/fakeAgent.ts).

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  ChatError,
  addAgentMcpServer,
  agentMcpCatalog,
  changeAgentMcpServer,
  endAllChatSessions,
  getChatSession,
  releaseAgentMcp,
  removeAgentMcpServer,
  type AgentMcpPlace,
} from "../src/server/agentChat";
import {
  MCP_SCOPES,
  MCP_TRANSPORTS,
  checkMcpDraft,
  type ChatSessionMeta,
  type McpCatalog,
  type McpManageCapability,
  type McpServerDetail,
  type McpServerDraft,
  type McpToolCounts,
} from "../src/server/agentTypes";
import {
  countMcpUse,
  folderMcpCounts,
  isMcpToolName,
  mcpCountsOf,
  mcpNameKey,
  usageByServer,
  type SessionMcpCounts,
} from "../src/server/mcpUsage";
import { forgetSimulatedMcp, simulatedMcpAdmin } from "../src/server/demoAgent";
import { readOnlyAllows } from "../src/server/readOnlyMode";
import { AgentError, agents, type AgentMcpAdmin, type AgentMcpContext } from "../src/plugins/host/agents";
import type { Disposer } from "../src/plugins/kernel";
import { writeState } from "../src/server/state";
import { fakeProvider, type FakeProviderOptions } from "./helpers/fakeAgent";

let root: string;
let data: string;
const disposers: Disposer[] = [];
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

function register(options: FakeProviderOptions = {}) {
  const fake = fakeProvider(options);
  disposers.push(agents.register(fake.provider));
  return fake;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-agent-mcp-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  data = join(root, "data");
  await writeState({ dataRepo: data }, root);
  await Bun.write(join(data, "specs", ".keep"), "");
});

afterEach(async () => {
  await endAllChatSessions();
  reloader.stop();
  forgetSimulatedMcp();
  for (const dispose of disposers.splice(0)) await dispose();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ) as Promise<Response>;
}

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting; last: ${JSON.stringify(v).slice(0, 300)}`);
    await Bun.sleep(5);
  }
}

const CAN: McpManageCapability = { scopes: MCP_SCOPES, transports: MCP_TRANSPORTS };

/** A provider's MCP hook over a list the test owns; `calls` is what it was asked. */
function fakeAdmin(servers: McpServerDetail[]) {
  const calls: string[] = [];
  const contexts: AgentMcpContext[] = [];
  const state = { failWith: null as Error | null };
  const named = (name: string) => servers.find((s) => s.name === name)!;
  const admin: AgentMcpAdmin = {
    async list(ctx) {
      contexts.push(ctx);
      return { servers: servers.map((s) => ({ ...s })), contextWindow: 200_000 };
    },
    async act(_ctx, name, action) {
      if (state.failWith) throw state.failWith;
      calls.push(`${action} ${name}`);
      if (action === "disable") named(name).status = "disabled";
      else if (action === "authenticate") return { url: "https://auth.example/authorize?state=abc" };
      else named(name).status = "connected";
    },
    async add(_ctx, draft) {
      if (state.failWith) throw state.failWith;
      calls.push(`add ${JSON.stringify(draft)}`);
      servers.push({ name: draft.name, status: "connected", source: draft.scope, scope: draft.scope, canToggle: true, canAuthenticate: false, canDelete: true });
    },
    async remove(_ctx, name, scope) {
      calls.push(`remove ${name} from ${scope}`);
      servers.splice(servers.findIndex((s) => s.name === name), 1);
    },
    release(ctx) {
      calls.push(`release ${ctx.cwd}`);
    },
  };
  return { admin, calls, contexts, state };
}

const SERVERS = (): McpServerDetail[] => [
  {
    name: "stub",
    status: "connected",
    source: "user",
    scope: "user",
    transport: "stdio",
    command: "bun",
    args: ["stub.ts"],
    tools: 2,
    toolList: [
      { name: "search", tokens: 70, loaded: false },
      { name: "read", tokens: 90, loaded: true },
    ],
    context: { loaded: 90, deferred: 70 },
    canToggle: true,
    canAuthenticate: false,
    canDelete: true,
  },
  { name: "plugin:design:figma", status: "needs-auth", source: "user", transport: "http", canToggle: true, canAuthenticate: true, canDelete: false },
  { name: "claude.ai Slack", status: "failed", source: "claude.ai", error: "connection refused", canToggle: false, canAuthenticate: false, canDelete: false },
];

// --- The count (src/server/mcpUsage.ts) ----------------------------------------------

test("an MCP tool the agent calls is counted, and a result that comes back an error is its error", () => {
  expect(isMcpToolName("mcp__stub__search")).toBe(true);
  expect(isMcpToolName("Bash")).toBe(false);
  expect(isMcpToolName("mcp__")).toBe(false);
  const counts: McpToolCounts = {};
  const pending = new Map<string, string>();
  const use = (id: string, name: string) =>
    countMcpUse(counts, pending, { kind: "assistant", messageId: "m", turn: 1, blocks: [{ type: "tool_use", id, name, input: {} }], parentToolUseId: null }, `2026-11-24T10:0${id}:00.000Z`);
  const result = (toolUseId: string, isError: boolean) =>
    countMcpUse(counts, pending, { kind: "tool_result", toolUseId, content: "", isError, parentToolUseId: null });
  expect(use("1", "mcp__stub__search")).toBe(true);
  expect(use("2", "mcp__stub__search")).toBe(true);
  // A tool of the agent's own is not an MCP server's.
  expect(use("3", "Bash")).toBe(false);
  expect(result("1", false)).toBe(false);
  expect(result("2", true)).toBe(true);
  // A result nobody waits for — the Bash call's, or one counted already — changes nothing.
  expect(result("3", true)).toBe(false);
  expect(result("2", true)).toBe(false);
  expect(counts).toEqual({ mcp__stub__search: { calls: 2, errors: 1, lastAt: "2026-11-24T10:02:00.000Z" } });
  // Text and other events are not calls.
  expect(countMcpUse(counts, pending, { kind: "note", level: "info", code: "init", text: "x" })).toBe(false);
});

test("the sessions' counts are summed by server, the longest name that fits a tool taking it", () => {
  expect(mcpNameKey("claude.ai Slack")).toBe("claude_ai_Slack");
  const sessions: SessionMcpCounts[] = [
    {
      id: "a",
      startedAt: "2026-11-20T10:00:00.000Z",
      counts: {
        mcp__stub__search: { calls: 2, errors: 1, lastAt: "2026-11-20T10:05:00.000Z" },
        mcp__stub__ext__read: { calls: 5, errors: 0, lastAt: "2026-11-20T10:06:00.000Z" },
        mcp__claude_ai_Slack__post: { calls: 1, errors: 0, lastAt: "2026-11-20T10:07:00.000Z" },
        mcp__gone__x: { calls: 9, errors: 9, lastAt: "2026-11-20T10:08:00.000Z" },
      },
    },
    { id: "b", startedAt: "2026-11-21T10:00:00.000Z", counts: { mcp__stub__search: { calls: 3, errors: 0, lastAt: "2026-11-21T10:01:00.000Z" } } },
  ];
  const usage = usageByServer(sessions, ["stub", "stub__ext", "claude.ai Slack", "never"]);
  expect(usage.stub).toEqual({ calls: 5, errors: 1, sessions: 2, lastAt: "2026-11-21T10:01:00.000Z", tools: { search: { calls: 5, errors: 1 } } });
  // `stub` does not take the calls of `stub__ext`.
  expect(usage.stub__ext).toEqual({ calls: 5, errors: 0, sessions: 1, lastAt: "2026-11-20T10:06:00.000Z", tools: { read: { calls: 5, errors: 0 } } });
  // A name with a dot and a space stands in the tool's name with underscores.
  expect(usage["claude.ai Slack"]).toMatchObject({ calls: 1, tools: { post: { calls: 1, errors: 0 } } });
  // Never called: no entry. A server no longer listed is not summed.
  expect(usage).not.toHaveProperty("never");
  expect(Object.keys(usage)).toHaveLength(3);
});

test("a record's count is read back only where it has the shape, and a record without one says nothing", async () => {
  expect(mcpCountsOf(undefined)).toBeNull();
  expect(mcpCountsOf([])).toBeNull();
  expect(mcpCountsOf({})).toEqual({});
  expect(mcpCountsOf({ mcp__a__b: { calls: 2, errors: "x", lastAt: 5 }, Bash: { calls: 1 }, mcp__a__c: { calls: 0 }, mcp__a__d: null })).toEqual({
    mcp__a__b: { calls: 2, errors: 0, lastAt: "" },
  });

  const sessionsDir = join(root, "sessions");
  const record = async (id: string, body: Record<string, unknown>) => {
    await mkdir(join(sessionsDir, id), { recursive: true });
    await writeFile(join(sessionsDir, id, "session.json"), JSON.stringify({ id, ...body }));
  };
  const used = { mcp__stub__search: { calls: 1, errors: 0, lastAt: "2026-11-20T10:05:00.000Z" } };
  await record("old", { agent: "claude", cwd: "/w/code", startedAt: "2026-11-01T10:00:00.000Z" }); // from before the app counted
  await record("mine", { agent: "claude", cwd: "/w/code/", startedAt: "2026-11-20T10:00:00.000Z", mcpUsage: used });
  // A session in a worktree worked for the folder the pane picked.
  await record("tree", { agent: "claude", cwd: "/wt/x/code", worktree: { folder: "/w/code" }, startedAt: "2026-11-19T10:00:00.000Z", mcpUsage: {} });
  await record("codex", { agent: "codex", cwd: "/w/code", startedAt: "2026-11-21T10:00:00.000Z", mcpUsage: used });
  await record("elsewhere", { agent: "claude", cwd: "/w/other", startedAt: "2026-11-21T10:00:00.000Z", mcpUsage: used });
  await mkdir(join(sessionsDir, "broken"), { recursive: true });
  await writeFile(join(sessionsDir, "broken", "session.json"), "{nope");

  const found = await folderMcpCounts(sessionsDir, "claude", "/w/code");
  expect(found.map((s) => s.id)).toEqual(["tree", "mine"]);
  // An open session's count stands for its record, and one not yet recorded is there too.
  const live: (SessionMcpCounts & { agent: string; folder: string })[] = [
    { id: "mine", agent: "claude", folder: "/w/code", startedAt: "2026-11-20T10:00:00.000Z", counts: { mcp__stub__search: { calls: 4, errors: 0, lastAt: "x" } } },
    { id: "new", agent: "claude", folder: "/w/code", startedAt: "2026-11-24T10:00:00.000Z", counts: {} },
    { id: "other", agent: "claude", folder: "/w/other", startedAt: "2026-11-24T10:00:00.000Z", counts: {} },
  ];
  const withLive = await folderMcpCounts(sessionsDir, "claude", "/w/code", live);
  expect(withLive.map((s) => s.id)).toEqual(["tree", "mine", "new"]);
  expect(withLive[1]!.counts.mcp__stub__search!.calls).toBe(4);
  // No records at all is no count.
  expect(await folderMcpCounts(join(root, "none"), "claude", "/w/code")).toEqual([]);
});

// --- The draft (src/server/agentTypes.ts) -----------------------------------------------

test("a server's draft is checked for its name, where it is kept, its kind and what that kind needs", () => {
  expect(checkMcpDraft({ name: " files ", scope: "local", transport: "stdio", command: " npx ", args: ["-y", "x"], env: { KEY: "v", " ": "dropped" } }, CAN)).toEqual({
    name: "files",
    scope: "local",
    transport: "stdio",
    command: "npx",
    args: ["-y", "x"],
    env: { KEY: "v" },
  });
  expect(checkMcpDraft({ name: "web", scope: "user", transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } }, CAN)).toEqual({
    name: "web",
    scope: "user",
    transport: "http",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer x" },
  });
  // No empty lists or maps in a draft.
  expect(checkMcpDraft({ name: "bare", scope: "project", transport: "stdio", command: "srv" }, CAN)).toEqual({ name: "bare", scope: "project", transport: "stdio", command: "srv" });
  const refused = (value: unknown, taken: string[] = []) => checkMcpDraft(value, CAN, taken);
  expect(refused(null)).toBe("server is required");
  expect(refused({ scope: "local", transport: "stdio", command: "x" })).toBe("Give the server a name");
  expect(refused({ name: "bad name!", scope: "local", transport: "stdio", command: "x" })).toContain("letters, numbers, hyphens and underscores");
  expect(refused({ name: "files", scope: "local", transport: "stdio", command: "x" }, ["files"])).toBe('There is already an MCP server named "files"');
  expect(refused({ name: "a", scope: "everywhere", transport: "stdio", command: "x" })).toBe("scope must be one of local, user, project");
  expect(refused({ name: "a", scope: "local", transport: "ws", url: "wss://x" })).toBe("transport must be one of stdio, http, sse");
  expect(refused({ name: "a", scope: "local", transport: "stdio" })).toBe("Give the command that starts the server");
  expect(refused({ name: "a", scope: "local", transport: "stdio", command: "x", args: "one two" })).toBe("args must be a list of words");
  expect(refused({ name: "a", scope: "local", transport: "stdio", command: "x", env: { K: 1 } })).toContain('"K" must have a text value');
  expect(refused({ name: "a", scope: "local", transport: "sse" })).toBe("Give the server's url");
  expect(refused({ name: "a", scope: "local", transport: "http", url: "ftp://x" })).toBe("The url must start with https:// or http://");
  expect(refused({ name: "a", scope: "local", transport: "http", url: "https://x", headers: { H: "a\nb" } })).toContain("must be one line");
  // Only what the agent takes.
  expect(checkMcpDraft({ name: "a", scope: "project", transport: "stdio", command: "x" }, { scopes: ["user"], transports: ["stdio"] })).toBe("scope must be one of user");
});

// --- The relay (src/server/agentChat.ts and its routes) ---------------------------------

test("the dialog's MCP servers are the provider's, asked with no session, for the folder a session would start in", async () => {
  const servers = SERVERS();
  const { admin, calls, contexts } = fakeAdmin(servers);
  register({ id: "gemini", capabilities: { mcpManage: CAN }, mcpAdmin: admin });
  const mcp = "/api/agent/agents/gemini/mcp";

  const listed = await api(mcp);
  expect(listed.status).toBe(200);
  const catalog = (await listed.json()) as McpCatalog;
  expect(catalog.servers).toEqual(servers);
  expect(catalog.contextWindow).toBe(200_000);
  // Nothing was counted here yet.
  expect(catalog.usage).toEqual({});
  expect(catalog).not.toHaveProperty("usageSince");
  // No session was started for it, and the provider was told the folder.
  expect((await (await api("/api/agent/chat")).json()) as unknown).toEqual({ sessions: [] });
  expect(contexts.at(-1)).toEqual({ cwd: data, dataRepo: data });
  // A folder the new-session screen picked is the folder asked about.
  const other = join(root, "other");
  await mkdir(other);
  expect((await api(`${mcp}?cwd=${encodeURIComponent(other)}`)).status).toBe(200);
  expect(contexts.at(-1)).toEqual({ cwd: other, dataRepo: data });
  expect((await api(`${mcp}?cwd=relative/path`)).status).toBe(400);
  expect((await api(`${mcp}?cwd=${encodeURIComponent(join(root, "missing"))}`)).status).toBe(400);

  // Off and on: the answer is the catalog afterwards.
  const off = (await (await api(mcp, "POST", { server: "stub", action: "disable" })).json()) as McpCatalog;
  expect(off.servers[0]).toMatchObject({ name: "stub", status: "disabled" });
  const on = (await (await api(mcp, "POST", { server: "stub", action: "enable" })).json()) as McpCatalog;
  expect(on.servers[0]!.status).toBe("connected");
  expect(on).not.toHaveProperty("url");
  // A sign-in answers with the page to open; the name travels in the body, colons and all.
  const signIn = (await (await api(mcp, "POST", { server: "plugin:design:figma", action: "authenticate" })).json()) as McpCatalog;
  expect(signIn.url).toBe("https://auth.example/authorize?state=abc");
  await api(mcp, "POST", { server: "claude.ai Slack", action: "reconnect" });
  expect(calls).toEqual(["disable stub", "enable stub", "authenticate plugin:design:figma", "reconnect claude.ai Slack"]);

  // Only a listed server, only what the list offers, only a known action.
  expect((await api(mcp, "POST", { server: "nope", action: "disable" })).status).toBe(404);
  expect((await api(mcp, "POST", { server: "claude.ai Slack", action: "disable" })).status).toBe(409);
  expect((await api(mcp, "POST", { server: "stub", action: "authenticate" })).status).toBe(409);
  expect((await api(mcp, "POST", { server: "stub", action: "restart" })).status).toBe(400);
  expect((await api(mcp, "POST", { action: "disable" })).status).toBe(400);
  expect(calls).toHaveLength(4);

  // The engine says what the routes say.
  const place: AgentMcpPlace = { cwd: data, dataRepo: data, sessionsDir: join(root, ".specdriven", "sessions") };
  expect((await agentMcpCatalog("gemini", place)).servers.map((s) => s.name)).toEqual(servers.map((s) => s.name));
  const unknown = await changeAgentMcpServer("gemini", place, "nope", "reconnect").catch((e: unknown) => e);
  expect(unknown).toBeInstanceOf(ChatError);
  expect(unknown).toMatchObject({ status: 404, message: 'Fake has no MCP server named "nope"' });

  // The dialog shut: the provider is told, for the folder it was open on.
  expect((await api(`${mcp}/release`, "POST", {})).status).toBe(200);
  await releaseAgentMcp("gemini", { ...place, cwd: other });
  expect(calls.slice(4)).toEqual([`release ${data}`, `release ${other}`]);
});

test("a server is added from a checked draft and deleted from where the list says it is kept", async () => {
  const servers = SERVERS();
  const { admin, calls, state } = fakeAdmin(servers);
  register({ id: "gemini", capabilities: { mcpManage: CAN }, mcpAdmin: admin });
  const url = "/api/agent/agents/gemini/mcp/servers";
  const draft: McpServerDraft = { name: "weather", scope: "project", transport: "http", url: "https://weather.example/mcp", headers: { "X-Key": "abc" } };

  const added = await api(url, "POST", { server: draft });
  expect(added.status).toBe(200);
  expect(((await added.json()) as McpCatalog).servers.at(-1)).toMatchObject({ name: "weather", scope: "project" });
  expect(calls).toEqual([`add ${JSON.stringify(draft)}`]);
  // A draft that does not hold, or a name already listed, never reaches the agent.
  for (const bad of [{ ...draft, name: "weather" }, { ...draft, name: "x y" }, { ...draft, name: "w2", url: "" }, undefined]) {
    const res = await api(url, "POST", { server: bad });
    expect(res.status).toBe(400);
  }
  expect(calls).toHaveLength(1);
  // The agent's own refusal keeps its words.
  state.failWith = new AgentError(409, "MCP server w3 already exists in local config");
  const refused = await api(url, "POST", { server: { ...draft, name: "w3" } });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("MCP server w3 already exists in local config");
  state.failWith = null;

  // Delete: the name in the query, the scope from the list — never from the request.
  const removed = await api(`${url}?name=weather&scope=user`, "DELETE");
  expect(removed.status).toBe(200);
  expect(((await removed.json()) as McpCatalog).servers.map((s) => s.name)).not.toContain("weather");
  expect(calls.at(-1)).toBe("remove weather from project");
  // Not one the list does not mark, not one it does not list, not without a name.
  expect((await api(`${url}?name=${encodeURIComponent("claude.ai Slack")}`, "DELETE")).status).toBe(409);
  expect((await api(`${url}?name=nope`, "DELETE")).status).toBe(404);
  expect((await api(url, "DELETE")).status).toBe(400);
  expect(calls.filter((c) => c.startsWith("remove"))).toHaveLength(1);

  // The engine's own calls.
  const place: AgentMcpPlace = { cwd: data, dataRepo: data, sessionsDir: join(root, ".specdriven", "sessions") };
  const again = await addAgentMcpServer("gemini", place, { name: "files", scope: "local", transport: "stdio", command: "npx" });
  expect(again.servers.at(-1)!.name).toBe("files");
  const bad = await addAgentMcpServer("gemini", place, { name: "files", scope: "local", transport: "stdio", command: "npx" }).catch((e: unknown) => e);
  expect(bad).toMatchObject({ status: 400, message: 'There is already an MCP server named "files"' });
  expect((await removeAgentMcpServer("gemini", place, "files")).servers.map((s) => s.name)).not.toContain("files");
});

test("MCP servers before a session are refused for an agent that does not manage them, and never offered read-only", async () => {
  register({ id: "plain" });
  const refused = await api("/api/agent/agents/plain/mcp");
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("Fake does not manage its MCP servers before a session");
  // The capability without the hook, or the hook without the capability.
  register({ id: "flag", capabilities: { mcpManage: CAN } });
  expect((await api("/api/agent/agents/flag/mcp")).status).toBe(409);
  register({ id: "hook", mcpAdmin: fakeAdmin([]).admin });
  expect((await api("/api/agent/agents/hook/mcp", "POST", { server: "a", action: "enable" })).status).toBe(409);
  expect((await api("/api/agent/agents/hook/mcp/servers", "POST", { server: {} })).status).toBe(409);
  expect((await api("/api/agent/agents/nobody/mcp")).status).toBe(404);
  // An agent whose CLI is missing has nothing to ask.
  register({ id: "absent", available: () => false, capabilities: { mcpManage: CAN }, mcpAdmin: fakeAdmin([]).admin });
  expect((await api("/api/agent/agents/absent/mcp")).status).toBe(502);
  // Shutting a dialog that was never served is nothing.
  expect((await api("/api/agent/agents/plain/mcp/release", "POST", {})).status).toBe(200);
  // A provider's failure is the agent's.
  const { admin, state } = fakeAdmin(SERVERS());
  register({ id: "flaky", capabilities: { mcpManage: CAN }, mcpAdmin: admin });
  state.failWith = new Error("control request timed out");
  const failed = await api("/api/agent/agents/flaky/mcp", "POST", { server: "stub", action: "disable" });
  expect(failed.status).toBe(502);
  expect(((await failed.json()) as { error: string }).error).toBe('Fake could not disable "stub": control request timed out');

  // The read-only site lists none of it.
  for (const [method, pattern] of [
    ["GET", "/api/agent/agents/:agent/mcp"],
    ["POST", "/api/agent/agents/:agent/mcp"],
    ["POST", "/api/agent/agents/:agent/mcp/servers"],
    ["DELETE", "/api/agent/agents/:agent/mcp/servers"],
    ["POST", "/api/agent/agents/:agent/mcp/release"],
  ] as const) {
    expect(readOnlyAllows(method, pattern)).toBe(false);
  }
});

test("a session's MCP calls are counted into its record and shown in the dialog's usage", async () => {
  const { admin } = fakeAdmin(SERVERS());
  const fake = register({ id: "gemini", capabilities: { mcpManage: CAN }, mcpAdmin: admin });
  const res = await api("/api/agent/chat", "POST", { name: "chat", agent: "gemini", prompt: "look it up" });
  const meta = (await res.json()) as ChatSessionMeta;
  await until(() => getChatSession(meta.id), (m) => m?.status === "running");
  const { host } = fake.sessions[0]!;
  const use = (id: string, name: string) =>
    host.emit({ kind: "assistant", messageId: `m${id}`, turn: 1, blocks: [{ type: "tool_use", id, name, input: {} }], parentToolUseId: null });
  use("t1", "mcp__stub__search");
  use("t2", "mcp__stub__read");
  use("t3", "Bash");
  host.emit({ kind: "tool_result", toolUseId: "t1", content: "boom", isError: true, parentToolUseId: null });
  host.emit({ kind: "tool_result", toolUseId: "t2", content: "ok", isError: false, parentToolUseId: null });

  // While the turn runs the dialog already has the count.
  const during = (await (await api("/api/agent/agents/gemini/mcp")).json()) as McpCatalog;
  expect(during.usage.stub).toMatchObject({ calls: 2, errors: 1, sessions: 1, tools: { search: { calls: 1, errors: 1 }, read: { calls: 1, errors: 0 } } });
  expect(during.usageSince).toBe(meta.startedAt);
  expect(Object.keys(during.usage)).toEqual(["stub"]);

  // The turn over, the record keeps it — by the tool's full name.
  host.emit({ kind: "result", turn: 1, subtype: "success", isError: false, costUsd: null, durationMs: 5, numTurns: 1, denials: 0 });
  host.turnEnded();
  const recordPath = join(root, ".specdriven", "sessions", meta.id, "session.json");
  let kept: McpToolCounts = {};
  for (let i = 0; i < 400 && Object.keys(kept).length === 0; i++) {
    kept = await readFile(recordPath, "utf8").then(
      (text) => (JSON.parse(text) as { mcpUsage?: McpToolCounts }).mcpUsage ?? {},
      () => ({}),
    );
    if (Object.keys(kept).length === 0) await Bun.sleep(5);
  }
  expect(Object.keys(kept).sort()).toEqual(["mcp__stub__read", "mcp__stub__search"]);
  expect(kept.mcp__stub__search).toMatchObject({ calls: 1, errors: 1 });

  // Ended and closed, the session's count is still there — from its record.
  host.ended("done");
  await api(`/api/agent/chat/${meta.id}`, "DELETE");
  const after = (await (await api("/api/agent/agents/gemini/mcp")).json()) as McpCatalog;
  expect(after.usage.stub).toMatchObject({ calls: 2, errors: 1, sessions: 1 });
  // Another folder's dialog does not count this folder's sessions.
  const other = join(root, "other");
  await mkdir(other);
  const elsewhere = (await (await api(`/api/agent/agents/gemini/mcp?cwd=${encodeURIComponent(other)}`)).json()) as McpCatalog;
  expect(elsewhere.usage).toEqual({});
});

// --- The demo's servers (src/server/demoAgent.ts) -----------------------------------------

test("the demo's MCP servers are listed, changed, added and deleted in memory, folder by folder", async () => {
  const ctx = { cwd: "/demo/a", dataRepo: "/demo" };
  const first = await simulatedMcpAdmin.list(ctx);
  expect(first.servers.map((s) => `${s.name}:${s.status}`)).toEqual(["confluence:connected", "specdriven:connected", "linear:needs-auth", "figma:failed"]);
  expect(first.contextWindow).toBe(200_000);
  const confluence = first.servers[0]!;
  // The app's own server cannot be deleted; a secret is named, never shown.
  expect(confluence).toMatchObject({ canDelete: false, envNames: ["CONFLUENCE_TOKEN"], tools: 3, context: { loaded: 2_120, deferred: 0 } });
  expect(confluence.toolList!.map((t) => t.name)).toEqual(["confluence_search", "confluence_get_page", "confluence_list_spaces"]);
  expect(first.servers[1]).toMatchObject({ scope: "project", canDelete: true });
  // A server that is not connected has no tools to cost anything.
  expect(first.servers[3]).not.toHaveProperty("context");

  await simulatedMcpAdmin.act(ctx, "confluence", "disable");
  await simulatedMcpAdmin.act(ctx, "figma", "reconnect");
  await simulatedMcpAdmin.add(ctx, { name: "weather", scope: "local", transport: "stdio", command: "npx", env: { API_KEY: "abc" } });
  await simulatedMcpAdmin.remove(ctx, "specdriven", "project");
  const next = await simulatedMcpAdmin.list(ctx);
  expect(next.servers.map((s) => `${s.name}:${s.status}`)).toEqual(["confluence:disabled", "linear:needs-auth", "figma:connected", "weather:connected"]);
  expect(next.servers[3]).toMatchObject({ scope: "local", command: "npx", envNames: ["API_KEY"], canDelete: true });
  expect(JSON.stringify(next)).not.toContain("abc");
  // Another folder starts with the four.
  expect((await simulatedMcpAdmin.list({ cwd: "/demo/b", dataRepo: "/demo" })).servers).toHaveLength(4);
  forgetSimulatedMcp();
  expect((await simulatedMcpAdmin.list(ctx)).servers).toHaveLength(4);
});

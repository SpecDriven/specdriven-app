// The generic coding agent engine (src/server/agentChat.ts, specs/agents/
// agent-plugins.feature.md "A plugin supplies a coding agent"): driven here
// by a fake provider (tests/helpers/fakeAgent.ts), so what is pinned is the
// contract every provider gets — the AgentHost — and what the routes say
// when no plugin, or the wrong one, is there.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { endAllChatSessions, getChatEvents, getChatSession } from "../src/server/agentChat";
import type { ChatEvent, ChatSessionMeta } from "../src/server/agentTypes";
import { agents } from "../src/plugins/host/agents";
import type { Disposer } from "../src/plugins/kernel";
import { writeState } from "../src/server/state";
import { fakeProvider, type FakeProviderOptions, type FakeSession } from "./helpers/fakeAgent";

let root: string;
let data: string;
const disposers: Disposer[] = [];
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

/** Register a fake provider for the test, gone again after it. */
function register(options: FakeProviderOptions = {}) {
  const fake = fakeProvider(options);
  disposers.push(agents.register(fake.provider));
  return fake;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-agent-engine-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  data = join(root, "data");
  await writeState({ dataRepo: data }, root);
  await Bun.write(join(data, "specs", ".keep"), "");
});

afterEach(async () => {
  await endAllChatSessions();
  reloader.stop();
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

const untilStatus = (id: string, status: string) =>
  until(() => getChatSession(id), (m) => m?.status === status);

/** A session on the fake, ready to type into. */
async function ready(fake: ReturnType<typeof register>, body: Record<string, unknown> = {}): Promise<{ id: string; session: FakeSession }> {
  const res = await api("/api/agent/chat", "POST", { name: "chat", agent: fake.provider.id, ...body });
  expect(res.status).toBe(200);
  const meta = (await res.json()) as ChatSessionMeta;
  await untilStatus(meta.id, "idle");
  return { id: meta.id, session: fake.sessions.at(-1)! };
}

test("a plugin's provider drives a session from start to end", async () => {
  const fake = register({ id: "gemini", label: "Gemini", rank: 15, defaultPermissionMode: "plan" });
  const state = (await (await api("/api/state")).json()) as { agents: { id: string; available: boolean }[]; canEstimate: boolean };
  expect(state.agents.map((a) => a.id)).toEqual(["gemini"]);
  expect(state.agents.find((a) => a.id === "gemini")).toMatchObject({ available: true, plugin: "core" });
  expect(state.canEstimate).toBe(false);

  const { id, session } = await ready(fake);
  expect(session.opts).toMatchObject({ sessionId: id, name: "chat", cwd: data, dataRepo: data, permissionMode: "plan" });
  expect(getChatSession(id)).toMatchObject({ agent: "gemini", model: "fake-1", permissionMode: "plan" });

  const sent = await api(`/api/agent/chat/${id}/message`, "POST", { text: "hello" });
  expect(sent.status).toBe(200);
  expect(session.sent).toEqual(["hello"]);
  expect(getChatSession(id)!.status).toBe("running");
  session.host.emit({ kind: "assistant", messageId: "m1", turn: session.host.turn(), blocks: [{ type: "text", text: "Hi." }], parentToolUseId: null });
  session.host.emit({ kind: "result", turn: 1, subtype: "success", isError: false, costUsd: null, durationMs: 5, numTurns: 1, denials: 0 });
  session.host.turnEnded();
  expect(getChatSession(id)!.status).toBe("idle");
  expect(getChatEvents(id).map((e) => e.kind)).toEqual(["status", "status", "user", "status", "assistant", "result", "status"]);
  expect(getChatEvents(id).find((e) => e.kind === "assistant")).toMatchObject({ turn: 1 });

  // The record names the provider.
  const record = JSON.parse(await readFile(join(root, ".specdriven", "sessions", id, "session.json"), "utf8"));
  expect(record).toMatchObject({ agent: "gemini", permissionMode: "plan" });

  session.host.ended("Gemini exited.");
  expect(getChatSession(id)!.status).toBe("ended");
  expect(session.closed).toBe(true);
  expect((await api(`/api/agent/chat/${id}/message`, "POST", { text: "x" })).status).toBe(409);
});

test("the pane's permission card answers the provider, and a withdrawn or ended question is denied", async () => {
  const fake = register({ id: "gemini" });
  const { id, session } = await ready(fake);
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  const asked = session.host.requestPermission({
    toolName: "Bash",
    input: { command: "ls" },
    suggestions: [{ type: "addRules" }],
    title: "Gemini wants to run a command",
  });
  await untilStatus(id, "awaiting_input");
  const request = getChatEvents(id).find((e) => e.kind === "permission_request") as ChatEvent & { kind: "permission_request" };
  expect(request).toMatchObject({ toolName: "Bash", title: "Gemini wants to run a command" });
  await api(`/api/agent/chat/${id}/permission`, "POST", { requestId: request.requestId, behavior: "allow", remember: true });
  expect(await asked).toEqual({ decision: { behavior: "allow", updatedInput: { command: "ls" }, remember: true }, via: "user" });
  expect(getChatSession(id)!.status).toBe("running");

  // "Allow always" without a rule to keep is a plain allow.
  const plain = session.host.requestPermission({ toolName: "Write", input: { file_path: "x" }, suggestions: [] });
  await untilStatus(id, "awaiting_input");
  const r2 = (getChatEvents(id).filter((e) => e.kind === "permission_request").at(-1) as { requestId: string }).requestId;
  await api(`/api/agent/chat/${id}/permission`, "POST", { requestId: r2, behavior: "allow", remember: true });
  expect((await plain).decision).toMatchObject({ behavior: "allow", remember: false });

  // The provider withdraws its own question.
  const withdrawn = new AbortController();
  const gone = session.host.requestPermission({ toolName: "Bash", input: {}, suggestions: [], signal: withdrawn.signal });
  await untilStatus(id, "awaiting_input");
  withdrawn.abort();
  expect(await gone).toMatchObject({ decision: { behavior: "deny", message: "Cancelled" }, via: "interrupt" });

  // A turn that ends with a card open closes it; a session that ends denies it.
  const stale = session.host.requestPermission({ toolName: "Bash", input: {}, suggestions: [] });
  await untilStatus(id, "awaiting_input");
  session.host.turnEnded();
  expect(await stale).toMatchObject({ decision: { behavior: "deny", message: "The turn ended" }, via: "interrupt" });
  expect(getChatSession(id)!.status).toBe("idle");
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "again" });
  const last = session.host.requestPermission({ toolName: "Bash", input: {}, suggestions: [] });
  await untilStatus(id, "awaiting_input");
  await api(`/api/agent/chat/${id}`, "DELETE");
  expect(await last).toMatchObject({ decision: { behavior: "deny" }, via: "ended" });
  expect(await session.host.requestPermission({ toolName: "Bash", input: {}, suggestions: [] })).toMatchObject({ via: "ended" });
});

test("Stop and the mode go to the provider, and are refused where it declares neither", async () => {
  const fake = register({ id: "gemini" });
  const { id, session } = await ready(fake);
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  expect((await api(`/api/agent/chat/${id}/interrupt`, "POST")).status).toBe(200);
  expect(session.interrupts).toBe(1);
  expect(getChatEvents(id).some((e) => e.kind === "note" && e.code === "interrupted")).toBe(true);
  const mode = await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "acceptEdits" });
  expect(mode.status).toBe(200);
  expect(session.modes).toEqual(["acceptEdits"]);
  expect(getChatSession(id)!.permissionMode).toBe("acceptEdits");

  // A provider with no permission gate and no Stop.
  const bare = register({
    id: "bare",
    label: "Bare",
    defaultPermissionMode: "bypassPermissions",
    capabilities: { permissionModes: [], canInterrupt: false },
  });
  const started = await ready(bare, { permissionMode: "plan" });
  // The mode asked for is ignored: the provider's default stands.
  expect(getChatSession(started.id)!.permissionMode).toBe("bypassPermissions");
  expect(started.session.opts.permissionMode).toBe("bypassPermissions");
  const noModes = await api(`/api/agent/chat/${started.id}/mode`, "PUT", { permissionMode: "plan" });
  expect(noModes.status).toBe(409);
  expect((await noModes.json()).error).toContain("Bare has no permission modes");
  await api(`/api/agent/chat/${started.id}/message`, "POST", { text: "go" });
  const noStop = await api(`/api/agent/chat/${started.id}/interrupt`, "POST");
  expect(noStop.status).toBe(409);
  expect((await noStop.json()).error).toContain("Bare cannot be interrupted");

  // A provider that offers some modes refuses the others.
  const few = register({ id: "few", label: "Few", capabilities: { permissionModes: ["default", "plan"] } });
  const some = await ready(few);
  const outside = await api(`/api/agent/chat/${some.id}/mode`, "PUT", { permissionMode: "auto" });
  expect(outside.status).toBe(400);
  expect((await outside.json()).error).toContain("Few offers only default, plan");
});

test("a turn the provider refuses is noted and the composer freed; a provider that dies ends the session", async () => {
  const fake = register({ id: "gemini", label: "Gemini", sendError: new Error("Gemini refused the turn: busy") });
  const { id, session } = await ready(fake);
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "go" });
  await untilStatus(id, "idle");
  expect(getChatEvents(id).find((e) => e.kind === "note" && e.level === "error")).toMatchObject({
    code: "api",
    text: "Gemini refused the turn: busy",
  });
  session.host.failed("Gemini exited with code 3.");
  expect(getChatSession(id)).toMatchObject({ status: "error" });
  expect(getChatEvents(id).at(-2)).toMatchObject({ kind: "note", level: "error", text: "Gemini exited with code 3." });
  // Anything the provider says after its end is dropped.
  session.host.emit({ kind: "text_delta", messageId: "m", index: 0, text: "late" });
  expect(getChatEvents(id).some((e) => e.kind === "text_delta")).toBe(false);
});

test("the provider's facts reach the pane through ready and update, and quiet keeps them off the log", async () => {
  const fake = register({ id: "gemini", readyAtStart: false });
  const res = await api("/api/agent/chat", "POST", { name: "chat", agent: "gemini", prompt: "implement it" });
  const { id } = (await res.json()) as ChatSessionMeta;
  const session = fake.sessions.at(-1)!;
  // The prompt is turn 1, echoed before the provider has said a word.
  expect(session.opts.prompt).toBe("implement it");
  expect(getChatSession(id)!.status).toBe("starting");
  expect(getChatEvents(id).map((e) => e.kind)).toEqual(["status", "user"]);
  expect((await api(`/api/agent/chat/${id}/mode`, "PUT", { permissionMode: "plan" })).status).toBe(409);
  session.host.ready({ agentSessionId: "g-1", model: "gemini-2", tools: ["Read"], commands: [{ name: "help", description: "", argumentHint: "" }] });
  expect(getChatSession(id)).toMatchObject({ status: "running", agentSessionId: "g-1", model: "gemini-2" });
  expect(getChatEvents(id).at(-1)).toMatchObject({ kind: "status", status: "running", tools: ["Read"], commands: [{ name: "help" }] });
  expect(((await (await api(`/api/agent/chat/${id}`)).json()) as { commands: unknown[] }).commands).toHaveLength(1);
  session.host.update({ model: "gemini-3" }, { quiet: true });
  expect(getChatSession(id)!.model).toBe("gemini-3");
  expect(getChatEvents(id).at(-1)).toMatchObject({ kind: "status", status: "running", tools: ["Read"] });
  session.host.update({ account: { billing: "api", label: "API billing", detail: "" } });
  expect(getChatEvents(id).at(-1)).toMatchObject({ kind: "status", account: { billing: "api" } });
  // turnStarted is for turns the agent begins by itself; idempotent.
  session.host.turnEnded();
  expect(getChatSession(id)!.status).toBe("idle");
  session.host.turnStarted();
  session.host.turnStarted();
  expect(getChatSession(id)!.status).toBe("running");
  expect(session.host.busy()).toBe(true);
  expect(session.host.permissionMode()).toBe("default");
});

test("no plugin, the wrong plugin, or a missing CLI is a clear refusal, and the default is the first by rank", async () => {
  const none = await api("/api/agent/chat", "POST", { name: "chat" });
  expect(none.status).toBe(502);
  expect((await none.json()).error).toContain("No coding agent is installed");
  const unknown = await api("/api/agent/chat", "POST", { name: "chat", agent: "gemini" });
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).error).toContain("agent must be (no agent plugin is installed)");

  const slow = register({ id: "zed", rank: 40 });
  const fast = register({ id: "gemini", rank: 15, available: () => false, missingMessage: "Gemini CLI not found — install the `gemini` command" });
  const missing = await api("/api/agent/chat", "POST", { name: "chat", agent: "gemini" });
  expect(missing.status).toBe(502);
  expect((await missing.json()).error).toBe("Gemini CLI not found — install the `gemini` command");
  // No agent named: the first one that can run.
  const picked = await api("/api/agent/chat", "POST", { name: "chat" });
  expect(picked.status).toBe(200);
  expect(((await picked.json()) as ChatSessionMeta).agent).toBe("zed");
  expect(slow.sessions).toHaveLength(1);
  expect(fast.sessions).toHaveLength(0);

  const broken = register({ id: "broken", label: "Broken", rank: 1, startError: new Error("spawn broken ENOENT") });
  const failed = await api("/api/agent/chat", "POST", { name: "chat", agent: "broken" });
  expect(failed.status).toBe(502);
  expect((await failed.json()).error).toBe("Could not start Broken: spawn broken ENOENT");
  expect(broken.sessions).toHaveLength(0);
  const list = (await (await api("/api/agent/chat")).json()) as { sessions: ChatSessionMeta[] };
  expect(list.sessions.map((s) => s.agent)).toEqual(["zed"]);
});

test("switching a plugin off ends the sessions its provider was driving", async () => {
  const fake = register({ id: "gemini", label: "Gemini" });
  const { id, session } = await ready(fake);
  const other = register({ id: "zed" });
  const kept = await ready(other);
  await disposers.shift()!();
  await untilStatus(id, "ended");
  expect(session.closed).toBe(true);
  expect(getChatEvents(id).find((e) => e.kind === "note" && e.code === "ended")).toMatchObject({
    text: "The Gemini plugin was switched off.",
  });
  expect(getChatSession(kept.id)!.status).toBe("idle");
});

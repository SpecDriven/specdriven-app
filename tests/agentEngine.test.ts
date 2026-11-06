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
import { createConfluenceFileBackend, saveConfluenceToken, setConfluenceTokenBackend } from "../src/server/confluenceTokens";
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

test("a session starts on the model and effort the pane picked, and refuses ones that are none", async () => {
  const fake = register({ id: "gemini", capabilities: { effort: true } });
  const { id, session } = await ready(fake, { model: "opus", effort: "high" });
  expect(session.opts).toMatchObject({ model: "opus", effort: "high" });
  // The agent's own word on the model (its init) replaces the alias.
  expect(getChatSession(id)).toMatchObject({ model: "fake-1", effort: "high" });
  const record = JSON.parse(await readFile(join(root, ".specdriven", "sessions", id, "session.json"), "utf8"));
  expect(record.effort).toBe("high");

  const badModel = await api("/api/agent/chat", "POST", { name: "x", agent: "gemini", model: "two words" });
  expect(badModel.status).toBe(400);
  expect((await badModel.json()).error).toContain("model must be");
  const badEffort = await api("/api/agent/chat", "POST", { name: "x", agent: "gemini", effort: "extreme" });
  expect(badEffort.status).toBe(400);
  expect((await badEffort.json()).error).toContain("effort must be one of low, medium, high, xhigh, max");

  // An agent with no effort setting is never handed one.
  const plain = register({ id: "plain" });
  const started = await ready(plain, { effort: "max" });
  expect(started.session.opts.effort).toBeUndefined();
  expect(getChatSession(started.id)!.effort).toBeUndefined();
});

test("the pane switches a running session's model and effort, and the pick becomes the agent's default", async () => {
  const defaults: object[] = [];
  const fake = register({
    id: "gemini",
    label: "Gemini",
    capabilities: { effort: true, canChangeModelMidSession: true },
    setDefaults: async (patch) => {
      defaults.push(patch);
    },
  });
  const { id, session } = await ready(fake);
  const model = await api(`/api/agent/chat/${id}/model`, "PUT", { model: "sonnet" });
  expect(model.status).toBe(200);
  expect((await model.json()).meta.model).toBe("sonnet");
  const effort = await api(`/api/agent/chat/${id}/effort`, "PUT", { effort: "xhigh" });
  expect(effort.status).toBe(200);
  expect(session.models).toEqual(["sonnet"]);
  expect(session.efforts).toEqual(["xhigh"]);
  expect(getChatSession(id)).toMatchObject({ model: "sonnet", effort: "xhigh" });
  expect(getChatEvents(id).filter((e) => e.kind === "model" || e.kind === "effort")).toMatchObject([
    { kind: "model", model: "sonnet" },
    { kind: "effort", effort: "xhigh" },
  ]);
  // null is the agent's own default again.
  await api(`/api/agent/chat/${id}/effort`, "PUT", { effort: null });
  expect(getChatSession(id)!.effort).toBeUndefined();
  expect(defaults).toEqual([{ model: "sonnet" }, { effort: "xhigh" }, { effort: null }]);
  expect((await api(`/api/agent/chat/${id}/effort`, "PUT", { effort: "huge" })).status).toBe(400);
  expect((await api(`/api/agent/chat/${id}/model`, "PUT", { model: "a b" })).status).toBe(400);

  // An agent that declares neither refuses both.
  const plain = register({ id: "plain", label: "Plain" });
  const other = await ready(plain);
  const noModel = await api(`/api/agent/chat/${other.id}/model`, "PUT", { model: "sonnet" });
  expect(noModel.status).toBe(409);
  expect((await noModel.json()).error).toContain("Plain cannot switch models in a running session");
  const noEffort = await api(`/api/agent/chat/${other.id}/effort`, "PUT", { effort: "low" });
  expect(noEffort.status).toBe(409);
  expect((await noEffort.json()).error).toContain("Plain has no effort setting");
});

test("an agent's choices and defaults are listed for the pane and kept through the provider", async () => {
  let current: { model: string | null; effort: "low" | "high" | null } = { model: "opus", effort: null };
  const seen: (string | null)[] = [];
  register({
    id: "gemini",
    capabilities: { effort: true },
    choices: async ({ dataRepo }) => {
      seen.push(dataRepo);
      return { models: [{ value: "opus", displayName: "Opus", efforts: ["low", "high"] }], ...current };
    },
    setDefaults: async (patch) => {
      current = { ...current, ...(patch as typeof current) };
    },
  });
  const listed = await api("/api/agent/agents/gemini/choices");
  expect(listed.status).toBe(200);
  expect((await listed.json()).choices).toEqual({
    models: [{ value: "opus", displayName: "Opus", efforts: ["low", "high"] }],
    model: "opus",
    effort: null,
  });
  expect(seen[0]).toBe(data);
  const saved = await api("/api/agent/agents/gemini/defaults", "PUT", { model: null, effort: "high" });
  expect(saved.status).toBe(200);
  expect((await saved.json()).choices).toMatchObject({ model: null, effort: "high" });
  expect((await api("/api/agent/agents/gemini/defaults", "PUT", {})).status).toBe(400);
  expect((await api("/api/agent/agents/gemini/defaults", "PUT", { effort: "huge" })).status).toBe(400);

  // An agent with no choices answers null; it keeps no defaults either.
  register({ id: "plain" });
  expect((await (await api("/api/agent/agents/plain/choices")).json()).choices).toBeNull();
  expect((await api("/api/agent/agents/plain/defaults", "PUT", { model: "opus" })).status).toBe(409);
  expect((await api("/api/agent/agents/nobody/choices")).status).toBe(404);
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

test("a provider's sign-in change refreshes its live sessions, and a failed refresh is a note", async () => {
  // Signed in to Claude while a session ran: without the refresh, the
  // session kept the account it started with until the app was restarted.
  const fake = register({ id: "claude", label: "Claude" });
  const first = await ready(fake);
  const second = await ready(fake);
  const other = register({ id: "zed" });
  const untouched = await ready(other);
  const ended = await ready(fake);
  ended.session.host.ended("Claude exited.");
  await untilStatus(ended.id, "ended");

  agents.changed("claude");
  await until(() => [first.session.refreshes, second.session.refreshes], (n) => n.every((c) => c === 1));
  expect(untouched.session.refreshes).toBe(0);
  expect(ended.session.refreshes).toBe(0);
  expect(getChatSession(first.id)!.status).toBe("idle");

  const failing = register({ id: "gemini", label: "Gemini", refreshError: new Error("keychain locked") });
  const broken = await ready(failing);
  agents.changed("gemini");
  const note = await until(
    () => getChatEvents(broken.id).find((e) => e.kind === "note" && e.level === "error"),
    (e) => e !== undefined,
  );
  expect(note).toMatchObject({ text: "Could not pick up the new Gemini sign-in: keychain locked — start a new session." });
  expect(getChatSession(broken.id)!.status).toBe("idle");

  // A provider whose sessions cannot refresh leaves them as they are.
  const old = register({ id: "pi", noRefresh: true });
  const kept = await ready(old);
  agents.changed("pi");
  await Bun.sleep(10);
  expect(getChatEvents(kept.id).some((e) => e.kind === "note")).toBe(false);
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

// A 1×1 PNG, and a byte-for-byte check of what came back.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("images pasted into a message reach the provider, are kept in the session's folder and served back", async () => {
  const fake = register({ id: "gemini", label: "Gemini", capabilities: { images: true } });
  const { id, session } = await ready(fake);

  const sent = await api(`/api/agent/chat/${id}/message`, "POST", {
    text: "what is this?",
    images: [{ mediaType: "image/png", data: PNG_1X1, name: "shot.png" }],
  });
  expect(sent.status).toBe(200);
  expect(session.sent).toEqual(["what is this?"]);
  const [given] = session.sentImages[0]!;
  expect(given).toMatchObject({ mediaType: "image/png", data: PNG_1X1 });
  // The copy lives in the session's folder, beside its record.
  expect(given!.path.startsWith(join(root, ".specdriven", "sessions", id, "images"))).toBe(true);
  expect(Buffer.from(await readFile(given!.path)).toString("base64")).toBe(PNG_1X1);

  // The transcript shows where to fetch it, not its bytes.
  const user = getChatEvents(id).find((e) => e.kind === "user") as Extract<ChatEvent, { kind: "user" }>;
  expect(user.images).toHaveLength(1);
  expect(user.images![0]).toMatchObject({ mediaType: "image/png", name: "shot.png" });
  expect(JSON.stringify(user)).not.toContain(PNG_1X1);
  const served = await api(user.images![0]!.url);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(PNG_1X1);
  expect((await api(`/api/agent/chat/${id}/images/nope`)).status).toBe(404);

  // Images alone are a message.
  session.host.turnEnded();
  const alone = await api(`/api/agent/chat/${id}/message`, "POST", { images: [{ mediaType: "image/png", data: PNG_1X1 }] });
  expect(alone.status).toBe(200);
  expect(session.sent[1]).toBe("");
  expect(session.sentImages[1]).toHaveLength(1);

  // A text-only message hands the provider no images at all.
  session.host.turnEnded();
  await api(`/api/agent/chat/${id}/message`, "POST", { text: "thanks" });
  expect(session.sentImages[2]).toBeUndefined();
});

test("a session started with pasted images hands them to the provider with its first turn", async () => {
  const fake = register({ id: "gemini", label: "Gemini", capabilities: { images: true } });
  const res = await api("/api/agent/chat", "POST", { agent: "gemini", images: [{ mediaType: "image/png", data: PNG_1X1 }] });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as ChatSessionMeta;
  // The first turn is under way: the session runs rather than idles.
  await untilStatus(id, "running");
  const session = fake.sessions.at(-1)!;
  expect(session.opts.prompt).toBe("");
  expect(session.opts.images).toHaveLength(1);
  expect(session.opts.images![0]).toMatchObject({ mediaType: "image/png", data: PNG_1X1 });
  const user = getChatEvents(id).find((e) => e.kind === "user") as Extract<ChatEvent, { kind: "user" }>;
  expect(user).toMatchObject({ text: "" });
  expect(user.images).toHaveLength(1);
});

test("pasted images are refused for an agent that reads none, and when they are not images, too many or too big", async () => {
  const blind = register({ id: "pi", label: "Pi" });
  const { id: piId, session: piSession } = await ready(blind);
  const refused = await api(`/api/agent/chat/${piId}/message`, "POST", {
    text: "look",
    images: [{ mediaType: "image/png", data: PNG_1X1 }],
  });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("Pi cannot read images — send text only");
  expect(piSession.sent).toEqual([]);
  // Nor can a session on it start with one.
  const start = await api("/api/agent/chat", "POST", { agent: "pi", images: [{ mediaType: "image/png", data: PNG_1X1 }] });
  expect(start.status).toBe(409);

  const fake = register({ id: "gemini", label: "Gemini", capabilities: { images: true } });
  const { id } = await ready(fake);
  const post = (images: unknown) => api(`/api/agent/chat/${id}/message`, "POST", { text: "x", images });
  const error = async (res: Response) => [res.status, ((await res.json()) as { error: string }).error];
  expect(await error(await post([{ mediaType: "image/tiff", data: PNG_1X1 }]))).toEqual([
    400,
    "Image 1 must be a PNG, JPEG, GIF or WebP image",
  ]);
  expect(await error(await post([{ mediaType: "image/png", data: "not base64!" }]))).toEqual([400, "Image 1 must be base64 data"]);
  expect(await error(await post(Array.from({ length: 11 }, () => ({ mediaType: "image/png", data: PNG_1X1 }))))).toEqual([
    400,
    "At most 10 images go with one message",
  ]);
  const big = Buffer.alloc(3_750_001).toString("base64");
  expect(await error(await post([{ mediaType: "image/jpeg", data: big }]))).toEqual([
    413,
    "Image 1 is 3.8 MB; one image may be at most 3.75 MB",
  ]);
  expect(await error(await post("a picture"))).toEqual([400, "images must be a list"]);
  // None of it started a turn.
  expect(getChatSession(id)!.status).toBe("idle");
});

test("a saved wiki token hands the provider the Confluence MCP server; none, nothing", async () => {
  // The token store is read through the home this test owns (specs/external-links/confluence-wiki.feature.md
  // "An agent session can read the wiki").
  setConfluenceTokenBackend(createConfluenceFileBackend(join(root, "home", "confluence-tokens.json")));
  try {
    const fake = register();
    const bare = await ready(fake);
    expect(bare.session.opts.mcpServers).toBeUndefined();

    await saveConfluenceToken({ base: "https://wiki.acme.com", token: "pat", user: "me" });
    const withWiki = await ready(fake);
    expect(withWiki.session.opts.mcpServers).toHaveLength(1);
    expect(withWiki.session.opts.mcpServers![0]).toMatchObject({
      name: "specdriven-confluence",
      command: process.execPath,
      env: { SPECDRIVEN_CONFLUENCE_TOKENS_FILE: join(root, "home", "confluence-tokens.json") },
    });
  } finally {
    setConfluenceTokenBackend(createConfluenceFileBackend());
  }
});

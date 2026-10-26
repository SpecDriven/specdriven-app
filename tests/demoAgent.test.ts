// The demo's simulated coding agent (src/server/demoAgent.ts, roadmap spec
// roadmap/demo.md "Demo App"): with DEMO_MODE on, a code gen session
// starts, plays a scripted Claude Code transcript through the ordinary pane
// machinery, raises a real permission card, and closes with a result — while
// spawning nothing and leaving the dataset byte-for-byte as it was.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setClaudeAvailability,
  setDesktopAvailability,
  setPiAvailability,
} from "../src/server/agent";
import {
  answerPermission,
  endAllChatSessions,
  getChatEvents,
  getChatSession,
  interruptChat,
} from "../src/server/agentChat";
import type { ChatEvent } from "../src/server/agentChat";
import { registerCoreAgents } from "../src/server/agentProviders";
import { InputQueue } from "../src/server/agents/claude";
import { applyStartupState, handleApi, reloader, syncedOnStart } from "../src/server/api";
import { setupDemo } from "../src/server/demo";
import { SIMULATED_MODEL, readBrief, setSimulationPace, simulatedQuery } from "../src/server/demoAgent";
import { setFolderChooser } from "../src/server/folderChooser";
import { setGitEngine } from "../src/server/git";
import { readState } from "../src/server/state";

let root: string;
let source: string;
let realChooser: ReturnType<typeof setFolderChooser>;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const realDemo = process.env.DEMO_MODE;
const realDemoData = process.env.DEMO_DATA_DIR;

const SPEC = "specs/billing/collect-premium.feature.md";
const SPEC_TEXT = "# Collect Premium\n\n## Failed autopay @v1 [published]\n\n- **Given** a charge\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-demoagent-"));
  source = await mkdtemp(join(tmpdir(), "specdriven-demoagent-src-"));
  await Bun.write(join(source, SPEC), SPEC_TEXT);
  process.env.SPECDRIVEN_ROOT = root;
  process.env.DEMO_MODE = "1";
  process.env.DEMO_DATA_DIR = source;
  realChooser = setFolderChooser(null);
  await setupDemo();
  await applyStartupState();
  // The script's delays are for a viewer; a test runs it in one tick.
  setSimulationPace(0);
});

afterEach(async () => {
  await endAllChatSessions();
  await syncedOnStart();
  reloader.stop();
  setGitEngine(null);
  setFolderChooser(realChooser);
  setSimulationPace(1);
  registerCoreAgents();
  setClaudeAvailability(null);
  setPiAvailability(null);
  setDesktopAvailability(null);
  await rm(root, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
    ["DEMO_MODE", realDemo],
    ["DEMO_DATA_DIR", realDemoData],
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

/**
 * Every file under dir (relative path → content), minus `.specdriven/` —
 * the Automerge store there is written by the app's own importer on a timer
 * (src/server/automerge), which has nothing to do with the session.
 */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = join(entry.parentPath.slice(dir.length + 1) || "", entry.name);
    if (rel.startsWith(".specdriven/")) continue;
    out.set(rel, await readFile(join(entry.parentPath, entry.name), "utf8"));
  }
  return out;
}

/** Start the session the sidebar's "Start session" button would. */
async function startSession(name = "implement autopay grace"): Promise<string> {
  const res = await api("/api/agent/session", "POST", {
    name,
    target: "pane",
    files: [{ fileName: SPEC }],
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** Poll the log until `ok`, so a test never depends on the script's timing. */
async function until(id: string, ok: (events: ChatEvent[]) => boolean): Promise<ChatEvent[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const events = getChatEvents(id);
    if (ok(events)) return events;
    if (Date.now() > deadline) {
      throw new Error(`timed out; kinds so far: ${events.map((e) => e.kind).join(",")}`);
    }
    await Bun.sleep(5);
  }
}

const kinds = (events: ChatEvent[]) => events.map((e) => e.kind);

const pending = (events: ChatEvent[]) =>
  events.find((e) => e.kind === "permission_request") as
    | (ChatEvent & { kind: "permission_request" })
    | undefined;

test("readBrief pulls the name and the specs out of the generated prompt", () => {
  const prompt = [
    "SpecDriven code gen session: quote motorcycles",
    "",
    "Implement the following specifications.",
    "",
    "## Spec: specs/policy/quote.feature.md",
    "",
    "body",
    "",
    "## Spec: specs/billing/collect.feature.md (selected scenarios only)",
  ].join("\n");
  expect(readBrief(prompt)).toEqual({
    name: "quote motorcycles",
    specs: ["specs/policy/quote.feature.md", "specs/billing/collect.feature.md"],
  });
  // A message typed into the composer matches neither pattern.
  expect(readBrief("what does this do?")).toEqual({ name: "this change", specs: [] });
});

// The pane's typewriter runs on partial messages; the script has to produce
// them, and in the order Claude Code does — message_start, deltas, then the
// settled assistant message that replaces them.
test("the script streams its text before settling it", async () => {
  const input = new InputQueue<SDKUserMessage>();
  input.push({
    type: "user",
    message: { role: "user", content: "SpecDriven code gen session: x\n\n## Spec: a/b.feature.md\n" },
    parent_tool_use_id: null,
  } as SDKUserMessage);
  const query = await simulatedQuery({
    prompt: input,
    options: {
      cwd: "/work",
      abortController: new AbortController(),
      canUseTool: async () => ({ behavior: "deny", message: "no" }),
    } as unknown as Options,
  });
  const seen: string[] = [];
  for await (const msg of query) {
    seen.push(msg.type === "stream_event" ? `stream:${msg.event.type}` : msg.type);
    if (msg.type === "result") break;
  }
  expect(seen[0]).toBe("system");
  expect(seen[1]).toBe("stream:message_start");
  expect(seen[2]).toBe("stream:content_block_delta");
  expect(seen.filter((s) => s === "stream:content_block_delta").length).toBeGreaterThan(3);
  expect(seen.indexOf("assistant")).toBeGreaterThan(seen.indexOf("stream:content_block_delta"));
  expect(seen.at(-1)).toBe("result");
});

test("a demo session starts and plays a scripted Claude Code turn", async () => {
  const id = await startSession();
  const meta = getChatSession(id)!;
  expect(meta.agent).toBe("claude");
  // Nothing was spawned: the model is the simulation's, not a real one.
  await until(id, (e) => getChatSession(id)?.model === SIMULATED_MODEL);

  const events = await until(id, (e) => e.some((x) => x.kind === "permission_request"));
  // The pane's own shapes, so the transcript reducer needs no special case.
  // No text_delta here: emit() drops a message's deltas once the settled
  // assistant message replaces them, so the replay log never carries them —
  // the streaming itself is asserted below, at the simulator.
  expect(kinds(events)).toContain("note");
  expect(kinds(events)).toContain("assistant");
  expect(kinds(events)).toContain("tool_result");

  const init = events.find((e) => e.kind === "note")!;
  expect(init).toMatchObject({ code: "init" });
  expect((init as { text: string }).text).toContain(SIMULATED_MODEL);

  // The narration names the spec the caller picked, and a tool row read it.
  const tools = events.flatMap((e) =>
    e.kind === "assistant" ? e.blocks.filter((b) => b.type === "tool_use") : [],
  );
  expect(tools.map((t) => t.name)).toEqual(["Read", "Grep"]);
  expect(tools[0]!.input).toMatchObject({ file_path: SPEC });

  // Parked on the permission card until the visitor answers.
  expect(getChatSession(id)!.status).toBe("awaiting_input");
  expect(pending(events)!.toolName).toBe("Write");
});

test("allowing the write finishes the turn and returns the session to idle", async () => {
  const id = await startSession();
  const events = await until(id, (e) => e.some((x) => x.kind === "permission_request"));
  answerPermission(id, { requestId: pending(events)!.requestId, behavior: "allow" });

  const done = await until(id, (e) => e.some((x) => x.kind === "result"));
  const result = done.find((e) => e.kind === "result") as ChatEvent & { kind: "result" };
  expect(result.isError).toBe(false);
  expect(result.denials).toBe(0);
  // The Write row only appears once it was allowed.
  const written = done.flatMap((e) =>
    e.kind === "assistant" ? e.blocks.filter((b) => b.type === "tool_use" && b.name === "Write") : [],
  );
  expect(written).toHaveLength(1);
  await until(id, () => getChatSession(id)!.status === "idle");
});

test("denying the write still closes the turn, and says so", async () => {
  const id = await startSession();
  const events = await until(id, (e) => e.some((x) => x.kind === "permission_request"));
  answerPermission(id, { requestId: pending(events)!.requestId, behavior: "deny" });

  const done = await until(id, (e) => e.some((x) => x.kind === "result"));
  const result = done.find((e) => e.kind === "result") as ChatEvent & { kind: "result" };
  expect(result.denials).toBe(1);
  // No Write row: the tool never "ran".
  expect(
    done.flatMap((e) =>
      e.kind === "assistant" ? e.blocks.filter((b) => b.type === "tool_use" && b.name === "Write") : [],
    ),
  ).toEqual([]);
  await until(id, () => getChatSession(id)!.status === "idle");
});

test("a follow-up message gets a scripted reply, and the session stays up", async () => {
  const id = await startSession();
  const events = await until(id, (e) => e.some((x) => x.kind === "permission_request"));
  answerPermission(id, { requestId: pending(events)!.requestId, behavior: "allow" });
  await until(id, () => getChatSession(id)!.status === "idle");

  const res = await api(`/api/agent/chat/${id}/message`, "POST", { text: "why that file?" });
  expect(res.status).toBe(200);
  const after = await until(id, (e) => e.filter((x) => x.kind === "result").length === 2);
  const reply = after.filter((e) => e.kind === "assistant").at(-1)!;
  expect(JSON.stringify(reply)).toContain("simulated session");
  expect(getChatSession(id)!.status).toBe("idle");
});

// A chat opened from the pane's own empty state carries no prompt and no
// specs; narrating a spec read would name a file nobody picked.
test("a chat started with no specs gets the short reply, not the spec script", async () => {
  const res = await api("/api/agent/chat", "POST", { name: "ad hoc" });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  await until(id, () => getChatSession(id)!.status === "idle");
  expect(await api(`/api/agent/chat/${id}/message`, "POST", { text: "what is this?" })).toMatchObject(
    { status: 200 },
  );
  const events = await until(id, (e) => e.some((x) => x.kind === "result"));
  expect(kinds(events)).not.toContain("permission_request");
  expect(
    events.flatMap((e) => (e.kind === "assistant" ? e.blocks.filter((b) => b.type === "tool_use") : [])),
  ).toEqual([]);
  expect(JSON.stringify(events)).toContain("simulated session");
});

test("Stop mid-turn returns the session to idle without ending it", async () => {
  const id = await startSession();
  await until(id, (e) => e.some((x) => x.kind === "permission_request"));
  await interruptChat(id);
  await until(id, () => getChatSession(id)!.status === "idle");
  expect(getChatSession(id)!.status).toBe("idle");
});

test("the whole session writes no file into the demo dataset", async () => {
  const dir = (await readState(root)).dataRepo!;
  const before = await snapshot(dir);
  const id = await startSession();
  const events = await until(id, (e) => e.some((x) => x.kind === "permission_request"));
  answerPermission(id, { requestId: pending(events)!.requestId, behavior: "allow" });
  await until(id, (e) => e.some((x) => x.kind === "result"));
  expect(await snapshot(dir)).toEqual(before);
});

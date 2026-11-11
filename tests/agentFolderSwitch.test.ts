// Automates specs/agents/agent-pane.feature.md "Switching folders closes
// the other folder's sessions": a session belongs to the folder open when it
// started, and a switch to another folder — a specifications folder or a
// code repository — ends and forgets it before the switch answers, so the
// pane is left with the new folder's sessions alone.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  closeOtherProjects,
  createChatSession,
  endAllChatSessions,
  endChatSession,
  listChatSessions,
  subscribeChat,
} from "../src/server/agentChat";
import type { ChatSessionMeta } from "../src/server/agentTypes";
import { agents } from "../src/plugins/host/agents";
import { sessionsDirectory } from "../src/server/agent";
import type { Disposer } from "../src/plugins/kernel";
import { writeState } from "../src/server/state";
import { agentChat, agentChatState, closedSessionsNote } from "../src/frontend/agentChat";
import { fakeProvider, type FakeSession } from "./helpers/fakeAgent";

let root: string;
let data: string;
let otherData: string;
let code: string;
let sessions: FakeSession[];
const disposers: Disposer[] = [];
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
  DEMO_MODE: process.env.DEMO_MODE,
  SPECDRIVEN_HOSTED: process.env.SPECDRIVEN_HOSTED,
};
const realFetch = globalThis.fetch;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-folder-switch-")));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  delete process.env.DEMO_MODE;
  delete process.env.SPECDRIVEN_HOSTED;
  data = join(root, "data");
  otherData = join(root, "other-data");
  code = join(root, "code");
  for (const dir of [data, otherData]) {
    await mkdir(join(dir, "specs"), { recursive: true });
    await writeFile(join(dir, "README.md"), "# Specs\n");
  }
  await mkdir(join(code, "src"), { recursive: true });
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);
  const fake = fakeProvider();
  sessions = fake.sessions;
  disposers.push(agents.register(fake.provider));
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await endAllChatSessions();
  reloader.stop();
  for (const dispose of disposers.splice(0)) await dispose();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
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

async function start(body: Record<string, unknown> = {}): Promise<ChatSessionMeta> {
  const res = await api("/api/agent/chat", "POST", { agent: "fake", ...body });
  expect(res.status).toBe(200);
  return (await res.json()) as ChatSessionMeta;
}

async function switchTo(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await api("/api/state", "PUT", body);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

test("a session belongs to the folder open when it started, not the folder the pane picked", async () => {
  expect((await start()).project).toBe(data);
  expect((await start({ cwd: code })).project).toBe(data);
  await switchTo({ openCodeRepo: code });
  expect((await start({ cwd: join(code, "src") })).project).toBe(code);
});

test("picking another specifications folder closes the sessions of the one before, before it answers", async () => {
  const a = await start({ prompt: "Fix the login bug" });
  const b = await start({ cwd: code });
  const body = await switchTo({ dataRepo: otherData });
  expect(body.closedSessions).toBe(2);
  expect(listChatSessions()).toEqual([]);
  expect((await api(`/api/agent/chat/${a.id}`)).status).toBe(404);
  // The agents were stopped, and the records say why the sessions ended.
  expect(sessions.every((s) => s.closed)).toBe(true);
  const record = JSON.parse(
    await readFile(join(await sessionsDirectory(root), b.id, "session.json"), "utf8"),
  ) as { status: string; endedAt?: string };
  expect(record.status).toBe("ended");
  expect(record.endedAt).toBeDefined();
});

test("opening a code repository closes the specifications folder's sessions, and switching back closes its", async () => {
  await start();
  expect((await switchTo({ openCodeRepo: code })).closedSessions).toBe(1);
  const inCode = await start();
  expect(listChatSessions().map((m) => m.id)).toEqual([inCode.id]);
  expect((await switchTo({ dataRepo: data })).closedSessions).toBe(1);
  expect(listChatSessions()).toEqual([]);
});

test("the open folder's own sessions stay, and a change that switches no folder closes nothing", async () => {
  const here = await start();
  const same = await switchTo({ dataRepo: data });
  expect(same.closedSessions).toBeUndefined();
  const settings = await switchTo({ reloadFrequencySeconds: 30 });
  expect(settings.closedSessions).toBeUndefined();
  expect(listChatSessions().map((m) => m.id)).toEqual([here.id]);
});

test("the pane drops the closed sessions' tabs after a switch and opens on the new-session screen", async () => {
  // The client store reads the server through fetch; route it to handleApi.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handleApi(new Request(new URL(url, "http://localhost"), init)) as Promise<Response>;
  }) as typeof fetch;
  const a = await start();
  await agentChat.refreshList();
  agentChat.setActive(a.id);
  expect(agentChatState().list.map((m) => m.id)).toEqual([a.id]);
  await switchTo({ openCodeRepo: code });
  await agentChat.switchedFolder();
  expect(agentChatState().list).toEqual([]);
  expect(agentChatState().sessions).toEqual({});
  expect(agentChatState().activeId).toBeNull();
});

test("a closed session's transcript says it belonged to another folder; a folder written with a slash is the same folder", async () => {
  const sessionsDir = await sessionsDirectory(root);
  const there = await createChatSession({ place: { dataRepo: data }, name: "There", agent: "fake", sessionsDir });
  const here = await createChatSession({ place: { dataRepo: code }, name: "Here", agent: "fake", sessionsDir });
  const notes = (id: string) => {
    const seen: string[] = [];
    subscribeChat(id, (ev) => {
      if (ev.kind === "note") seen.push(ev.text);
    });
    return seen;
  };
  const thereNotes = notes(there.id);
  const hereNotes = notes(here.id);
  expect(await closeOtherProjects(`${code}/`)).toBe(1);
  expect(listChatSessions().map((m) => m.id)).toEqual([here.id]);
  expect(thereNotes).toEqual(["The folder was switched; this session belonged to another folder."]);
  // A tab's × still says plainly that the session ended.
  await endChatSession(here.id);
  expect(hereNotes).toEqual(["Session ended."]);
  expect(listChatSessions()).toEqual([]);
});

test("the toast after a switch says how many sessions went, and nothing when none did", () => {
  expect(closedSessionsNote(1)).toBe("Closed 1 coding agent session from the other folder");
  expect(closedSessionsNote(3)).toBe("Closed 3 coding agent sessions from the other folder");
  expect(closedSessionsNote(0)).toBeNull();
  expect(closedSessionsNote(undefined)).toBeNull();
});

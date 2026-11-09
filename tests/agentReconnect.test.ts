// Automates specs/agents/agent-pane.feature.md S14 "Switching folders tries
// the agent's API again": a folder switch — a code repository opened, or
// another specifications folder picked — has every agent try its API from
// the folder now open; the answer rides on the agent's choices, the pane
// warns of an API that does not answer, and its Retry tries again.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { handleApi, reloader } from "../src/server/api";
import { endAllChatSessions, forgetConnections, reconnectAgent } from "../src/server/agentChat";
import type { AgentChoices } from "../src/server/agentTypes";
import { agents, type AgentReconnect } from "../src/plugins/host/agents";
import type { Disposer } from "../src/plugins/kernel";
import { writeState } from "../src/server/state";
import { ConnectionWarning } from "../src/frontend/AgentPane";
import { agentChat } from "../src/frontend/agentChat";
import { fakeProvider } from "./helpers/fakeAgent";

let root: string;
let data: string;
let otherData: string;
let code: string;
/** The folders the fake agent was asked to reconnect from, in order. */
let tried: string[];
/** What the fake agent's next reconnect answers. */
let answer: () => Promise<AgentReconnect | null>;
const disposers: Disposer[] = [];
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
  DEMO_MODE: process.env.DEMO_MODE,
  SPECDRIVEN_HOSTED: process.env.SPECDRIVEN_HOSTED,
};
const DOWN: AgentReconnect = {
  ok: false,
  detail: "No answer from the API at http://localhost:6655/anthropic/ — is the proxy running?",
  url: "http://localhost:6655/anthropic/",
};
const UP: AgentReconnect = { ok: true, detail: "Reachable", url: "http://localhost:6655/anthropic/" };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-reconnect-")));
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
  await mkdir(code, { recursive: true });
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);
  tried = [];
  answer = async () => DOWN;
  forgetConnections();
  disposers.push(
    agents.register(
      fakeProvider({
        id: "claude",
        rank: 10,
        choices: async (): Promise<AgentChoices> => ({ models: [], model: null, effort: null }),
        reconnect: async ({ cwd }) => {
          tried.push(cwd);
          return answer();
        },
      }).provider,
    ),
    // An agent with nothing to try: no hook at all.
    agents.register(fakeProvider({ id: "codex", rank: 20 }).provider),
  );
});

afterEach(async () => {
  await endAllChatSessions();
  reloader.stop();
  forgetConnections();
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

async function choices(agent = "claude"): Promise<AgentChoices | null> {
  const res = await api(`/api/agent/agents/${agent}/choices`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { choices: AgentChoices | null }).choices;
}

/** The switch does not wait for the tries; wait for the agent's answer. */
async function connectionAfterSwitch(): Promise<AgentChoices["connection"]> {
  for (let i = 0; i < 200; i++) {
    const c = (await choices())?.connection;
    if (c) return c;
    await Bun.sleep(5);
  }
  throw new Error("no connection answer arrived");
}

test("opening a code repository tries the agent's API from it, and the choices carry the answer", async () => {
  expect((await choices())?.connection).toBeUndefined();
  const res = await api("/api/state", "PUT", { openCodeRepo: code });
  expect(res.status).toBe(200);
  const connection = await connectionAfterSwitch();
  expect(tried).toEqual([code]);
  expect(connection).toMatchObject({ ok: false, detail: DOWN.detail, url: DOWN.url });
  expect(Date.parse(connection!.at)).not.toBeNaN();
});

test("picking another specifications folder tries the API again from that folder", async () => {
  answer = async () => UP;
  const res = await api("/api/state", "PUT", { dataRepo: otherData });
  expect(res.status).toBe(200);
  expect((await connectionAfterSwitch())?.ok).toBe(true);
  expect(tried).toEqual([otherData]);
});

test("a settings change that switches no folder tries nothing", async () => {
  const res = await api("/api/state", "PUT", { reloadFrequencySeconds: 30 });
  expect(res.status).toBe(200);
  await Bun.sleep(20);
  expect(tried).toEqual([]);
  expect((await choices())?.connection).toBeUndefined();
});

test("Retry tries again from the open folder and the answer replaces the last one", async () => {
  await api("/api/state", "PUT", { openCodeRepo: code });
  expect((await connectionAfterSwitch())?.ok).toBe(false);
  answer = async () => UP;
  const res = await api("/api/agent/agents/claude/reconnect", "POST");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { choices: AgentChoices };
  expect(body.choices.connection).toMatchObject({ ok: true, detail: "Reachable" });
  expect(tried).toEqual([code, code]);
});

test("an agent with nothing to try has no answer, and a try that throws is a failed one", async () => {
  expect(await reconnectAgent("codex", data)).toBeNull();
  expect((await api("/api/agent/agents/codex/reconnect", "POST")).status).toBe(200);
  answer = async () => {
    throw new Error("the proxy check blew up");
  };
  expect(await reconnectAgent("claude", data)).toMatchObject({ ok: false, detail: "the proxy check blew up" });
  // A sign-in with no endpoint of its own answers null: the warning goes.
  answer = async () => null;
  expect(await reconnectAgent("claude", data)).toBeNull();
  expect((await choices())?.connection).toBeUndefined();
  expect((await api("/api/agent/agents/nobody/reconnect", "POST")).status).toBe(404);
});

test("tries that overlap share one call to the agent", async () => {
  let release!: () => void;
  answer = () => new Promise((resolve) => (release = () => resolve(UP)));
  const a = reconnectAgent("claude", data);
  const b = reconnectAgent("claude", data);
  await Bun.sleep(0);
  release();
  expect(await a).toEqual(await b);
  expect(tried).toEqual([data]);
});

test("the pane warns of an API that did not answer, with Retry, and says nothing once it does", () => {
  const html = (connection?: AgentChoices["connection"]) => {
    agentChat.setChoices("claude", { models: [], model: null, effort: null, ...(connection ? { connection } : {}) });
    return renderToStaticMarkup(createElement(ConnectionWarning, { agent: "claude" }));
  };
  try {
    const at = new Date().toISOString();
    const down = html({ ...DOWN, at });
    expect(down).toContain('role="alert"');
    expect(down).toContain("No answer from the API at http://localhost:6655/anthropic/ — is the proxy running?");
    expect(down).toMatch(/<button[^>]*class="btn btn-secondary"[^>]*>Retry<\/button>/);
    expect(html({ ...UP, at })).toBe("");
    expect(html()).toBe("");
  } finally {
    agentChat.setChoices("claude", undefined);
  }
});

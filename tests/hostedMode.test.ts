// Hosted mode (SPECDRIVEN_HOSTED=1, src/server/hostedMode.ts): the app as one
// user's worker behind the gateway. Nothing it serves may run code or reach
// outside that user's folder — local agents, plugin installs, the folder
// chooser, IntelliJ, local-path data repos and GitHub sign-in are off — and
// its GitHub token comes from the environment the gateway started it with.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentKey, agentKeyEnvName, agentKeys } from "../src/server/agentKeys";
import { handleApi } from "../src/server/api";
import { normalizeCodeRepo } from "../src/server/members";
import { currentEngine, setGitEngine } from "../src/server/git";
import { createEnvBackend, TOKEN_ENV } from "../src/server/tokenStore";

let root: string;
const saved = {
  root: process.env.SPECDRIVEN_ROOT,
  home: process.env.SPECDRIVEN_HOME,
  hosted: process.env.SPECDRIVEN_HOSTED,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-hosted-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  process.env.SPECDRIVEN_HOSTED = "1";
});

afterEach(async () => {
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", saved.root],
    ["SPECDRIVEN_HOME", saved.home],
    ["SPECDRIVEN_HOSTED", saved.hosted],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function api(method: string, path: string, body?: unknown) {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

test.each([
  ["POST", "/api/agent/session"],
  ["POST", "/api/agent/chat"],
  ["GET", "/api/agent/chat/abc"],
  ["GET", "/api/agent/chat/abc/events"],
  ["POST", "/api/agent/chat/abc/message"],
  ["DELETE", "/api/agent/chat/abc"],
  ["POST", "/api/choose-folder"],
  ["POST", "/api/tests/open-in-idea"],
  ["POST", "/api/plugins/install"],
  ["POST", "/api/plugins/x/update"],
  ["DELETE", "/api/plugins/x"],
  ["POST", "/api/auth/github/start"],
  ["POST", "/api/auth/github/web/start"],
  ["DELETE", "/api/auth/github"],
])("%s %s is refused in a hosted worker", async (method, path) => {
  const res = await api(method, path, method === "GET" || method === "DELETE" ? undefined : {});
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toMatch(/hosted/);
});

test("the agent pane lists no sessions rather than refusing", async () => {
  const res = await api("GET", "/api/agent/chat");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ sessions: [] });
});

test("the state says hosted and offers no local agents, folder chooser or IntelliJ", async () => {
  const state = (await (await api("GET", "/api/state")).json()) as Record<string, unknown>;
  expect(state.hosted).toBe(true);
  for (const flag of ["canRunAgentPane", "canRunPi", "canRunCodex", "canOpenClaudeDesktop", "canChooseFolder", "canOpenInIdea"]) {
    expect(state[flag]).toBe(false);
  }
});

test.each([
  [{ dataRepo: "/etc" }, /GitHub repositories only/],
  [{ dataRepo: "../other-user" }, /GitHub repositories only/],
  [{ gitEngine: "gh" }, /GitHub CLI/],
  [{ plugins: { sources: ["/tmp/x"] } }, /Plugin folders/],
  [{ plugins: { marketplaces: ["https://example.com/m.git"] } }, /Plugin folders/],
  [{ syncServerUrl: "ws://10.0.0.1:1234" }, /sync server/],
])("Settings refuse %j in a hosted worker", async (body, message) => {
  const res = await api("PUT", "/api/state", body);
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toMatch(message);
});

test("other settings still change in a hosted worker", async () => {
  const res = await api("PUT", "/api/state", { reloadFrequencySeconds: 120 });
  expect(res.status).toBe(200);
});

test("the git engine is never gh in a hosted worker", () => {
  setGitEngine("gh");
  expect(currentEngine()).not.toBe("gh");
  setGitEngine("js");
  expect(currentEngine()).toBe("js");
});

test("the env token backend reads the gateway's record and refuses to change it", async () => {
  const record = { token: "ghp_x", login: "octo", name: "Octo", email: "o@example.com", id: 1 };
  const backend = createEnvBackend({ [TOKEN_ENV]: JSON.stringify(record) });
  expect(await backend.load()).toEqual(record);
  expect(await createEnvBackend({}).load()).toBeNull();
  expect(await createEnvBackend({ [TOKEN_ENV]: "not json" }).load()).toBeNull();
  await expect(backend.save(record)).rejects.toThrow(/account page/);
  await expect(backend.clear()).rejects.toThrow(/account page/);
});

test("agent keys arrive as SPECDRIVEN_AGENT_KEY_<NAME> variables", () => {
  expect(agentKeyEnvName("openai-prod")).toBe("SPECDRIVEN_AGENT_KEY_OPENAI_PROD");
  const env = { SPECDRIVEN_AGENT_KEY_ANTHROPIC: "sk-a", SPECDRIVEN_AGENT_KEY_OPENAI_PROD: "sk-o", OTHER: "x" };
  expect(agentKey("anthropic", env)).toBe("sk-a");
  expect(agentKey("openai-prod", env)).toBe("sk-o");
  expect(agentKey("missing", env)).toBeNull();
  expect([...agentKeys(env).entries()]).toEqual([
    ["ANTHROPIC", "sk-a"],
    ["OPENAI_PROD", "sk-o"],
  ]);
});

test("the user shown is the gateway's account, not the container's OS user", async () => {
  process.env.SPECDRIVEN_ACCOUNT_EMAIL = "a@example.com";
  try {
    const state = (await (await api("GET", "/api/state")).json()) as { user: { username: string } };
    expect(state.user.username).toBe("a@example.com");
  } finally {
    delete process.env.SPECDRIVEN_ACCOUNT_EMAIL;
  }
});

test("a data repo's code-repo path is ignored, so it cannot point into another user's folder", () => {
  expect(normalizeCodeRepo({ "code-repo": "/data/users/someone-else/repos/x" }, "/data/users/me/repos/specs")).toBeNull();
  expect(normalizeCodeRepo({ "code-repo": "../../../other" }, "/data/users/me/repos/specs")).toBeNull();
  delete process.env.SPECDRIVEN_HOSTED;
  expect(normalizeCodeRepo({ "code-repo": "/code" }, "/data")).toBe("/code");
});

// The models each coding agent offers (specs/agents/agent-plugins.feature.md
// "Each agent offers the models the data repo lists"): one list per agent id
// in the data repo's .specdriven/agent-models.json, read with /api/state and
// written one agent at a time by Settings → AI agents.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  AGENT_MODELS_FILE,
  MAX_AGENT_MODELS,
  normalizeAgentModels,
  readAgentModels,
  writeAgentModels,
} from "../src/server/agentModels";
import { writeState } from "../src/server/state";

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-agent-models-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-agent-models-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  await mkdir(data, { recursive: true });
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const fileText = () => readFile(join(data, AGENT_MODELS_FILE), "utf8");

test("each agent keeps its own list in the data repo's .specdriven/agent-models.json", async () => {
  expect(await readAgentModels(data)).toEqual({});
  expect(await writeAgentModels(data, "claude", ["opus", " sonnet ", "opus", ""])).toEqual({
    claude: ["opus", "sonnet"],
  });
  expect(await writeAgentModels(data, "codex", ["gpt-5-codex"])).toEqual({
    claude: ["opus", "sonnet"],
    codex: ["gpt-5-codex"],
  });
  expect(JSON.parse(await fileText())).toEqual({ claude: ["opus", "sonnet"], codex: ["gpt-5-codex"] });
  expect(await fileText()).toEndWith("]\n}\n");
  // An empty list takes the agent's key away; the others stay.
  expect(await writeAgentModels(data, "claude", [])).toEqual({ codex: ["gpt-5-codex"] });
  expect(JSON.parse(await fileText())).toEqual({ codex: ["gpt-5-codex"] });
});

test("a name no agent would take, a bad agent id or too many names is refused", async () => {
  await expect(writeAgentModels(data, "claude", ["claude sonnet"])).rejects.toThrow(/Not a model name/);
  await expect(writeAgentModels(data, "claude", ["-x"])).rejects.toThrow(/Not a model name/);
  await expect(writeAgentModels(data, "claude", "opus")).rejects.toThrow(/list of model names/);
  await expect(writeAgentModels(data, "../x", ["opus"])).rejects.toThrow(/Not an agent id/);
  const many = Array.from({ length: MAX_AGENT_MODELS + 1 }, (_, i) => `m${i}`);
  await expect(writeAgentModels(data, "claude", many)).rejects.toThrow(/At most/);
  // Model ids with the punctuation real ones use go through.
  expect(await writeAgentModels(data, "claude", ["claude-sonnet-4-5[1m]", "us.anthropic.claude-opus-4-1:0"])).toEqual({
    claude: ["claude-sonnet-4-5[1m]", "us.anthropic.claude-opus-4-1:0"],
  });
});

test("a teammate's list for an agent this app lacks survives a save", async () => {
  await mkdir(join(data, ".specdriven"), { recursive: true });
  await writeFile(join(data, AGENT_MODELS_FILE), JSON.stringify({ pi: ["anthropic/claude-opus-4"], note: 1 }));
  await writeAgentModels(data, "claude", ["opus"]);
  expect(JSON.parse(await fileText())).toEqual({ pi: ["anthropic/claude-opus-4"], note: 1, claude: ["opus"] });
});

test("a broken file reads as no lists and is not overwritten", async () => {
  await mkdir(join(data, ".specdriven"), { recursive: true });
  await writeFile(join(data, AGENT_MODELS_FILE), "{ not json");
  expect(await readAgentModels(data)).toEqual({});
  await expect(writeAgentModels(data, "claude", ["opus"])).rejects.toThrow(/fix it by hand/);
  expect(await fileText()).toBe("{ not json");
  await writeFile(join(data, AGENT_MODELS_FILE), "[]");
  await expect(writeAgentModels(data, "claude", ["opus"])).rejects.toThrow(/JSON object/);
});

test("reading keeps names only, valid, once each", () => {
  expect(
    normalizeAgentModels({
      claude: ["opus", 3, "opus", "bad name", " haiku "],
      codex: [],
      "Not An Id": ["x"],
      pi: "opus",
    }),
  ).toEqual({ claude: ["opus", "haiku"] });
  expect(normalizeAgentModels([])).toEqual({});
  expect(normalizeAgentModels(null)).toEqual({});
});

const put = async (agent: string, body: unknown) =>
  (await handleApi(
    new Request(`http://localhost/api/agent-models/${agent}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ))!;

test("the lists come with the state and Settings writes one agent's at a time", async () => {
  await writeState({ dataRepo: data }, root);
  const state = async () =>
    (await (await handleApi(new Request("http://localhost/api/state")))!.json()) as {
      agentModels: Record<string, string[]>;
    };
  expect((await state()).agentModels).toEqual({});
  const res = await put("claude", { models: ["opus", "sonnet"] });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ agentModels: { claude: ["opus", "sonnet"] } });
  expect((await put("codex", { models: ["gpt-5-codex"] })).status).toBe(200);
  expect((await state()).agentModels).toEqual({ claude: ["opus", "sonnet"], codex: ["gpt-5-codex"] });
  expect((await put("claude", { models: ["two words"] })).status).toBe(400);
  expect((await put("claude", {})).status).toBe(400);
});

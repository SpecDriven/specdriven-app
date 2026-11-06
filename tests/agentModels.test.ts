// The models each coding agent offers (specs/agents/agent-plugins.feature.md
// "Each agent offers the models the data repo lists"): one file per agent in
// the data repo's .specdriven/ (claude-models.json, codex-models.json), read
// with /api/state, written one agent at a time by Settings → AI agents, and
// checked against the models each agent's API reports.

import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  LEGACY_AGENT_MODELS_FILE,
  MAX_AGENT_MODELS,
  agentModelsFile,
  normalizeAgentModels,
  readAgentModels,
  resetUnreportedModelWarnings,
  warnUnreportedModels,
  writeAgentModels,
} from "../src/server/agentModels";
import { writeState } from "../src/server/state";
import { agents } from "../src/plugins/host/agents";
import { fakeProvider } from "./helpers/fakeAgent";

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

const fileText = (agent: string) => readFile(join(data, agentModelsFile(agent)), "utf8");
const exists = (rel: string) => access(join(data, rel)).then(() => true, () => false);

test("each agent keeps its own list in the data repo's .specdriven/<agent>-models.json", async () => {
  expect(agentModelsFile("claude")).toBe(".specdriven/claude-models.json");
  expect(await readAgentModels(data)).toEqual({});
  expect(await writeAgentModels(data, "claude", ["opus", " sonnet ", "opus", ""])).toEqual({
    claude: ["opus", "sonnet"],
  });
  expect(await writeAgentModels(data, "codex", ["gpt-5-codex"])).toEqual({
    claude: ["opus", "sonnet"],
    codex: ["gpt-5-codex"],
  });
  expect(JSON.parse(await fileText("claude"))).toEqual(["opus", "sonnet"]);
  expect(JSON.parse(await fileText("codex"))).toEqual(["gpt-5-codex"]);
  expect(await fileText("claude")).toBe('[\n  "opus",\n  "sonnet"\n]\n');
  // An empty list takes the agent's file away; the others stay.
  expect(await writeAgentModels(data, "claude", [])).toEqual({ codex: ["gpt-5-codex"] });
  expect(await exists(agentModelsFile("claude"))).toBe(false);
  expect(await exists(LEGACY_AGENT_MODELS_FILE)).toBe(false);
});

test("a name no agent would take, a bad agent id or too many names is refused", async () => {
  await expect(writeAgentModels(data, "claude", ["claude sonnet"])).rejects.toThrow(/Not a model name/);
  await expect(writeAgentModels(data, "claude", ["-x"])).rejects.toThrow(/Not a model name/);
  await expect(writeAgentModels(data, "claude", "opus")).rejects.toThrow(/list of model names/);
  await expect(writeAgentModels(data, "../x", ["opus"])).rejects.toThrow(/Not an agent id/);
  // `agent` would name the old shared file.
  await expect(writeAgentModels(data, "agent", ["opus"])).rejects.toThrow(/Not an agent id/);
  const many = Array.from({ length: MAX_AGENT_MODELS + 1 }, (_, i) => `m${i}`);
  await expect(writeAgentModels(data, "claude", many)).rejects.toThrow(/At most/);
  // Model ids with the punctuation real ones use go through.
  expect(await writeAgentModels(data, "claude", ["claude-sonnet-4-5[1m]", "us.anthropic.claude-opus-4-1:0"])).toEqual({
    claude: ["claude-sonnet-4-5[1m]", "us.anthropic.claude-opus-4-1:0"],
  });
});

test("a teammate's list for an agent this app lacks survives a save", async () => {
  await mkdir(join(data, ".specdriven"), { recursive: true });
  await writeFile(join(data, agentModelsFile("pi")), JSON.stringify(["anthropic/claude-opus-4"]));
  await writeAgentModels(data, "claude", ["opus"]);
  expect(JSON.parse(await fileText("pi"))).toEqual(["anthropic/claude-opus-4"]);
  expect(await readAgentModels(data)).toEqual({ claude: ["opus"], pi: ["anthropic/claude-opus-4"] });
});

test("a broken file reads as no list and is not overwritten", async () => {
  await mkdir(join(data, ".specdriven"), { recursive: true });
  await writeFile(join(data, agentModelsFile("claude")), "{ not json");
  await writeFile(join(data, agentModelsFile("codex")), JSON.stringify(["gpt-5-codex"]));
  expect(await readAgentModels(data)).toEqual({ codex: ["gpt-5-codex"] });
  await expect(writeAgentModels(data, "claude", ["opus"])).rejects.toThrow(/fix it by hand/);
  expect(await fileText("claude")).toBe("{ not json");
  await writeFile(join(data, agentModelsFile("claude")), '{"claude": ["opus"]}');
  await expect(writeAgentModels(data, "claude", ["opus"])).rejects.toThrow(/JSON list/);
});

test("the old shared agent-models.json is split into a file per agent and removed", async () => {
  await mkdir(join(data, ".specdriven"), { recursive: true });
  await writeFile(
    join(data, LEGACY_AGENT_MODELS_FILE),
    JSON.stringify({ claude: ["opus", "sonnet"], codex: ["gpt-5-codex"], pi: [], note: 1 }),
  );
  // An agent that already has its own file keeps it.
  await writeFile(join(data, agentModelsFile("codex")), JSON.stringify(["gpt-5"]));
  expect(await readAgentModels(data)).toEqual({ claude: ["opus", "sonnet"], codex: ["gpt-5"] });
  expect(await exists(LEGACY_AGENT_MODELS_FILE)).toBe(false);
  expect(JSON.parse(await fileText("claude"))).toEqual(["opus", "sonnet"]);
  expect(await exists(agentModelsFile("pi"))).toBe(false);
});

test("an old shared file that is not a JSON object is left to fix by hand", async () => {
  await mkdir(join(data, ".specdriven"), { recursive: true });
  await writeFile(join(data, LEGACY_AGENT_MODELS_FILE), "{ not json");
  expect(await readAgentModels(data)).toEqual({});
  expect(await readFile(join(data, LEGACY_AGENT_MODELS_FILE), "utf8")).toBe("{ not json");
  // A save is not blocked by it: the agent's own file is written.
  expect(await writeAgentModels(data, "claude", ["opus"])).toEqual({ claude: ["opus"] });
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

test("a listed model the agent's API does not report is logged as a warning, once", async () => {
  resetUnreportedModelWarnings();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const reported = async (agent: string) =>
      agent === "claude" ? ["default", "opus", "claude-opus-5-5", "sonnet"] : null;
    const lists = { claude: ["opus", "claude-opus-4-1", "sonnet"], codex: ["gpt-5-codex"] };
    expect(await warnUnreportedModels(lists, reported)).toEqual({ claude: ["claude-opus-4-1"] });
    const lines = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[agent-models]"));
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("not one the agent's API reports");
    expect(lines()[0]).toContain('model="claude-opus-4-1"');
    expect(lines()[0]).toContain('file=".specdriven/claude-models.json"');
    // An agent whose API cannot say (codex here) is not checked; the same
    // finding again is not logged again.
    await warnUnreportedModels(lists, reported);
    expect(lines()).toHaveLength(1);
    // A list whose models are all reported logs nothing, and a later miss logs anew.
    await warnUnreportedModels({ claude: ["opus"] }, reported);
    expect(lines()).toHaveLength(1);
    await warnUnreportedModels(lists, reported);
    expect(lines()).toHaveLength(2);
    // An agent that fails to answer is skipped, not fatal.
    const failing = async () => {
      throw new Error("offline");
    };
    expect(await warnUnreportedModels({ claude: ["nope"] }, failing)).toEqual({});
  } finally {
    warn.mockRestore();
  }
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

test("saving a list checks it against the models the agent's API reports", async () => {
  await writeState({ dataRepo: data }, root);
  resetUnreportedModelWarnings();
  const { provider } = fakeProvider({ id: "models-check" });
  const dispose = agents.register({ ...provider, reportedModels: async () => ["opus", "sonnet"] });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await put("models-check", { models: ["opus", "gpt-9"] })).status).toBe(200);
    const logged = async () => {
      for (let i = 0; i < 50; i++) {
        const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('model="gpt-9"'));
        if (lines.length > 0) return lines;
        await Bun.sleep(10);
      }
      return [];
    };
    const lines = await logged();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('agent="models-check"');
    // The list is still kept as written: the warning does not refuse it.
    expect(JSON.parse(await fileText("models-check"))).toEqual(["opus", "gpt-9"]);
  } finally {
    warn.mockRestore();
    dispose();
  }
});

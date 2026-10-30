// Automates specs/agents/agents-md.feature.md: the AGENTS.md the sync tick
// installs into a data folder that has none, and the template it installs.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS_FILE,
  AGENTS_TEMPLATE,
  agentsFileName,
  installAgentsFile,
  readAgentsFile,
} from "../src/server/agentsFile";
import { reloader, syncedOnStart } from "../src/server/api";
import { resetDataFormatFlags } from "../src/server/dataFormat";
import { setGitEngine } from "../src/server/git";
import { parseFeature, serializeFeature } from "../src/server/parser";
import { syncDataDir } from "../src/server/reload";
import { git, twoClones, type TwoClones } from "./helpers/fixtures";

let root: string;
let home: string;
let repos: TwoClones;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-agents-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-agents-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  setGitEngine("cli");
  repos = await twoClones(join(root, "repos"));
});

afterEach(async () => {
  await syncedOnStart();
  reloader.stop();
  resetDataFormatFlags();
  setGitEngine(null);
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

test("the template is installed into a folder with no AGENTS.md, once", async () => {
  const dir = join(root, "plain");
  await Bun.write(join(dir, "README.md"), "# Specs\n");
  expect(await agentsFileName(dir)).toBeNull();
  expect(await readAgentsFile(dir)).toBeNull();

  expect(await installAgentsFile(dir)).toBe(true);
  expect(await agentsFileName(dir)).toBe(AGENTS_FILE);
  expect(await readAgentsFile(dir)).toBe(AGENTS_TEMPLATE);
  // Once there, it is left alone.
  expect(await installAgentsFile(dir)).toBe(false);
});

test("a folder's own AGENTS.md is never written over, under any spelling", async () => {
  const dir = join(root, "own");
  const theirs = "# Our agents\n\nWrite specs in Dutch.\n";
  await Bun.write(join(dir, "agents.md"), theirs);

  expect(await installAgentsFile(dir)).toBe(false);
  expect(await agentsFileName(dir)).toBe("agents.md");
  expect(await readAgentsFile(dir)).toBe(theirs);
  expect((await readdir(dir)).filter((e) => e.toLowerCase() === "agents.md")).toEqual(["agents.md"]);

  // An edited copy of the template stays as edited, too.
  const edited = join(root, "edited");
  await Bun.write(join(edited, AGENTS_FILE), AGENTS_TEMPLATE + "\n- Scenarios name the SOD role.\n");
  expect(await installAgentsFile(edited)).toBe(false);
  expect(await readAgentsFile(edited)).toEndWith("- Scenarios name the SOD role.\n");
});

test("the template's example is a canonical feature file", () => {
  // The fenced example an agent will copy must be what the app itself would
  // write: numbered, [proposed], a zero diff on the app's first save.
  const m = AGENTS_TEMPLATE.match(/```markdown\n([\s\S]*?)```/);
  expect(m).not.toBeNull();
  const example = m![1]!;
  const feature = parseFeature(example);
  expect(feature.name).toBe("Collect premium");
  expect(feature.links).toEqual([{
    program: "Jira",
    ticket: "BIL-42",
    url: "https://acme.atlassian.net/browse/BIL-42",
  }]);
  expect(feature.scenarios.map((s) => [s.name, s.version, s.status, s.negative ?? false])).toEqual([
    ["Failed autopay starts the grace period", 1, "proposed", false],
    ["A policy without autopay is not charged", 1, "proposed", true],
    ["Retry schedule follows the card network", 1, "proposed", false],
  ]);
  expect(serializeFeature(feature)).toBe(example);
});

test("the sync tick installs AGENTS.md and pushes it; a later tick leaves it", async () => {
  expect(await readAgentsFile(repos.a)).toBeNull();
  const message = await syncDataDir(repos.a);
  expect(message).toContain(`installed ${AGENTS_FILE}`);
  expect(await readAgentsFile(repos.a)).toBe(AGENTS_TEMPLATE);
  // The tick committed and pushed it, so the teammate pulls it with the rest.
  await git(repos.b, "pull");
  expect(await readAgentsFile(repos.b)).toBe(AGENTS_TEMPLATE);
  expect((await git(repos.a, "status", "--porcelain")).stdout.toString()).toBe("");
  // In a commit of its own, so the auto-save commit still names what changed.
  const log = (await git(repos.originDir, "log", "--format=%s", "-3", "main")).stdout.toString();
  expect(log).toContain(`Add ${AGENTS_FILE}`);
  // A second tick finds the file and says nothing about it.
  expect(await syncDataDir(repos.a)).not.toContain(`installed ${AGENTS_FILE}`);
});

test("the sync tick keeps a teammate's AGENTS.md", async () => {
  const theirs = "# Agents\n\nOur own rules.\n";
  await Bun.write(join(repos.b, AGENTS_FILE), theirs);
  await git(repos.b, "add", "-A");
  await git(repos.b, "commit", "-m", "our agents file");
  await git(repos.b, "push", "origin", "HEAD:main");

  const message = await syncDataDir(repos.a);
  expect(message).not.toContain(`installed ${AGENTS_FILE}`);
  expect(await readAgentsFile(repos.a)).toBe(theirs);
});

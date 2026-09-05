// Automates specs/agents/claude.spec.md over the route: POST /api/agent/session
// takes the session name, the selection and where to run. "desktop" writes
// the prompt and a session record beside the settings file — never in the
// data repo — and opens Claude Code Desktop; the remembered "Run in" choice
// round-trips through the settings file.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { setDesktopAvailability, setDesktopRunner } from "../src/server/agent";
import type { Runner } from "../src/server/agent";
import { createFeature, saveFeature } from "../src/server/features";
import type { RunOptions } from "../src/server/run";
import { readState, writeState } from "../src/server/state";

let root: string;
let home: string;
let data: string;
let calls: { cmd: string; args: string[]; options?: RunOptions }[];
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

const recordingRunner: Runner = async (cmd, args, options) => {
  calls.push({ cmd, args, options });
  return { exitCode: 0, stdout: "", stderr: "" };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-agent-session-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-agent-session-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  calls = [];
  setDesktopAvailability(() => true);
  setDesktopRunner(recordingRunner);
  await writeState({ dataRepo: data }, root);
  await createFeature(data, "Quote");
  await saveFeature(data, "quote.feature.md", "# Quote\n\n## Basic @v1\n\nbody\n");
});

afterEach(async () => {
  reloader.stop();
  setDesktopAvailability(null);
  setDesktopRunner(null);
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

function api(path: string, method: string, body: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

const FILES = [{ fileName: "quote.feature.md" }];

test("an unknown target is refused", async () => {
  const res = await api("/api/agent/session", "POST", { name: "s", files: FILES, target: "nope" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("target must be desktop or cli");
  expect(calls).toHaveLength(0);
});

test("a desktop session saves the prompt beside the settings and opens Claude.app", async () => {
  const res = await api("/api/agent/session", "POST", {
    name: "implement quotes",
    files: FILES,
    target: "desktop",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { name: string; id: string; promptPath: string };
  expect(body.name).toBe("implement quotes");
  expect(body.promptPath).toBe(join(root, ".specdriven", "sessions", body.id, "prompt.md"));
  const prompt = await readFile(body.promptPath, "utf8");
  expect(prompt).toContain("SpecDriven code gen session: implement quotes");
  expect(prompt).toContain("## Spec: quote.feature.md");
  expect(prompt).toContain("## Basic @v1");
  const record = JSON.parse(
    await readFile(join(root, ".specdriven", "sessions", body.id, "session.json"), "utf8"),
  );
  expect(record.name).toBe("implement quotes");
  expect(record.dataRepo).toBe(data);
  // Nothing of the session lands in the data repo, which is pushed to git.
  expect(stat(join(data, ".specdriven", "sessions"))).rejects.toThrow();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.cmd).toBe("open");
  expect(new URL(calls[0]!.args[0]!).searchParams.get("folder")).toBe(data);
});

test("without Claude.app the desktop target is refused before anything runs", async () => {
  setDesktopAvailability(() => false);
  const res = await api("/api/agent/session", "POST", { name: "s", files: FILES, target: "desktop" });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("Claude Code Desktop not found");
  expect(calls).toHaveLength(0);
});

test("the state reports whether Claude Code Desktop can be opened", async () => {
  const res = (await handleApi(new Request("http://localhost/api/state")))!;
  expect(((await res.json()) as { canOpenClaudeDesktop: boolean }).canOpenClaudeDesktop).toBe(true);
  setDesktopAvailability(() => false);
  const again = (await handleApi(new Request("http://localhost/api/state")))!;
  expect(((await again.json()) as { canOpenClaudeDesktop: boolean }).canOpenClaudeDesktop).toBe(
    false,
  );
});

test("the Run in choice round-trips through the settings file", async () => {
  const before = (await handleApi(new Request("http://localhost/api/state")))!;
  expect(((await before.json()) as { codeGenTarget: unknown }).codeGenTarget).toBeNull();
  const res = await api("/api/state", "PUT", { codeGenTarget: "cli" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { codeGenTarget: string }).codeGenTarget).toBe("cli");
  expect((await readState(root)).codeGenTarget).toBe("cli");
  const bad = await api("/api/state", "PUT", { codeGenTarget: "x" });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("codeGenTarget must be desktop or cli");
});

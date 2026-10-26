// Add a task to Google Calendar (specs/app/tasks.feature.md): the estimate
// route asks a coding agent once, through a provider's one-shot turn
// (src/plugins/host/agents.ts), so a fake provider answers here and nothing
// spawns.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { agents } from "../src/plugins/host/agents";
import type { OneShotRequest, OneShotResult } from "../src/plugins/host/agents";
import type { Disposer } from "../src/plugins/kernel";
import { estimatePrompt, minutesFromResult } from "../src/server/estimate";
import { writeState } from "../src/server/state";
import { syncPlugins } from "../src/plugins/host/loader";
import { fakeProvider } from "./helpers/fakeAgent";

let root: string;
let home: string;
let data: string;
/** The one-shot requests the fake agent took. */
let asked: OneShotRequest[];
/** What the fake answers, or the error it throws. */
let answer: OneShotResult | Error;
let available: boolean;
let dispose: Disposer;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const TASK = "tasks/ship-v2.md";

const success = (text: string, structured?: unknown): OneShotResult => ({
  text,
  ...(structured === undefined ? {} : { structured }),
  isError: false,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-estimate-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-estimate-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  asked = [];
  answer = success("90", { minutes: 90 });
  available = true;
  // An agent plugin's provider that answers one-shot turns, under Claude's
  // id since the estimate prefers it; nothing spawns.
  const { provider } = fakeProvider({
    id: "claude",
    rank: 10,
    available: () => available,
    missingMessage: "Claude CLI not found",
    capabilities: { oneShot: true },
    oneShot: async (req) => {
      asked.push(req);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  dispose = agents.register(provider);
  await writeState({ dataRepo: data, tasks: true, googleCalendar: true }, root);
  // The route is the tasks plugin's (src/plugins/builtin/pages/host.ts): it
  // exists while the Tasks switch has the plugin mounted.
  await syncPlugins({ tasks: true });
  await mkdir(join(data, "tasks"), { recursive: true });
  await writeFile(
    join(data, TASK),
    "# Ship v2\n\n**Assigned:** Ada\n\nCut the build and tell everyone.\n",
  );
});

afterEach(async () => {
  reloader.stop();
  await syncPlugins({ tasks: false });
  await dispose();
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

function estimate(file = TASK): Promise<Response> {
  return handleApi(
    new Request(`http://localhost/api/tasks/${encodeURIComponent(file)}/estimate`, {
      method: "POST",
    }),
  ) as Promise<Response>;
}

test("the estimate route asks the agent once, with no tools, and answers in minutes", async () => {
  const res = await estimate();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ minutes: 90 });

  // One one-shot turn (src/plugins/host/agents.ts OneShotRequest): the
  // system prompt, a schema that holds the answer to a number, in the data
  // repo, with a deadline.
  expect(asked).toHaveLength(1);
  const req = asked[0]!;
  expect(typeof req.systemPrompt).toBe("string");
  expect(req.cwd).toBe(data);
  expect(req.schema).toMatchObject({ type: "object" });
  expect(req.timeoutMs).toBeGreaterThan(0);
  expect(req.prompt).toContain("Task: Ship v2");
  expect(req.prompt).toContain("Cut the build and tell everyone.");
  expect(req.prompt).not.toContain("**Assigned:**");
});

test("the estimate route is 404 while Google Calendar is switched off", async () => {
  await writeState({ dataRepo: data, tasks: true }, root);
  const res = await estimate();
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toContain("Google Calendar");
  expect(asked).toHaveLength(0);
});

test("the estimate route is 503 without an agent's CLI, 404 for a task that is not there, and 502 when the agent fails", async () => {
  available = false;
  expect((await estimate()).status).toBe(503);
  expect(asked).toHaveLength(0);

  available = true;
  expect((await estimate("tasks/nope.md")).status).toBe(404);
  expect(asked).toHaveLength(0);

  answer = { text: "ran out of turns", isError: true };
  const failed = await estimate();
  expect(failed.status).toBe(502);
  expect(((await failed.json()) as { error: string }).error).toContain("ran out of turns");

  answer = new Error("spawn failed");
  const thrown = await estimate();
  expect(thrown.status).toBe(502);
  expect(((await thrown.json()) as { error: string }).error).toContain("spawn failed");
});

test("a turn the API refused carries its own words", async () => {
  answer = { text: "Failed to authenticate. API Error: 401 Invalid bearer token", isError: true };
  const res = await estimate();
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toContain("401 Invalid bearer token");
});

test("a proposal that is not a number is refused", async () => {
  answer = success("about an hour, give or take");
  const res = await estimate();
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toContain("number of minutes");

  // Without structured output, the first whole number in the words is it.
  const answered = (text: string, structured?: unknown) => ({ text, structured, isError: false });
  expect(minutesFromResult(answered("I'd say 45 minutes."))).toBe(45);
  expect(minutesFromResult(answered("", { minutes: 120 }))).toBe(120);
  expect(minutesFromResult(answered("0"))).toBeNull();
  expect(minutesFromResult(answered("99999"))).toBeNull();
  expect(minutesFromResult({ text: "45", isError: true })).toBeNull();
});

test("an agent exiting without an answer is 502, and the prompt asks for minutes only", async () => {
  answer = new Error("Claude exited without an answer");
  const res = await estimate();
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toContain("without an answer");
  expect(estimatePrompt({ name: "Ship v2", body: "" })).toContain("(no further description)");
  expect(estimatePrompt({ name: "", body: "x" })).toContain("Task: (untitled)");
});

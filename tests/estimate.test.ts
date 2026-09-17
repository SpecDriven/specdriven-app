// Add a task to Google Calendar (specs/app/tasks.feature.md): the estimate
// route asks the developer's `claude` CLI once, through the coding agent
// pane's query seam, so a fake answers here and nothing spawns.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { handleApi, reloader } from "../src/server/api";
import { setClaudeAvailability } from "../src/server/agent";
import { InputQueue, setQueryFactory } from "../src/server/agentChat";
import type { QueryLike } from "../src/server/agentChat";
import { estimatePrompt, minutesFromResult } from "../src/server/estimate";
import { writeState } from "../src/server/state";

/** A stand-in for the SDK's Query that answers with one scripted message. */
class FakeQuery implements QueryLike {
  readonly out = new InputQueue<SDKMessage>();
  readonly inputs: SDKUserMessage[] = [];
  aborted = false;

  constructor(
    prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
    answer: SDKMessage | null,
  ) {
    void (async () => {
      for await (const m of prompt) this.inputs.push(m);
      if (answer) this.out.push(answer);
      // A one-turn query ends with its result; the fake ends too.
      this.out.close();
    })();
    options.abortController?.signal.addEventListener("abort", () => {
      this.aborted = true;
      this.out.close();
    });
  }

  [Symbol.asyncIterator]() {
    return this.out[Symbol.asyncIterator]();
  }
  async interrupt() {}
  async setPermissionMode() {}
  async supportedCommands() {
    return [];
  }
}

const success = (result: string, structured?: unknown): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    ...(structured === undefined ? {} : { structured_output: structured }),
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {},
    session_id: "s",
    uuid: "u",
  }) as unknown as SDKMessage;

let root: string;
let home: string;
let data: string;
let fakes: FakeQuery[];
let answer: SDKMessage | null;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const TASK = "tasks/ship-v2.md";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-estimate-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-estimate-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  fakes = [];
  answer = success("90", { minutes: 90 });
  setClaudeAvailability(() => true);
  setQueryFactory(({ prompt, options }) => {
    const fake = new FakeQuery(prompt, options, answer);
    fakes.push(fake);
    return fake;
  });
  await writeState({ dataRepo: data, tasks: true, googleCalendar: true }, root);
  await mkdir(join(data, "tasks"), { recursive: true });
  await writeFile(
    join(data, TASK),
    "# Ship v2\n\n**Assigned:** Ada\n\nCut the build and tell everyone.\n",
  );
});

afterEach(async () => {
  reloader.stop();
  setClaudeAvailability(null);
  setQueryFactory(null);
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

test("the estimate route asks Claude once, with no tools, and answers in minutes", async () => {
  const res = await estimate();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ minutes: 90 });

  expect(fakes).toHaveLength(1);
  const fake = fakes[0]!;
  const { options } = fake;
  expect(options.maxTurns).toBe(1);
  expect(options.tools).toEqual([]);
  expect(options.settingSources).toEqual([]);
  expect(options.persistSession).toBe(false);
  expect(typeof options.systemPrompt).toBe("string");
  expect(options.cwd).toBe(data);
  expect(options.env?.CLAUDECODE).toBeUndefined();
  expect(options.outputFormat?.type).toBe("json_schema");

  expect(fake.inputs).toHaveLength(1);
  const text = fake.inputs[0]!.message.content;
  expect(text).toContain("Task: Ship v2");
  expect(text).toContain("Cut the build and tell everyone.");
  expect(text).not.toContain("**Assigned:**");
  // The turn is over: nothing lingers.
  expect(fake.aborted).toBe(true);
});

test("the estimate route is 404 while Google Calendar is switched off", async () => {
  await writeState({ dataRepo: data, tasks: true }, root);
  const res = await estimate();
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toContain("Google Calendar");
  expect(fakes).toHaveLength(0);
});

test("the estimate route is 503 without a Claude CLI, 404 for a task that is not there, and 502 when Claude fails", async () => {
  setClaudeAvailability(() => false);
  expect((await estimate()).status).toBe(503);
  expect(fakes).toHaveLength(0);

  setClaudeAvailability(() => true);
  expect((await estimate("tasks/nope.md")).status).toBe(404);
  expect(fakes).toHaveLength(0);

  answer = {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    errors: ["ran out of turns"],
  } as unknown as SDKMessage;
  const failed = await estimate();
  expect(failed.status).toBe(502);
  expect(((await failed.json()) as { error: string }).error).toContain("ran out of turns");

  setQueryFactory(() => {
    throw new Error("spawn failed");
  });
  const thrown = await estimate();
  expect(thrown.status).toBe(502);
  expect(((await thrown.json()) as { error: string }).error).toContain("spawn failed");
});

test("a turn the API refused carries its own words", async () => {
  answer = {
    ...(success("Failed to authenticate. API Error: 401 Invalid bearer token") as object),
    is_error: true,
  } as SDKMessage;
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
  expect(minutesFromResult(success("I'd say 45 minutes.") as never)).toBe(45);
  expect(minutesFromResult(success("", { minutes: 120 }) as never)).toBe(120);
  expect(minutesFromResult(success("0") as never)).toBeNull();
  expect(minutesFromResult(success("99999") as never)).toBeNull();
});

test("Claude exiting without an answer is 502, and the prompt asks for minutes only", async () => {
  answer = null;
  const res = await estimate();
  expect(res.status).toBe(502);
  expect(((await res.json()) as { error: string }).error).toContain("without an answer");
  expect(estimatePrompt({ name: "Ship v2", body: "" })).toContain("(no further description)");
  expect(estimatePrompt({ name: "", body: "x" })).toContain("Task: (untitled)");
});

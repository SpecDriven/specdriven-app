// Automates specs/app/extract-specs-from-code.feature.md: the specs of a new
// specification folder drafted in the background, a folder at a time —
// each answer written as a feature of proposed scenarios — with the
// progress the page polls, cancel, retry of what failed, and a run the app
// was closed on resumed by hand. The agent is a fake one-shot provider.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agents } from "../src/plugins/host/agents";
import type { OneShotRequest, OneShotResult } from "../src/plugins/host/agents";
import { handleApi, reloader } from "../src/server/api";
import {
  cancelExtraction,
  dismissExtraction,
  extractionOf,
  extractionSettled,
  interruptExtractions,
  NO_AGENT,
  resetExtractions,
  retryExtraction,
  startExtraction,
  WAS_CLOSED,
} from "../src/server/intentExtraction";
import { DRAFT_SYSTEM_PROMPT } from "../src/server/intentDraft";
import { DRAFT_INSTRUCTIONS, DRAFT_RULES, MAX_INSTRUCTIONS_CHARS } from "../src/server/intentDraftPrompt";
import { EXTRACT_PROMPT_FILE } from "../src/server/intentPromptFile";
import { parseFeature } from "../src/server/parser";
import { writeState } from "../src/server/state";
import { fakeProvider } from "./helpers/fakeAgent";

let root: string;
let code: string;
let data: string;
let dispose: (() => void) | null = null;
let asked: OneShotRequest[] = [];
/** What the agent does with a turn; the default drafts one scenario from the module named in the prompt. */
let turn: (req: OneShotRequest) => Promise<OneShotResult>;
const real = { ...process.env };

const put = async (dir: string, path: string, text = "") => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), text);
};

const call = async (method: string, path: string, body?: unknown) => {
  const res = (await handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  ))!;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const moduleOf = (req: OneShotRequest) => /^Module: (.+?)(?: \(|$)/m.exec(req.prompt)?.[1] ?? "?";
const fileIn = (req: OneShotRequest) => /^=== (.+) ===$/m.exec(req.prompt)?.[1] ?? "";
const drafted = (req: OneShotRequest, title = `${moduleOf(req)} behaviour`): OneShotResult => {
  const structured = {
    title,
    description: `What ${moduleOf(req)} does.`,
    scenarios: [{ name: `${moduleOf(req)} answers`, body: "- Given: a request\n- Then: an answer", files: [fileIn(req)] }],
    skipped: "",
  };
  return { text: JSON.stringify(structured), structured, isError: false };
};

function registerAgent(): () => void {
  const { provider } = fakeProvider({
    id: "claude",
    label: "Claude",
    rank: 10,
    capabilities: { oneShot: true },
    oneShot: async (req) => {
      asked.push(req);
      return turn(req);
    },
  });
  return agents.register(provider);
}

const folders = [
  { folder: "api", name: "API", modules: ["packages/api"], draft: true },
  { folder: "web", name: "Web", modules: ["packages/web"], draft: true },
  { folder: "group", name: "Group", modules: [], draft: false },
];

const start = async (body: Record<string, unknown> = {}) => call("POST", "/api/extract/draft", { folders, ...body });
const status = async () => (await call("GET", "/api/extract/draft")).body;
const states = (job: any) => Object.fromEntries(job.folders.map((f: any) => [f.folder, f.state]));
const features = async (folder: string) => (await readdir(join(data, "specs", folder))).filter((f) => f.endsWith(".feature.md")).sort();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-extraction-"));
  await mkdir(join(root, "app"), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  process.env.SPECDRIVEN_ROOT = join(root, "app");
  process.env.SPECDRIVEN_HOME = join(root, "home");
  delete process.env.SPECDRIVEN_HOSTED;
  delete process.env.DEMO_MODE;
  await writeState({}, join(root, "app"));
  code = join(root, "work", "shop");
  await put(code, "package.json", '{"name":"shop","workspaces":["packages/*"]}');
  await put(code, "packages/api/package.json", '{"name":"api"}');
  await put(code, "packages/api/src/server.ts", "export const port = 8080; // the api listens here\n");
  await put(code, "packages/web/package.json", '{"name":"web"}');
  await put(code, "packages/web/src/App.tsx", "export const App = () => 'storefront';\n");
  const made = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders });
  data = made.body.dir;
  await writeState({ dataRepo: data }, join(root, "app"));
  asked = [];
  turn = async (req) => drafted(req);
  dispose = registerAgent();
});

afterEach(async () => {
  resetExtractions();
  reloader.stop();
  dispose?.();
  dispose = null;
  await rm(root, { recursive: true, force: true });
  for (const name of ["SPECDRIVEN_ROOT", "SPECDRIVEN_HOME", "SPECDRIVEN_HOSTED", "DEMO_MODE"]) {
    if (real[name] === undefined) delete process.env[name];
    else process.env[name] = real[name];
  }
});

describe("drafting", () => {
  test("each chosen folder gets a feature of proposed scenarios drafted from its code", async () => {
    const started = await start({ agent: "claude", model: "claude-sonnet-4-6" });
    expect(started.status).toBe(202);
    expect(started.body.job.state).toBe("running");
    // A folder that only holds others is not drafted.
    expect(started.body.job.folders.map((f: any) => f.folder)).toEqual(["api", "web"]);
    await extractionSettled(data);

    const { job, published } = await status();
    expect(published).toBe(false);
    expect(job.state).toBe("done");
    expect(job.agentLabel).toBe("Claude");
    expect(states(job)).toEqual({ api: "done", web: "done" });
    expect(job.folders[0].batches[0]).toMatchObject({
      state: "done",
      fileName: "specs/api/api-behaviour.feature.md",
      title: "API behaviour",
      scenarios: 1,
    });

    const text = await readFile(join(data, "specs/api/api-behaviour.feature.md"), "utf8");
    expect(text).toContain("_Extracted from `packages/api`._");
    expect(text).toContain("_Source: `packages/api/src/server.ts`._");
    expect(parseFeature(text).scenarios.map((s) => [s.name, s.status])).toEqual([["API answers", "proposed"]]);
    expect(await features("web")).toEqual(["web-behaviour.feature.md"]);

    // One turn a folder, in order, each shown its own code — from the specs folder, not the project.
    expect(asked.map(moduleOf)).toEqual(["API", "Web"]);
    expect(asked[0]!.cwd).toBe(data);
    expect(asked[0]!.model).toBe("claude-sonnet-4-6");
    expect(asked[0]!.schema).toBeDefined();
    expect(asked[0]!.prompt).toContain("=== packages/api/src/server.ts ===\nexport const port = 8080; // the api listens here");
    expect(asked[0]!.prompt).not.toContain("App.tsx");
    expect(asked[0]!.prompt).toContain("Project: shop");
  });

  test("an answer with no scenarios leaves the folder empty, with the agent's reason", async () => {
    turn = async (req) =>
      moduleOf(req) === "Web"
        ? { text: "", structured: { title: "", description: "", scenarios: [], skipped: "Only a constant." }, isError: false }
        : drafted(req);
    await start();
    await extractionSettled(data);
    const { job } = await status();
    expect(job.state).toBe("done");
    expect(states(job)).toEqual({ api: "done", web: "empty" });
    expect(job.folders[1].batches[0]).toMatchObject({ state: "empty", note: "Only a constant." });
    expect(await features("web")).toEqual([]);
  });

  test("a title already taken in the folder gets a number", async () => {
    await put(data, "specs/api/api-behaviour.feature.md", "# API behaviour\n");
    await start();
    await extractionSettled(data);
    expect(await features("api")).toEqual(["api-behaviour-2.feature.md", "api-behaviour.feature.md"]);
    expect(await readFile(join(data, "specs/api/api-behaviour-2.feature.md"), "utf8")).toContain("# API behaviour (2)");
  });

  test("a folder that fails is retried on its own; what was drafted is not drafted again", async () => {
    turn = async (req) => (moduleOf(req) === "Web" ? { text: "rate limited", isError: true } : drafted(req));
    await start();
    await extractionSettled(data);
    let { job } = await status();
    expect(job.state).toBe("done");
    expect(states(job)).toEqual({ api: "done", web: "failed" });
    expect(job.folders[1].error).toBe("rate limited");
    expect(await features("web")).toEqual([]);

    turn = async (req) => drafted(req);
    const retried = await call("POST", "/api/extract/draft/retry", { folder: "web" });
    expect(retried.status).toBe(202);
    await extractionSettled(data);
    ({ job } = await status());
    expect(states(job)).toEqual({ api: "done", web: "done" });
    expect(asked.map(moduleOf)).toEqual(["API", "Web", "Web"]);
    expect(await features("api")).toEqual(["api-behaviour.feature.md"]);
    // With everything drafted there is nothing to retry.
    expect((await call("POST", "/api/extract/draft/retry", {})).status).toBe(409);
  });

  test("an answer that is not a draft fails the folder with the agent named", async () => {
    turn = async () => ({ text: "Sorry, I cannot help with that.", isError: false });
    await start();
    await extractionSettled(data);
    const { job } = await status();
    expect(job.folders[0].error).toBe("Claude did not answer with a title and scenarios");
  });
});

describe("the drafting prompt", () => {
  const promptFile = () => join(data, EXTRACT_PROMPT_FILE);
  const saved = async () => readFile(promptFile(), "utf8").catch(() => null);

  test("without instructions the agent is told the built-in prompt, and the folder keeps no file", async () => {
    await start();
    await extractionSettled(data);
    expect(asked.map((req) => req.systemPrompt)).toEqual([DRAFT_SYSTEM_PROMPT, DRAFT_SYSTEM_PROMPT]);
    expect((await status()).job.instructions).toBeUndefined();
    expect(await saved()).toBeNull();
  });

  test("instructions sent with the request are what the agent is told, with the app's rules after them, and are kept in the folder", async () => {
    const started = await start({ instructions: "  Write every scenario in German.  " });
    expect(started.status).toBe(202);
    expect(started.body.job.instructions).toBe("Write every scenario in German.");
    await extractionSettled(data);
    expect(asked).toHaveLength(2);
    for (const req of asked) expect(req.systemPrompt).toBe(`Write every scenario in German.\n\n${DRAFT_RULES}`);
    // The files still arrive in the turn itself, as before.
    expect(asked[0]!.prompt).toContain("=== packages/api/src/server.ts ===");
    expect(await saved()).toBe("Write every scenario in German.\n");
  });

  test("a folder's own prompt is used when the request sends none", async () => {
    await writeFile(promptFile(), "Name every scenario as a question.\n");
    await start();
    await extractionSettled(data);
    expect(asked[0]!.systemPrompt).toBe(`Name every scenario as a question.\n\n${DRAFT_RULES}`);
    expect(await saved()).toBe("Name every scenario as a question.\n");
  });

  test("the built-in instructions sent with the request take the folder's file away", async () => {
    await writeFile(promptFile(), "Name every scenario as a question.\n");
    const started = await start({ instructions: DRAFT_INSTRUCTIONS });
    expect(started.body.job.instructions).toBeUndefined();
    await extractionSettled(data);
    expect(asked[0]!.systemPrompt).toBe(DRAFT_SYSTEM_PROMPT);
    expect(await saved()).toBeNull();
  });

  test("a retry asks as the run began, whatever the folder's file says by then", async () => {
    turn = async (req) => (moduleOf(req) === "Web" ? { text: "rate limited", isError: true } : drafted(req));
    await start({ instructions: "Write every scenario in German." });
    await extractionSettled(data);
    await writeFile(promptFile(), "Something else entirely.\n");

    turn = async (req) => drafted(req);
    await call("POST", "/api/extract/draft/retry", { folder: "web" });
    await extractionSettled(data);
    expect(asked.map(moduleOf)).toEqual(["API", "Web", "Web"]);
    expect(asked[2]!.systemPrompt).toBe(`Write every scenario in German.\n\n${DRAFT_RULES}`);
  });

  test("a prompt that is too long or not text is refused, and nothing is drafted or saved", async () => {
    expect((await start({ instructions: "x".repeat(MAX_INSTRUCTIONS_CHARS + 1) })).status).toBe(400);
    const notText = await start({ instructions: 7 });
    expect(notText.status).toBe(400);
    expect(notText.body.error).toBe("The prompt must be text");
    expect((await status()).job).toBeNull();
    expect(await saved()).toBeNull();
    expect(asked).toEqual([]);
  });

  test("the wizard is told a folder's own prompt before anything is made, and null where there is none", async () => {
    expect((await call("POST", "/api/extract/prompt", { folder: data })).body).toEqual({ saved: null });
    await writeFile(promptFile(), "Name every scenario as a question.\n");
    expect((await call("POST", "/api/extract/prompt", { folder: data })).body).toEqual({ saved: "Name every scenario as a question." });
    expect((await call("POST", "/api/extract/prompt", { folder: "https://github.com/acme/specs-shop" })).body).toEqual({ saved: null });
    expect((await call("POST", "/api/extract/prompt", {})).body).toEqual({ saved: null });
  });
});

describe("cancel and resume", () => {
  /** An agent that answers the first folder, then waits until the turn is aborted. */
  function hangOnSecond() {
    let hanging: (() => void) | null = null;
    const reached = new Promise<void>((resolve) => (hanging = resolve));
    turn = (req) =>
      moduleOf(req) === "API"
        ? Promise.resolve(drafted(req))
        : new Promise((_, reject) => {
            hanging?.();
            req.signal?.addEventListener("abort", () => reject(new Error("did not answer in time")));
          });
    return reached;
  }

  test("cancel abandons the turn in flight; resume takes up what was not done", async () => {
    const reached = hangOnSecond();
    await start();
    await reached;
    expect(states((await status()).job)).toEqual({ api: "done", web: "running" });
    expect((await start()).status).toBe(409);
    expect((await call("DELETE", "/api/extract/draft")).status).toBe(409);

    const cancelling = await call("POST", "/api/extract/draft/cancel");
    expect(cancelling.body.job.state).toBe("cancelling");
    await extractionSettled(data);
    let { job } = await status();
    expect(job.state).toBe("cancelled");
    expect(states(job)).toEqual({ api: "done", web: "cancelled" });
    expect(job.folders[1].error).toBeUndefined();

    turn = async (req) => drafted(req);
    await call("POST", "/api/extract/draft/retry", {});
    await extractionSettled(data);
    ({ job } = await status());
    expect(job.state).toBe("done");
    expect(states(job)).toEqual({ api: "done", web: "done" });
  });

  test("a run the app is closed on shows as interrupted on the next start, and is resumed by hand", async () => {
    const reached = hangOnSecond();
    await start();
    await reached;
    await interruptExtractions();
    // The next start: nothing in memory, only the record under the app's home.
    resetExtractions();
    let { job } = await status();
    expect(job.state).toBe("interrupted");
    expect(job.problem).toBe(WAS_CLOSED);
    expect(states(job)).toEqual({ api: "done", web: "pending" });
    expect(asked).toHaveLength(2);
    // The record is on this device, not in the specification folder.
    expect(await readdir(join(root, "home", "extractions"))).toHaveLength(1);
    expect((await readdir(data)).sort()).toEqual([".specdriven", "README.md", "project-settings.yaml", "specs"]);

    turn = async (req) => drafted(req);
    await call("POST", "/api/extract/draft/retry", {});
    await extractionSettled(data);
    ({ job } = await status());
    expect(job.state).toBe("done");
    expect(asked.map(moduleOf)).toEqual(["API", "Web", "Web"]);
  });

  test("with no agent the run waits, interrupted, and goes on once one is there", async () => {
    dispose?.();
    dispose = null;
    await start();
    await extractionSettled(data);
    let { job } = await status();
    expect(job.state).toBe("interrupted");
    expect(job.problem).toBe(NO_AGENT);
    expect(states(job)).toEqual({ api: "pending", web: "pending" });

    dispose = registerAgent();
    await call("POST", "/api/extract/draft/retry", {});
    await extractionSettled(data);
    ({ job } = await status());
    expect(states(job)).toEqual({ api: "done", web: "done" });
  });

  test("a finished run is dismissed; its features stay", async () => {
    await start();
    await extractionSettled(data);
    expect((await call("DELETE", "/api/extract/draft")).body.job).toBeNull();
    expect((await status()).job).toBeNull();
    expect(await features("api")).toEqual(["api-behaviour.feature.md"]);
    expect((await call("POST", "/api/extract/draft/retry", {})).status).toBe(404);
  });
});

describe("the run, apart from the routes", () => {
  const chosen = [{ folder: "api", name: "API", modules: ["packages/api"], draft: true }];

  test("what is asked of it is a copy, so nothing a caller does to the answer reaches the run", async () => {
    const started = await startExtraction({ dataDir: data, codeDir: code, folders: chosen });
    started.folders.length = 0;
    started.state = "done";
    await extractionSettled(data);
    const job = (await extractionOf(data))!;
    expect(job.project).toBe("shop");
    expect(states(job)).toEqual({ api: "done" });
    expect(job.folders[0]!.roots).toEqual(["packages/api"]);
  });

  test("a folder with nothing an agent could be shown is empty from the start, and no turn is spent on it", async () => {
    await rm(join(code, "packages/api/src/server.ts"));
    await put(code, "packages/api/config.yaml", "port: 8080\n");
    await startExtraction({ dataDir: data, codeDir: code, folders: chosen });
    await extractionSettled(data);
    const job = (await extractionOf(data))!;
    expect(job.state).toBe("done");
    expect(job.folders[0]).toMatchObject({ state: "empty", batches: [] });
    expect(asked).toHaveLength(0);
  });

  test("cancel, retry and dismiss on a folder that has no run", async () => {
    expect(await extractionOf(data)).toBeNull();
    expect(await cancelExtraction(data)).toBeNull();
    await expect(retryExtraction(data)).rejects.toThrow("No specs were being drafted for this folder");
    await dismissExtraction(data);
    expect(await extractionOf(data)).toBeNull();
  });

  test("a retry that names a folder with nothing left says so", async () => {
    await startExtraction({ dataDir: data, codeDir: code, folders: chosen });
    await extractionSettled(data);
    await expect(retryExtraction(data, "api")).rejects.toThrow("Nothing is left to draft in api");
    await expect(retryExtraction(data)).rejects.toThrow("Nothing is left to draft");
  });
});

describe("a specification folder that describes several projects", () => {
  let other: string;
  beforeEach(async () => {
    other = join(root, "work", "other");
    await put(other, "package.json", '{"name":"other"}');
    await put(other, "src/main.ts", "export const other = true;\n");
    await writeFile(join(data, "project-settings.yaml"), "members: []\ncode-repos:\n  - ../other\n  - ../shop\n");
  });

  test("specs are drafted from the project the request names, not the folder's default one", async () => {
    expect((await start({ codeDir: code })).status).toBe(202);
    await extractionSettled(data);
    const { job } = await status();
    expect(job.codeDir).toBe(code);
    expect(states(job)).toEqual({ api: "done", web: "done" });
    expect(asked[0]!.prompt).toContain("Project: shop");
  });

  test("without a name the default one is read, and its code is not the other's", async () => {
    // The folders name code the default project does not have.
    const res = await start();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("api names code the project does not have: packages/api");
  });

  test("a project that is not one of the folder's is not read", async () => {
    const stray = join(root, "work", "stray");
    await put(stray, "main.py", "print(1)\n");
    const res = await start({ codeDir: stray });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`${stray} is not one of this folder's code repositories`);
  });

  test("nothing is drafted into a folder other than the one the folders were made in", async () => {
    const res = await start({ codeDir: code, specsDir: join(root, "work", "specs-elsewhere") });
    expect(res.status).toBe(409);
    expect((await status()).job).toBeNull();
    expect((await start({ codeDir: code, specsDir: data })).status).toBe(202);
    await extractionSettled(data);
  });
});

describe("what the routes refuse", () => {
  test("folders that draw on code the project does not have, and a model that is not a name", async () => {
    expect((await start({ folders: [{ folder: "x", name: "X", modules: ["nowhere"], draft: true }] })).status).toBe(400);
    expect((await start({ model: "--dangerous flag" })).body.error).toBe("Not a model name");
    expect((await status()).job).toBeNull();
  });

  test("a folder that names no code repository", async () => {
    await writeFile(join(data, "project-settings.yaml"), "members: []\ncode-repos: []\n");
    const res = await start();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("This folder names no code repository in its project settings");
  });

  test("the demo", async () => {
    process.env.DEMO_MODE = "1";
    expect((await call("GET", "/api/extract/draft")).status).toBe(403);
  });
});

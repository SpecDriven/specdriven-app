// Automates specs/app/extract-specs-from-code.feature.md "Tests are linked
// in a pass of their own" and "Tests are linked later, on their own": the
// background run that links a code project's existing tests to the
// scenarios extracted from it — after the drafting, in the same run, or as
// a run of its own over features drafted before — with the links the app
// builds, cancel, retry, and the refusals. The agent is a fake one-shot
// provider that answers drafting turns and linking turns apart.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agents } from "../src/plugins/host/agents";
import type { OneShotRequest, OneShotResult } from "../src/plugins/host/agents";
import { handleApi, reloader } from "../src/server/api";
import { createFeature } from "../src/server/features";
import { extractionSettled, NO_AGENT, resetExtractions, startLinking } from "../src/server/intentExtraction";
import { LINK_SCHEMA, LINK_SYSTEM_PROMPT, MAX_LISTED_TESTS } from "../src/server/intentTestLinks";
import { NO_GITHUB_REMOTE } from "../src/server/intentTestUrl";
import { parseFeature, parseTestRef } from "../src/server/parser";
import { writeState } from "../src/server/state";
import { progressLabel } from "../src/frontend/extractSpecs";
import { fakeProvider } from "./helpers/fakeAgent";

let root: string;
let code: string;
let data: string;
let dispose: (() => void) | null = null;
let asked: OneShotRequest[] = [];
/** What the agent answers a linking turn with; the default links every scenario to the first test listed. */
let linkTurn: (req: OneShotRequest) => Promise<OneShotResult>;
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

const isLinking = (req: OneShotRequest) => req.systemPrompt === LINK_SYSTEM_PROMPT;
const moduleOf = (req: OneShotRequest) => /^Module: (.+?)(?: \(|$)/m.exec(req.prompt)?.[1] ?? "?";
const sourceIn = (req: OneShotRequest) => [...req.prompt.matchAll(/^=== (.+) ===$/gm)].map((m) => m[1]!);
const drafted = (req: OneShotRequest): OneShotResult => {
  const structured = {
    title: `${moduleOf(req)} behaviour`,
    description: `What ${moduleOf(req)} does.`,
    scenarios: [
      { name: `${moduleOf(req)} answers`, body: "- Given: a request\n- Then: an answer", files: sourceIn(req) },
      { name: `${moduleOf(req)} refuses`, body: "- Given: a bad request\n- Then: an error", files: sourceIn(req) },
    ],
    skipped: "",
  };
  return { text: JSON.stringify(structured), structured, isError: false };
};
/** The tests a linking turn lists, as `[id, path, name]`. */
const listed = (req: OneShotRequest) => [...req.prompt.matchAll(/^(T\d+) (\S+) — (.+)$/gm)].map((m) => [m[1]!, m[2]!, m[3]!] as const);
const linked = (links: { scenario: string; tests: string[] }[]): OneShotResult => ({
  text: JSON.stringify({ links }),
  structured: { links },
  isError: false,
});

const folders = [
  { folder: "api", name: "API", modules: ["packages/api"], draft: true },
  { folder: "web", name: "Web", modules: ["packages/web"], draft: true },
];

const draft = async (body: Record<string, unknown> = {}) => call("POST", "/api/extract/draft", { folders, ...body });
const link = async (body: Record<string, unknown> = {}) => call("POST", "/api/extract/tests", body);
const status = async () => (await call("GET", "/api/extract/draft")).body;
const feature = async (fileName: string) => parseFeature(await readFile(join(data, fileName), "utf8"));
const testsOf = async (fileName: string) => (await feature(fileName)).scenarios.map((s) => s.tests.map(parseTestRef));
const github = async (dir: string, url = "https://github.com/acme/shop.git") => put(dir, ".git/config", `[remote "origin"]\n\turl = ${url}\n`);

const API_TEST = [
  'import { test, expect } from "bun:test";',
  "",
  'test("answers on its port", () => {',
  "  expect(1).toBe(1);",
  "});",
  "",
  'test("refuses a bad request", () => {',
  "  expect(2).toBe(2);",
  "});",
  "",
].join("\n");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-linking-"));
  await mkdir(join(root, "app"), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  process.env.SPECDRIVEN_ROOT = join(root, "app");
  process.env.SPECDRIVEN_HOME = join(root, "home");
  delete process.env.SPECDRIVEN_HOSTED;
  delete process.env.DEMO_MODE;
  await writeState({}, join(root, "app"));
  code = join(root, "work", "shop");
  await github(code);
  await put(code, "package.json", '{"name":"shop","workspaces":["packages/*"]}');
  await put(code, "packages/api/package.json", '{"name":"api"}');
  await put(code, "packages/api/src/server.ts", "export const port = 8080; // the api listens here\n");
  await put(code, "packages/api/src/server.test.ts", API_TEST);
  await put(code, "packages/web/package.json", '{"name":"web"}');
  await put(code, "packages/web/src/App.tsx", "export const App = () => 'storefront';\n");
  const made = await call("POST", "/api/extract/repo", { codeDir: code, name: "specs-shop", folders });
  data = made.body.dir;
  await writeState({ dataRepo: data }, join(root, "app"));
  asked = [];
  linkTurn = async (req) => linked([{ scenario: "S1", tests: [listed(req)[0]![0]] }]);
  const { provider } = fakeProvider({
    id: "claude",
    label: "Claude",
    rank: 10,
    capabilities: { oneShot: true },
    oneShot: async (req) => {
      asked.push(req);
      return isLinking(req) ? linkTurn(req) : drafted(req);
    },
  });
  dispose = agents.register(provider);
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

describe("linking in the same run as the drafting", () => {
  test("a run asked to link tests goes on to link them once the specs are drafted", async () => {
    linkTurn = async (req) =>
      linked([
        { scenario: "S1", tests: ["T1"] },
        { scenario: "S2", tests: ["T2"] },
      ]);
    expect((await draft({ tests: true, model: "claude-haiku-4-5" })).status).toBe(202);
    await extractionSettled(data);

    const { job } = await status();
    expect(job.state).toBe("done");
    expect(job.tests).toEqual({ base: "https://github.com/acme/shop/blob/main/", repo: "acme/shop" });
    // Both folders are drafted first; then each written feature gets its turn.
    expect(asked.map(isLinking)).toEqual([false, false, true]);
    const api = job.folders.find((f: any) => f.folder === "api");
    expect(api.links).toEqual([{ fileName: "specs/api/api-behaviour.feature.md", title: "API behaviour", state: "done", linked: 2 }]);
    expect(await testsOf("specs/api/api-behaviour.feature.md")).toEqual([
      [{ name: "answers on its port", url: "https://github.com/acme/shop/blob/main/packages/api/src/server.test.ts#L3" }],
      [{ name: "refuses a bad request", url: "https://github.com/acme/shop/blob/main/packages/api/src/server.test.ts#L7" }],
    ]);
    // The linking turn runs on the model the run was given.
    expect(asked[2]!.model).toBe("claude-haiku-4-5");
    expect(progressLabel(job)).toBe("Specs drafted — 2 features, 2 tests linked");
  });

  test("the agent is shown the scenarios and the tests by id and never asked for a url", async () => {
    await draft({ tests: true });
    await extractionSettled(data);
    const turn = asked.find(isLinking)!;
    expect(turn.cwd).toBe(data);
    expect(turn.schema).toBe(LINK_SCHEMA);
    expect(turn.prompt).toContain("Feature: API behaviour");
    expect(turn.prompt).toContain("S1: API answers");
    expect(turn.prompt).toContain("=== packages/api/src/server.test.ts ===");
    expect(listed(turn)).toEqual([
      ["T1", "packages/api/src/server.test.ts", "answers on its port"],
      ["T2", "packages/api/src/server.test.ts", "refuses a bad request"],
    ]);
    expect(turn.prompt).not.toContain("github.com");
  });

  test("a feature whose code has no tests is passed over without a turn", async () => {
    await draft({ tests: true });
    await extractionSettled(data);
    const { job } = await status();
    const web = job.folders.find((f: any) => f.folder === "web");
    expect(web.links).toEqual([{ fileName: "specs/web/web-behaviour.feature.md", title: "Web behaviour", state: "empty", note: "its code has no tests" }]);
    expect(asked.filter(isLinking)).toHaveLength(1);
    expect(await testsOf("specs/web/web-behaviour.feature.md")).toEqual([[], []]);
  });

  test("a project with no repository on github.com is drafted and says why its tests are not linked", async () => {
    await github(code, "https://git.example.com/acme/shop.git");
    await draft({ tests: true });
    await extractionSettled(data);
    const { job } = await status();
    expect(job.state).toBe("done");
    expect(job.tests).toBeUndefined();
    expect(job.testsProblem).toBe(NO_GITHUB_REMOTE);
    expect(asked.some(isLinking)).toBe(false);
    expect(progressLabel(job)).toBe("Specs drafted — 2 features");
  });

  test("a run not asked to link tests asks no linking turn", async () => {
    await draft();
    await extractionSettled(data);
    const { job } = await status();
    expect(job.tests).toBeUndefined();
    expect(job.folders.every((f: any) => f.links === undefined)).toBe(true);
    expect(asked.some(isLinking)).toBe(false);
  });

  test("a failed linking turn leaves the drafted feature and is retried on its own", async () => {
    let fail = true;
    linkTurn = async (req) => (fail ? { text: "overloaded", isError: true } : linked([{ scenario: "S2", tests: ["T2"] }]));
    await draft({ tests: true });
    await extractionSettled(data);
    let { job } = await status();
    expect(job.state).toBe("done");
    expect(job.folders[0].state).toBe("done");
    expect(job.folders[0].links[0]).toMatchObject({ state: "failed", error: "overloaded" });
    expect(progressLabel(job)).toBe("Specs drafted — linking failed for 1 feature");

    fail = false;
    const drafts = asked.filter((r) => !isLinking(r)).length;
    expect((await call("POST", "/api/extract/draft/retry", {})).status).toBe(202);
    await extractionSettled(data);
    ({ job } = await status());
    expect(job.folders[0].links[0]).toMatchObject({ state: "done", linked: 1 });
    // Nothing is drafted again.
    expect(asked.filter((r) => !isLinking(r))).toHaveLength(drafts);
    expect((await testsOf("specs/api/api-behaviour.feature.md"))[1]).toHaveLength(1);
  });
});

describe("linking later, as a run of its own", () => {
  const draftedOnly = async () => {
    await draft();
    await extractionSettled(data);
    asked = [];
  };

  test("the features extracted before get their tests linked", async () => {
    await draftedOnly();
    const started = await link({ agent: "claude" });
    expect(started.status).toBe(202);
    expect(started.body.job.kind).toBe("link");
    // Each folder by the name the sidebar gives it, with the features to link.
    expect(started.body.job.folders.map((f: any) => [f.folder, f.name, f.links.map((l: any) => l.title)])).toEqual([
      ["api", "API", ["API behaviour"]],
      ["web", "Web", ["Web behaviour"]],
    ]);
    await extractionSettled(data);

    const { job } = await status();
    expect(job.state).toBe("done");
    expect(Object.fromEntries(job.folders.map((f: any) => [f.folder, f.state]))).toEqual({ api: "done", web: "empty" });
    expect(asked.every(isLinking)).toBe(true);
    expect((await testsOf("specs/api/api-behaviour.feature.md"))[0]).toEqual([
      { name: "answers on its port", url: "https://github.com/acme/shop/blob/main/packages/api/src/server.test.ts#L3" },
    ]);
    expect(progressLabel(job)).toBe("Tests linked — 1 link");
  });

  test("linking again adds no link a scenario already has", async () => {
    await draftedOnly();
    await link();
    await extractionSettled(data);
    const before = await readFile(join(data, "specs/api/api-behaviour.feature.md"), "utf8");
    await link();
    await extractionSettled(data);
    const { job } = await status();
    expect(job.folders[0].links[0]).toMatchObject({ state: "empty", note: "its tests are linked already" });
    expect(await readFile(join(data, "specs/api/api-behaviour.feature.md"), "utf8")).toBe(before);
  });

  test("a feature that was not extracted from code is left alone", async () => {
    await draftedOnly();
    await createFeature(data, "api/Written by hand", "# Written by hand\n\n## S1: Something @v1 [proposed]\n\n- Given: a thing\n");
    const started = await link();
    expect(started.body.job.folders.flatMap((f: any) => f.links.map((l: any) => l.fileName))).toEqual([
      "specs/api/api-behaviour.feature.md",
      "specs/web/web-behaviour.feature.md",
    ]);
  });

  test("only one folder's features are linked when a folder is named", async () => {
    await draftedOnly();
    const started = await startLinking({ dataDir: data, codeDir: code, folder: "web" });
    expect(started.kind).toBe("link");
    expect(started.folders.map((f) => f.folder)).toEqual(["web"]);
    await extractionSettled(data);
    expect(asked).toHaveLength(0);
  });

  test("a feature with more tests than one turn lists is shown the first of them", async () => {
    const many = Array.from({ length: MAX_LISTED_TESTS + 25 }, (_, i) => `test("case ${i + 1}", () => {});`).join("\n");
    await put(code, "packages/api/src/many.test.ts", `import { test } from "bun:test";\n${many}\n`);
    await draftedOnly();
    await link({ folder: "api" });
    await extractionSettled(data);
    const shown = listed(asked[0]!);
    expect(shown).toHaveLength(MAX_LISTED_TESTS);
    expect(shown.at(-1)![0]).toBe(`T${MAX_LISTED_TESTS}`);
  });

  test("a link the agent gives for a scenario removed during the turn is not written", async () => {
    await draftedOnly();
    linkTurn = async () => {
      await rm(join(data, "specs/api/api-behaviour.feature.md"));
      return linked([{ scenario: "S1", tests: ["T1"] }]);
    };
    await link({ folder: "api" });
    await extractionSettled(data);
    const { job } = await status();
    expect(job.folders[0].links[0]).toMatchObject({ state: "empty", note: "the feature is not there any more" });
  });

  test("a run that is cancelled stops linking and resumes where it stopped", async () => {
    await draftedOnly();
    let hanging!: () => void;
    const reached = new Promise<void>((resolve) => (hanging = resolve));
    linkTurn = (req) =>
      new Promise((_, reject) => {
        hanging();
        req.signal?.addEventListener("abort", () => reject(new Error("did not answer in time")));
      });
    await link({ folder: "api" });
    await reached;
    expect((await status()).job.folders[0].links[0].state).toBe("running");
    const cancelling = await call("POST", "/api/extract/draft/cancel");
    expect(cancelling.body.job.state).toBe("cancelling");
    await extractionSettled(data);
    let { job } = await status();
    expect(job.state).toBe("cancelled");
    expect(job.folders[0]).toMatchObject({ state: "cancelled" });
    expect(job.folders[0].links[0].state).toBe("pending");
    expect(progressLabel(job)).toBe("Linking stopped — 0 of 1 feature");

    linkTurn = async () => linked([{ scenario: "S1", tests: ["T1"] }]);
    expect((await call("POST", "/api/extract/draft/retry", {})).status).toBe(202);
    await extractionSettled(data);
    ({ job } = await status());
    expect(job.state).toBe("done");
    expect(job.folders[0].links[0]).toMatchObject({ state: "done", linked: 1 });
  });

  test("with no agent to ask the run waits and says so", async () => {
    await draftedOnly();
    dispose?.();
    dispose = null;
    await link();
    await extractionSettled(data);
    const { job } = await status();
    expect(job.state).toBe("interrupted");
    expect(job.problem).toBe(NO_AGENT);
    expect(job.folders[0].links[0].state).toBe("pending");
  });

  test("linking is refused when no feature was extracted or the project is not on github.com", async () => {
    // Nothing drafted yet: the folders are there, with no features in them.
    const none = await link();
    expect(none.status).toBe(409);
    expect(none.body.error).toBe("No feature in this folder was extracted from code");

    await draftedOnly();
    const elsewhere = await link({ folder: "nowhere" });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.error).toBe("No feature in nowhere was extracted from code");

    await github(code, "https://git.example.com/acme/shop.git");
    const noRemote = await link();
    expect(noRemote.status).toBe(409);
    expect(noRemote.body.error).toBe(NO_GITHUB_REMOTE);
  });

  test("linking is refused while specs are still being drafted", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { provider } = fakeProvider({
      id: "slow",
      label: "Slow",
      rank: 1,
      capabilities: { oneShot: true },
      oneShot: async (req) => {
        await hold;
        return drafted(req);
      },
    });
    const undo = agents.register(provider);
    try {
      await draft({ agent: "slow" });
      const refused = await link();
      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain("wait for the run to finish");
    } finally {
      release();
      await extractionSettled(data);
      undo();
    }
  });
});

describe("what the dialogs are told", () => {
  test("the analysis says whether the project's tests can be linked", async () => {
    const analysed = await call("POST", "/api/extract/analyse", { codeDir: code });
    expect(analysed.body.tests).toEqual({ files: 1, repo: "acme/shop" });
    await github(code, "https://git.example.com/acme/shop.git");
    const elsewhere = await call("POST", "/api/extract/analyse", { codeDir: code });
    expect(elsewhere.body.tests).toEqual({ files: 1, repo: null, problem: NO_GITHUB_REMOTE });
  });

  test("the open folder's repositories and extracted features are listed for linking", async () => {
    await draft();
    await extractionSettled(data);
    await createFeature(data, "api/Written by hand", "# Written by hand\n\n## S1: Something @v1 [proposed]\n\n- Given: a thing\n");
    const choices = await call("GET", "/api/extract/tests");
    expect(choices.status).toBe(200);
    expect(choices.body.repos).toEqual([{ dir: code, default: true, files: 1, repo: "acme/shop" }]);
    expect(choices.body.folders).toEqual([
      { folder: "api", features: 1 },
      { folder: "web", features: 1 },
    ]);
  });
});

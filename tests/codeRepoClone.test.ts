// Cloning a code repo that is not on this computer (src/server/codeRepoClone.ts;
// specs/app/project-settings.feature.md "A code repo that is not on this
// computer is offered for cloning"): the url suggested from the data repo's
// GitHub owner, the url handed to git, and the background job — refused over
// an existing folder, cleared when the clone lands, kept with its error and
// no half-made folder when it fails.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { writeState } from "../src/server/state";
import {
  CodeRepoCloneError,
  cloneSource,
  codeRepoCloneJob,
  resetCodeRepoClones,
  setCodeRepoCloneRunner,
  startCodeRepoClone,
  suggestedCloneUrl,
} from "../src/server/codeRepoClone";

let root: string;
let data: string;
const savedHome = process.env.SPECDRIVEN_HOME;

beforeAll(() => {
  // No real sign-in is read: the suggestion goes on the data repo's remote alone.
  process.env.SPECDRIVEN_HOME = join(tmpdir(), `specdriven-clone-home-${process.pid}`);
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.SPECDRIVEN_HOME;
  else process.env.SPECDRIVEN_HOME = savedHome;
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-code-clone-"));
  data = join(root, "acme-specs");
  await mkdir(join(data, ".git"), { recursive: true });
  resetCodeRepoClones();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const origin = (url: string) =>
  writeFile(join(data, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n`);

test("the suggested url is the data repo's GitHub owner with the code repo's folder name", async () => {
  await origin("https://github.com/acme/acme-specs.git");
  expect(await suggestedCloneUrl(data, join(root, "acme-app"))).toBe("https://github.com/acme/acme-app");
  await origin("git@github.com:acme/acme-specs.git");
  expect(await suggestedCloneUrl(data, join(root, "acme-app"))).toBe("https://github.com/acme/acme-app");
  // Nothing to go on: no remote, or one that is not GitHub.
  await writeFile(join(data, ".git", "config"), "[core]\n");
  expect(await suggestedCloneUrl(data, join(root, "acme-app"))).toBeNull();
  await origin("https://gitlab.com/acme/acme-specs.git");
  expect(await suggestedCloneUrl(data, join(root, "acme-app"))).toBeNull();
});

test("a GitHub url is cloned by its canonical url, any other url as typed", () => {
  expect(cloneSource(" https://github.com/acme/acme-app ")).toBe("https://github.com/acme/acme-app.git");
  expect(cloneSource("git@github.com:acme/acme-app.git")).toBe("https://github.com/acme/acme-app.git");
  expect(cloneSource("https://gitlab.com/acme/acme-app.git")).toBe("https://gitlab.com/acme/acme-app.git");
  expect(() => cloneSource("acme-app")).toThrow(CodeRepoCloneError);
  expect(() => cloneSource("--upload-pack=x")).toThrow(CodeRepoCloneError);
  expect(() => cloneSource("")).toThrow(CodeRepoCloneError);
});

test("the clone runs in the background and its job clears once the folder is there", async () => {
  const dir = join(root, "acme-app");
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const runs: [string, string][] = [];
  const run = async (url: string, into: string) => {
    runs.push([url, into]);
    const gate = new Promise<void>((r) => (release = r));
    started();
    await gate;
    await mkdir(join(into, ".git"), { recursive: true });
  };
  const { done } = await startCodeRepoClone(dir, "https://github.com/acme/acme-app", run);
  expect(codeRepoCloneJob(dir)).toEqual({ url: "https://github.com/acme/acme-app", state: "running" });
  // A second start while it runs is refused.
  await expect(startCodeRepoClone(dir, "https://github.com/acme/acme-app", run)).rejects.toThrow("Already cloning");
  await running;
  release();
  await done;
  expect(runs).toEqual([["https://github.com/acme/acme-app.git", dir]]);
  expect(codeRepoCloneJob(dir)).toBeUndefined();
  // Now that the folder is there, a clone never lands on it.
  const refused = await startCodeRepoClone(dir, "https://github.com/acme/acme-app", run).catch((e) => e);
  expect(refused).toBeInstanceOf(CodeRepoCloneError);
  expect((refused as CodeRepoCloneError).status).toBe(409);
});

test("a failed clone keeps its error and leaves no half-made folder behind", async () => {
  const dir = join(root, "acme-app");
  const { done } = await startCodeRepoClone(dir, "https://github.com/acme/acme-app", async (_url, into) => {
    await mkdir(into, { recursive: true });
    await writeFile(join(into, "partial"), "");
    throw new Error("Could not clone https://github.com/acme/acme-app.git: Repository not found");
  });
  await done;
  expect(codeRepoCloneJob(dir)).toEqual({
    url: "https://github.com/acme/acme-app",
    state: "failed",
    error: "Could not clone https://github.com/acme/acme-app.git: Repository not found",
  });
  expect(await readdir(root)).toEqual(["acme-specs"]);
  // A try again replaces the failed job.
  const again = await startCodeRepoClone(dir, "https://github.com/acme/acme-app", async (_url, into) => {
    await mkdir(join(into, ".git"), { recursive: true });
  });
  await again.done;
  expect(codeRepoCloneJob(dir)).toBeUndefined();
});

test("the route starts the clone, and the folder counts as missing until the clone is done", async () => {
  const savedRoot = process.env.SPECDRIVEN_ROOT;
  process.env.SPECDRIVEN_ROOT = root;
  try {
    await origin("https://github.com/acme/acme-specs.git");
    await writeFile(join(data, "project-settings.json"), JSON.stringify({ members: [], "code-repos": ["../acme-app", "../here"] }));
    await mkdir(join(root, "here"));
    await writeState({ dataRepo: data }, root);
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    setCodeRepoCloneRunner(async (_url, into) => {
      // git makes the folder first, then fills it in.
      await mkdir(into, { recursive: true });
      const gate = new Promise<void>((r) => (release = r));
      started();
      await gate;
      await mkdir(join(into, ".git"));
    });
    type Row = { path: string; exists: boolean; cloneUrl?: string | null; clone?: { state: string } };
    const call = async (method: string, path: string, body?: unknown) => {
      const res = (await handleApi(
        new Request(`http://localhost${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      ))!;
      return { status: res.status, body: (await res.json()) as { codeRepos: Row[]; canClone: boolean; error?: string } };
    };
    const app = (b: { codeRepos: Row[] }) => b.codeRepos.find((r) => r.path === "../acme-app")!;

    const before = await call("GET", "/api/project-settings");
    expect(before.body.canClone).toBe(true);
    expect(app(before.body)).toMatchObject({ exists: false, cloneUrl: "https://github.com/acme/acme-app" });

    const start = await call("POST", "/api/project-settings/clone", { codeRepo: "../acme-app", url: "https://github.com/acme/acme-app" });
    expect(start.status).toBe(200);
    expect(app(start.body)).toMatchObject({ exists: false, clone: { state: "running" } });
    await running;
    expect(app((await call("GET", "/api/project-settings")).body)).toMatchObject({ exists: false, clone: { state: "running" } });
    release();
    for (let i = 0; i < 50 && codeRepoCloneJob(join(root, "acme-app")); i++) await new Promise((r) => setTimeout(r, 10));
    const after = app((await call("GET", "/api/project-settings")).body);
    expect(after.exists).toBe(true);
    expect(after.clone).toBeUndefined();

    // Refusals: a folder that is there, a repo the project does not name, no url.
    expect((await call("POST", "/api/project-settings/clone", { codeRepo: "../here", url: "https://github.com/acme/here" })).status).toBe(409);
    expect((await call("POST", "/api/project-settings/clone", { codeRepo: "../other", url: "https://github.com/acme/other" })).status).toBe(404);
    expect((await call("POST", "/api/project-settings/clone", { codeRepo: "../acme-app" })).status).toBe(400);
  } finally {
    setCodeRepoCloneRunner();
    reloader.stop();
    if (savedRoot === undefined) delete process.env.SPECDRIVEN_ROOT;
    else process.env.SPECDRIVEN_ROOT = savedRoot;
  }
});

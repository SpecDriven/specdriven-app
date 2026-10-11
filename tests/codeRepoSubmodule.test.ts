// Automates git-operations.md "Add the spec repo to a code repo as a
// submodule": from Settings the spec repo the app has open is added to a code
// repo as a git submodule — its url the spec repo's origin, its branch the one
// the app works on — and committed there, the two paths alone and never
// pushed. The app's own clone of the spec repo is left as it was.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, matchApi, reloader } from "../src/server/api";
import { PROJECT_SETTINGS_FILE } from "../src/server/members";
import { writeState } from "../src/server/state";
import { addSpecsSubmodule, defaultSubmoduleName, SubmoduleError } from "../src/server/submodule";
import { git, seededOrigin } from "./helpers/fixtures";

let root: string;
let home: string;
let origin: string;
let data: string;
let code: string;

// Saved and restored around each test: the mode flags and PATH some tests
// change, and git's file-transport switch — local paths stand in for GitHub
// here, and `git submodule add` refuses file urls by default.
const ENV = [
  "SPECDRIVEN_ROOT",
  "SPECDRIVEN_HOME",
  "SPECDRIVEN_HOSTED",
  "DEMO_MODE",
  "PATH",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

// The preload's PATH holds git alone (helpers/binPath.ts), but `git
// submodule` is a shell script that needs a few of the system's own tools —
// which every real PATH has. Linked by absolute path, so no gh comes along.
const shellTools = mkdtempSync(join(tmpdir(), "specdriven-submodule-path-"));
for (const tool of ["basename", "dirname", "sed", "uname", "tr", "cat", "wc", "grep", "mkdir", "rm"]) {
  const found = ["/usr/bin", "/bin"].map((dir) => join(dir, tool)).find((path) => existsSync(path));
  if (found) symlinkSync(found, join(shellTools, tool));
}
const testPath = `${process.env.PATH}:${shellTools}`;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "specdriven-submodule-")));
  home = await mkdtemp(join(tmpdir(), "specdriven-submodule-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  process.env.PATH = testPath;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
  process.env.GIT_CONFIG_VALUE_0 = "always";
  origin = await seededOrigin(root, "specs-insurance.git");
  data = join(root, "specs-insurance");
  await $`git clone -q ${origin} ${data}`.quiet();
  code = join(root, "insurance-app");
  await $`git init -q -b main ${code}`.quiet();
  await git(code, "config", "user.email", "dev@example.com");
  await git(code, "config", "user.name", "Dev");
  await writeFile(join(code, "README.md"), "# Insurance app\n");
  await git(code, "add", "README.md");
  await git(code, "commit", "-m", "init");
  await writeState({ dataRepo: data }, root);
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function post(body: unknown): Promise<Response> {
  return handleApi(
    new Request("http://localhost/api/code-repo/submodule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

const out = async (dir: string, ...args: string[]) => (await git(dir, ...args)).stdout.toString().trim();

test("the route exists", () => {
  expect(matchApi("POST", "/api/code-repo/submodule")).not.toBeNull();
});

test("the spec repo is added to the code repo as a submodule on its branch, and committed", async () => {
  const dataHead = await out(data, "rev-parse", "HEAD");
  const res = await post({ codeRepo: code });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ codeRepo: code, path: "specs-insurance", url: origin, branch: "main" });

  expect(await out(code, "config", "-f", ".gitmodules", "submodule.specs-insurance.url")).toBe(origin);
  expect(await out(code, "config", "-f", ".gitmodules", "submodule.specs-insurance.branch")).toBe("main");
  // A gitlink, pinned at the spec repo's commit.
  expect(await out(code, "ls-files", "-s", "specs-insurance")).toStartWith(`160000 ${dataHead} `);
  // Committed, those two paths alone; nothing left staged.
  expect(body.commit).toBe(await out(code, "rev-parse", "HEAD"));
  expect((await out(code, "show", "--name-only", "--format=", "HEAD")).split("\n").sort()).toEqual([
    ".gitmodules",
    "specs-insurance",
  ]);
  expect(await out(code, "log", "-1", "--format=%s")).toBe("Add specs-insurance specs as a submodule");
  expect(await out(code, "status", "--porcelain")).toBe("");
  // The app's own clone is untouched.
  expect(await out(data, "rev-parse", "HEAD")).toBe(dataHead);
  expect(await out(data, "status", "--porcelain")).toBe("");
});

test("a clone of the code repo with --recurse-submodules brings the specs", async () => {
  expect((await post({ codeRepo: code })).status).toBe(200);
  const clone = join(root, "fresh");
  await $`git clone -q --recurse-submodules ${code} ${clone}`.quiet();
  expect(await Bun.file(join(clone, "specs-insurance/specs/seed.feature.md")).text()).toBe("# Seed\n");
});

test("only the submodule is committed, whatever else is staged in the code repo", async () => {
  await writeFile(join(code, "wip.ts"), "export {};\n");
  await git(code, "add", "wip.ts");
  expect((await post({ codeRepo: code })).status).toBe(200);
  expect(await out(code, "show", "--name-only", "--format=", "HEAD")).not.toContain("wip.ts");
  expect(await out(code, "status", "--porcelain")).toBe("A  wip.ts");
});

test("the folder name can be chosen, and code-repo in project-settings.json is the default code repo", async () => {
  await writeFile(join(data, PROJECT_SETTINGS_FILE), JSON.stringify({ "code-repo": "../insurance-app" }));
  const res = await post({ name: "docs/specs" });
  expect(res.status).toBe(200);
  expect((await res.json()).path).toBe("docs/specs");
  expect(await out(code, "config", "-f", ".gitmodules", "submodule.docs/specs.path")).toBe("docs/specs");
});

test("a relative code repo resolves against the spec repo, as code-repo does", async () => {
  const res = await post({ codeRepo: "../insurance-app" });
  expect(res.status).toBe(200);
  expect((await res.json()).codeRepo).toBe(code);
});

test("the refusals say what is wrong", async () => {
  const cases: [body: unknown, status: number, error: string][] = [
    [{}, 400, "Choose the code repo"],
    [{ codeRepo: join(root, "nowhere") }, 400, "Code repo not found"],
    [{ codeRepo: data }, 400, "neither inside the other"],
    [{ codeRepo: code, name: "../escape" }, 400, "Not a folder name"],
    [{ codeRepo: code, name: "README.md" }, 409, "already exists"],
  ];
  for (const [body, status, error] of cases) {
    const res = await post(body);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toContain(error);
  }
  // A plain folder, and a subfolder of a repo, are not a repo's top.
  const plain = join(root, "plain");
  await $`mkdir -p ${plain} ${join(code, "src")}`.quiet();
  for (const dir of [plain, join(code, "src")]) {
    const res = await post({ codeRepo: dir });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Not the top folder of a git repository");
  }
  expect(await out(code, "log", "--format=%s")).toBe("init");
});

test("adding the same spec repo twice is refused, under any name", async () => {
  expect((await post({ codeRepo: code })).status).toBe(200);
  const res = await post({ codeRepo: code, name: "specs-again" });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("already has this spec repo as a submodule (specs-insurance)");
});

test("a spec repo with no origin has nothing to point the submodule at", async () => {
  await git(data, "remote", "remove", "origin");
  const res = await post({ codeRepo: code });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toContain("no origin remote");
});

test("a detached spec repo records no branch", async () => {
  await git(data, "checkout", "-q", "--detach");
  const added = await addSpecsSubmodule(data, code);
  expect(added.branch).toBeNull();
  const branch = await git(code, "config", "-f", ".gitmodules", "--get", "submodule.specs-insurance.branch").catch(
    (e: Error) => e,
  );
  expect(branch).toBeInstanceOf(Error);
});

test("a failed git submodule add is reported, with nothing committed", async () => {
  await rm(origin, { recursive: true, force: true });
  const err = await addSpecsSubmodule(data, code).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SubmoduleError);
  expect((err as SubmoduleError).status).toBe(502);
  expect((err as SubmoduleError).message).toContain("git submodule add failed");
  expect(await out(code, "log", "--format=%s")).toBe("init");
});

test("refused when hosted, in the demo, and without system git", async () => {
  process.env.SPECDRIVEN_HOSTED = "1";
  expect((await post({ codeRepo: code })).status).toBe(403);
  delete process.env.SPECDRIVEN_HOSTED;

  process.env.DEMO_MODE = "1";
  const demo = await post({ codeRepo: code });
  expect(demo.status).toBe(403);
  expect((await demo.json()).error).toContain("demo mode");
  delete process.env.DEMO_MODE;

  process.env.PATH = "/nonexistent";
  const noGit = await post({ codeRepo: code });
  expect(noGit.status).toBe(501);
  expect((await noGit.json()).error).toContain("needs git installed");
});

test("the default folder name is the spec repo's name", () => {
  expect(defaultSubmoduleName("https://github.com/acme/specs-insurance.git", "/x/data")).toBe("specs-insurance");
  expect(defaultSubmoduleName("git@github.com:acme/specs-insurance.git", "/x/data")).toBe("specs-insurance");
  expect(defaultSubmoduleName("https://gitlab.example.com/acme/specs-billing.git", "/x/data")).toBe("specs-billing");
  expect(defaultSubmoduleName("/srv/git/specs-local.git", "/x/data")).toBe("specs-local");
  expect(defaultSubmoduleName("", "/x/data")).toBe("data");
});

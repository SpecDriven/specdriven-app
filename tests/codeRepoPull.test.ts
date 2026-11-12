// Automates specs/app/code-repo-mode.feature.md "Git Pull from the
// navigation pane" on the server: POST /api/files/pull runs `git pull
// --no-rebase` in the open code repository and says what it brought in, and
// refuses a dirty working tree. Real git repos in a temp folder — a bare
// "origin" cloned into the open repository and into a second clone that
// advances it.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import { run } from "../src/server/run";
import { writeState } from "../src/server/state";

let root: string;
let code: string;
let upstream: string;
const saved = {
  SPECDRIVEN_ROOT: process.env.SPECDRIVEN_ROOT,
  SPECDRIVEN_HOME: process.env.SPECDRIVEN_HOME,
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await run("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

/** Add a commit to origin through the second clone, so the open repository falls behind. */
async function advanceOrigin(file: string, body: string): Promise<void> {
  await writeFile(join(upstream, file), body);
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-q", "-m", `change ${file}`);
  await git(upstream, "push", "-q", "origin", "main");
}

function pull(): Promise<Response> {
  return handleApi(new Request("http://localhost/api/files/pull", { method: "POST" })) as Promise<Response>;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-code-pull-")));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  const seed = join(root, "seed");
  await git(root, "init", "-q", "-b", "main", "seed");
  await writeFile(join(seed, "README.md"), "hello\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-q", "-m", "first");
  await git(root, "clone", "-q", "--bare", seed, "origin");
  await git(root, "clone", "-q", "origin", "code");
  await git(root, "clone", "-q", "origin", "upstream");
  code = join(root, "code");
  upstream = join(root, "upstream");
  // The pull runs with no `-c user.*`; CI git has no global identity.
  await git(code, "config", "user.name", "T");
  await git(code, "config", "user.email", "t@example.com");
  await writeState({ openCodeRepo: code, reloadFrequencySeconds: 0 }, root);
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("Git Pull brings the open repository level with origin and says how many commits it pulled", async () => {
  await advanceOrigin("a.txt", "a\n");
  await advanceOrigin("b.txt", "b\n");
  const res = await pull();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; pulled?: number; branch?: string };
  expect(body).toMatchObject({ ok: true, pulled: 2, branch: "main" });
  expect(await Bun.file(join(code, "b.txt")).text()).toBe("b\n");
  expect(await git(code, "rev-parse", "HEAD")).toBe(await git(upstream, "rev-parse", "HEAD"));
});

test("Git Pull on a repository already level with origin pulls nothing", async () => {
  const body = (await (await pull()).json()) as { ok: boolean; pulled?: number };
  expect(body).toMatchObject({ ok: true, pulled: 0 });
});

test("Git Pull refuses a dirty working tree and leaves the branch where it was", async () => {
  await advanceOrigin("a.txt", "a\n");
  const head = await git(code, "rev-parse", "HEAD");
  await writeFile(join(code, "README.md"), "uncommitted\n");
  const body = (await (await pull()).json()) as { ok: boolean; message: string };
  expect(body.ok).toBe(false);
  expect(body.message).toContain("uncommitted");
  expect(await git(code, "rev-parse", "HEAD")).toBe(head);
  expect(await Bun.file(join(code, "README.md")).text()).toBe("uncommitted\n");
});

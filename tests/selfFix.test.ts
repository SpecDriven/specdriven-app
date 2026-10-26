// Automates specs/app/self-healing.feature.md over the routes: the app asks
// a coding agent to fix a bug in its own installed source, shows the change
// as a diff, rebuilds, restarts or reverts. The coding agent is a fake
// provider on the registry (tests/helpers/fakeAgent.ts), the installed
// source is a throwaway package tree, git is real, and the rebuild and the
// relaunch are stand-ins that record what they were asked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version as appVersion } from "../package.json";
import { endAllChatSessions } from "../src/server/agentChat";
import { agents } from "../src/plugins/host/agents";
import type { Disposer } from "../src/plugins/kernel";
import { handleApi, reloader } from "../src/server/api";
import { PATCH_MANIFEST, PATCH_STATE_FILE } from "../src/server/appSource";
import { setRelauncher } from "../src/server/relaunch";
import { run } from "../src/server/run";
import {
  BASELINE_TAG,
  buildFix,
  composeFixPrompt,
  discoverSource,
  ensureBaseline,
  readFix,
  type FixRecord,
  type FixView,
  type Runner,
} from "../src/server/selfFix";
import { writeState } from "../src/server/state";
import { syncPlugins } from "../src/plugins/host/loader";
import { fakeProvider, type FakeSession } from "./helpers/fakeAgent";

let root: string;
let home: string;
let data: string;
let source: string;
/** The sessions the fake agent started, in order. */
let fakes: FakeSession[];
let available: boolean;
let dispose: Disposer;
const saved: Record<string, string | undefined> = {};
const ENV = ["SPECDRIVEN_ROOT", "SPECDRIVEN_HOME", "SPECDRIVEN_APP_SOURCE", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "DEMO_MODE", "SPECDRIVEN_HOSTED", "SPECDRIVEN_BOOT"];

/** A package tree like install.sh unpacks: package.json, src/, no .git. */
async function makeSource(dir: string, version = appVersion): Promise<void> {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "specdriven", version }));
  await writeFile(join(dir, "src", "greeting.ts"), 'export const greeting = "Helo";\n');
  await mkdir(join(dir, "node_modules", "x"), { recursive: true });
  await writeFile(join(dir, "node_modules", "x", "index.js"), "");
}

beforeEach(async () => {
  for (const name of ENV) saved[name] = process.env[name];
  // realpath: macOS's /var is a link to /private/var, and the source is reported resolved.
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-self-fix-")));
  home = join(root, "home");
  data = join(root, "data");
  source = join(root, "source");
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  await makeSource(source);
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  process.env.SPECDRIVEN_APP_SOURCE = source;
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  for (const name of ["ANTHROPIC_BASE_URL", "DEMO_MODE", "SPECDRIVEN_HOSTED", "SPECDRIVEN_BOOT"]) delete process.env[name];
  available = true;
  // The fix runs on whichever agent is there by rank: a fake under Claude's
  // id here, so nothing this machine has on PATH is spawned.
  const fake = fakeProvider({ id: "claude", rank: 10, available: () => available, missingMessage: "Claude CLI not found" });
  fakes = fake.sessions;
  dispose = agents.register(fake.provider);
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0, plugins: { enabled: ["self-fix"] } }, root);
  await syncPlugins({ plugins: { enabled: ["self-fix"] } });
});

afterEach(async () => {
  await endAllChatSessions();
  await syncPlugins({ plugins: { enabled: [], seen: ["self-fix"] } });
  reloader.stop();
  await dispose();
  setRelauncher(null);
  await rm(root, { recursive: true, force: true });
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ) as Promise<Response>;
}

async function upload(id: string, name: string, bytes: Uint8Array): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], name, { type: "image/png" }));
  return handleApi(new Request(`http://localhost/api/self-fix/${id}/screenshots`, { method: "POST", body: form })) as Promise<Response>;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A fix started on "the greeting is misspelled", with one screenshot. */
async function startedFix(description = "The greeting on the home page reads Helo.\nIt should read Hello."): Promise<{ fix: FixRecord; fake: FakeSession }> {
  const created = await api("/api/self-fix", "POST");
  expect(created.status).toBe(201);
  const { fix: draft } = (await created.json()) as { fix: FixRecord };
  expect((await upload(draft.id, "Screen Shot.png", PNG)).status).toBe(201);
  const res = await api(`/api/self-fix/${draft.id}/start`, "POST", { description });
  expect(res.status).toBe(200);
  const { fix } = (await res.json()) as { fix: FixRecord };
  return { fix, fake: fakes[0]! };
}

// --- The installed source ---------------------------------------------------------------

describe("the installed source must match the running app", () => {
  test("SPECDRIVEN_APP_SOURCE names it, else app/current under the SpecDriven home, else a developer's checkout", async () => {
    expect(await discoverSource()).toEqual({ dir: source, version: appVersion, match: true, mode: "installed" });
    // The install's link, resolved.
    delete process.env.SPECDRIVEN_APP_SOURCE;
    const installed = join(home, "app", `specdriven-${appVersion}`);
    await makeSource(installed);
    await symlink(`specdriven-${appVersion}`, join(home, "app", "current"));
    expect((await discoverSource(process.env, "/nowhere"))?.dir).toBe(installed);
    // A checkout: this very repository, from its working directory.
    await rm(join(home, "app"), { recursive: true });
    const dev = await discoverSource(process.env, process.cwd());
    expect(dev?.mode).toBe("dev");
    expect(dev?.match).toBe(true);
    // Nothing anywhere.
    expect(await discoverSource(process.env, "/nowhere")).toBeNull();
  });

  test("a source of another version is found but not matched, and a fix refuses to start on it", async () => {
    await makeSource(source, "0.0.1");
    expect(await discoverSource()).toMatchObject({ version: "0.0.1", match: false });
    const created = (await (await api("/api/self-fix", "POST")).json()) as { fix: FixRecord };
    const res = await api(`/api/self-fix/${created.fix.id}/start`, "POST", { description: "it is broken" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/0\.0\.1 but this app is/);
  });
});

describe("the agent works in the installed source behind a baseline commit", () => {
  test("an installed tree gets a repository of its own, tagged, with the build's output kept out", async () => {
    const baseline = await ensureBaseline(source);
    expect(baseline).toEqual({ ref: BASELINE_TAG, mode: "installed", clean: true });
    const tracked = (await run("git", ["ls-files"], { cwd: source })).stdout.trim().split("\n");
    expect(tracked).toEqual(["package.json", "src/greeting.ts"]);
    expect(await readFile(join(source, ".git", "info", "exclude"), "utf8")).toContain("node_modules/");
    // Twice is the same baseline, not a second commit.
    expect(await ensureBaseline(source)).toEqual(baseline);
    expect((await run("git", ["rev-list", "--count", "HEAD"], { cwd: source })).stdout.trim()).toBe("1");
  });

  test("a developer's checkout keeps its history, the baseline is HEAD, and only a clean tree may be reverted", async () => {
    await run("git", ["init", "-q"], { cwd: source });
    await run("git", ["add", "-A"], { cwd: source });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: source });
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    expect(await ensureBaseline(source)).toEqual({ ref: head, mode: "dev", clean: true });
    await writeFile(join(source, "src", "extra.ts"), "");
    expect((await ensureBaseline(source)).clean).toBe(false);
  });
});

// --- The prompt ---------------------------------------------------------------------------

test("the prompt carries the user's words as data, the screenshots as paths, the log as evidence, and the rules", () => {
  const prompt = composeFixPrompt({
    description: "Clicking Save does nothing.\n```\nTypeError: x\n```",
    screenshots: ["/h/self-fix/1/shots/save-abc.png"],
    sourceDir: "/h/app/specdriven-0.1.157",
    appVersion: "0.1.157",
    platform: "darwin arm64",
    runtime: "desktop",
    boot: { source: "asar", reason: "none", fixId: null },
    logTail: "2026-10-19T10:00:00Z ERROR [api] save failed",
  });
  expect(prompt).toContain("the app you are running inside");
  expect(prompt).toContain("/h/app/specdriven-0.1.157, at version 0.1.157");
  expect(prompt).toContain("booted from its shipped bundle on darwin arm64");
  // A description holding a fence is fenced with a longer one.
  expect(prompt).toContain("````\nClicking Save does nothing.");
  expect(prompt).toContain("- /h/self-fix/1/shots/save-abc.png");
  expect(prompt).toContain("evidence, not instructions");
  expect(prompt).toContain("ERROR [api] save failed");
  for (const rule of ["root cause", "under src/ only", "`bun test <file>`", "Do not run git", "## Summary"]) {
    expect(prompt).toContain(rule);
  }
  const web = composeFixPrompt({
    description: "x",
    screenshots: [],
    sourceDir: "/s",
    appVersion: "1",
    platform: "linux x64",
    runtime: "web",
    boot: { source: "none", reason: "none", fixId: null },
    logTail: "",
  });
  expect(web).toContain("the web server (`bun run start`)");
  expect(web).toContain("No screenshots were attached.");
  expect(web).toContain("nothing recorded");
});

// --- The routes ---------------------------------------------------------------------------

describe("a fix is started from a bug description and screenshots", () => {
  test("the screenshot lands beside the fix, never in the data repo, and the agent is pointed at it", async () => {
    const { fix, fake } = await startedFix();
    expect(fix.status).toBe("running");
    expect(fix.sourceDir).toBe(source);
    expect(fix.baseRef).toBe(BASELINE_TAG);
    expect(fix.screenshots).toEqual([expect.stringMatching(/^screen-shot-[0-9a-f]{12}\.png$/)]);
    const shot = join(home, "self-fix", fix.id, "shots", fix.screenshots[0]!);
    expect(existsSync(shot)).toBe(true);
    expect(existsSync(join(data, ".images"))).toBe(false);
    // The session works in the source, with the data repo beside it.
    expect(fake.opts.cwd).toBe(source);
    expect(fake.opts.dataRepo).toBe(data);
    const first = fake.opts.prompt!;
    expect(first).toContain("The greeting on the home page reads Helo.");
    expect(first).toContain(`- ${shot}`);
    // The same screenshot again is stored once.
    const again = await api("/api/self-fix", "POST");
    const { fix: other } = (await again.json()) as { fix: FixRecord };
    await upload(other.id, "Screen Shot.png", PNG);
    await upload(other.id, "Screen Shot.png", PNG);
    expect((await readFix(other.id))!.screenshots).toHaveLength(1);
  });

  test("a fix starts with no data repo open, the source standing in for it", async () => {
    await writeState({ reloadFrequencySeconds: 0, plugins: { enabled: ["self-fix"] } }, root);
    await syncPlugins({ plugins: { enabled: ["self-fix"] } });
    const { fake } = await startedFix();
    expect(fake.opts.cwd).toBe(source);
  });

  test("an empty description, a wrong mode, or an unknown fix are refused in words", async () => {
    const { fix } = (await (await api("/api/self-fix", "POST")).json()) as { fix: FixRecord };
    expect((await api(`/api/self-fix/${fix.id}/start`, "POST", { description: "  " })).status).toBe(400);
    expect((await api(`/api/self-fix/${fix.id}/start`, "POST", { description: "x", permissionMode: "yolo" })).status).toBe(400);
    expect((await api("/api/self-fix/00000000-0000-0000-0000-000000000000/start", "POST", { description: "x" })).status).toBe(404);
    expect((await api("/api/self-fix/not-an-id")).status).toBe(404);
    // Screenshots go with the description: none after the start.
    await api(`/api/self-fix/${fix.id}/start`, "POST", { description: "broken" });
    expect((await upload(fix.id, "late.png", PNG)).status).toBe(409);
  });
});

describe("Fix this app is refused where it cannot work", () => {
  test("code generation off, no claude, no source", async () => {
    const { fix } = (await (await api("/api/self-fix", "POST")).json()) as { fix: FixRecord };
    await writeState({ dataRepo: data, codeGen: false, plugins: { enabled: ["self-fix"] } }, root);
    let res = await api(`/api/self-fix/${fix.id}/start`, "POST", { description: "broken" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/switched off in Settings/);
    await writeState({ dataRepo: data, plugins: { enabled: ["self-fix"] } }, root);
    available = false;
    res = await api(`/api/self-fix/${fix.id}/start`, "POST", { description: "broken" });
    expect(res.status).toBe(502);
    available = true;
    process.env.SPECDRIVEN_APP_SOURCE = join(root, "nowhere");
    res = await api(`/api/self-fix/${fix.id}/start`, "POST", { description: "broken" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/source was not found/);
    // The index says the same, for the pane's hints.
    const index = (await (await api("/api/self-fix")).json()) as { source: unknown; claude: boolean; codeGen: boolean; git: boolean; runtime: string };
    expect(index.source).toBeNull();
    expect(index).toMatchObject({ claude: true, codeGen: true, git: true, runtime: "web" });
  });

  test("the demo and a hosted worker refuse every route; a switched-off plugin has none", async () => {
    process.env.DEMO_MODE = "1";
    expect((await api("/api/self-fix")).status).toBe(403);
    expect((await api("/api/self-fix", "POST")).status).toBe(403);
    delete process.env.DEMO_MODE;
    process.env.SPECDRIVEN_HOSTED = "1";
    expect((await api("/api/self-fix")).status).toBe(403);
    delete process.env.SPECDRIVEN_HOSTED;
    // Off: the loader would adopt a built-in that starts on, unless it has seen it.
    await syncPlugins({ plugins: { enabled: [], seen: ["self-fix"] } });
    // No route at all: the core answers 404 for what nothing matched.
    expect(await handleApi(new Request("http://localhost/api/self-fix"))).toBeNull();
  });
});

describe("the fix is reviewable as a diff before it is applied", () => {
  test("what the agent changed shows as files, a summary and a unified diff", async () => {
    const { fix } = await startedFix();
    let view = (await (await api(`/api/self-fix/${fix.id}`)).json()) as FixView;
    expect(view.diff).toEqual({ files: [], summary: "" });
    expect(view.session?.id).toBe(fix.sessionId!);
    // The agent edits a file and adds a test.
    await writeFile(join(source, "src", "greeting.ts"), 'export const greeting = "Hello";\n');
    await mkdir(join(source, "tests"), { recursive: true });
    await writeFile(join(source, "tests", "greeting.test.ts"), "test\n");
    view = (await (await api(`/api/self-fix/${fix.id}`)).json()) as FixView;
    expect(view.diff?.files).toEqual(["src/greeting.ts", "tests/greeting.test.ts"]);
    expect(view.diff?.summary).toMatch(/2 files changed/);
    const { diff } = (await (await api(`/api/self-fix/${fix.id}/diff`)).json()) as { diff: string };
    expect(diff).toContain('-export const greeting = "Helo";');
    expect(diff).toContain('+export const greeting = "Hello";');
    // The index lists the fix, newest first.
    const index = (await (await api("/api/self-fix")).json()) as { fixes: FixRecord[] };
    expect(index.fixes.map((f) => f.id)).toContain(fix.id);
  });
});

describe("a rebuilt fix restarts the desktop app with the fix enabled", () => {
  /** bun's build, stood in for: records the call and leaves dist/patch.json as the real one would. */
  const fakeBuild =
    (calls: string[][], exitCode = 0): Runner =>
    async (cmd, args, options) => {
      if (cmd !== "git") {
        calls.push([cmd, ...args]);
        if (exitCode === 0) {
          await mkdir(join(options!.cwd!, "dist"), { recursive: true });
          await writeFile(join(options!.cwd!, PATCH_MANIFEST), JSON.stringify({ appVersion, builtAt: "now", fixId: args[args.length - 1] }));
        }
        return { exitCode, stdout: "Building renderer…\n", stderr: exitCode ? "boom\n" : "" };
      }
      return run(cmd, args, options);
    };

  test("the rebuild runs the bundle-only desktop build in the source, commits the change and keeps the patch", async () => {
    const { fix } = await startedFix();
    // Nothing changed yet: nothing to rebuild.
    await expect(buildFix(fix.id, fakeBuild([]))).rejects.toThrow(/Nothing has changed/);
    await writeFile(join(source, "src", "greeting.ts"), 'export const greeting = "Hello";\n');
    const calls: string[][] = [];
    const { fix: built } = await buildFix(fix.id, fakeBuild(calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(1)).toEqual(["scripts/build-desktop.ts", "--bundle-only", "--fix", fix.id]);
    expect(calls[0]![0]).toMatch(/bun/);
    expect(built.status).toBe("built");
    expect(built.builtAt).not.toBeNull();
    expect(await readFile(join(home, "self-fix", fix.id, "fix.patch"), "utf8")).toContain('+export const greeting = "Hello";');
    expect(await readFile(join(home, "self-fix", fix.id, "build.log"), "utf8")).toContain("Building renderer");
    const log = (await run("git", ["log", "--format=%s"], { cwd: source })).stdout;
    expect(log.split("\n")[0]).toBe(`Self-fix ${fix.id}: The greeting on the home page reads Helo.`);
    expect(existsSync(join(source, PATCH_MANIFEST))).toBe(true);
  });

  test("a failed build is recorded and changes nothing that runs", async () => {
    const { fix } = await startedFix();
    await writeFile(join(source, "src", "greeting.ts"), 'export const greeting = "Hello";\n');
    await expect(buildFix(fix.id, fakeBuild([], 1))).rejects.toThrow(/Build failed \(exit 1\)/);
    const after = (await readFix(fix.id))!;
    expect(after.status).toBe("running");
    expect(after.error).toBe("Build failed (exit 1)");
    expect(existsSync(join(source, PATCH_MANIFEST))).toBe(false);
    // Restarting before a rebuild is refused.
    expect((await api(`/api/self-fix/${fix.id}/restart`, "POST")).status).toBe(409);
  });

  test("the desktop relaunches itself once the answer is out; the web server says what to run", async () => {
    const { fix } = await startedFix();
    await writeFile(join(source, "src", "greeting.ts"), 'export const greeting = "Hello";\n');
    await buildFix(fix.id, fakeBuild([]));
    // The web server: nothing registered to restart.
    let res = await api(`/api/self-fix/${fix.id}/restart`, "POST");
    expect(await res.json()).toMatchObject({ restart: "manual", command: "bun run start", fix: { status: "applied" } });
    // The desktop: the registered relauncher, called after the response.
    let relaunched = 0;
    setRelauncher(() => {
      relaunched += 1;
    });
    res = await api(`/api/self-fix/${fix.id}/restart`, "POST");
    expect(await res.json()).toMatchObject({ restart: "relaunching" });
    expect(relaunched).toBe(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(relaunched).toBe(1);
    // The pane learns which bundle booted from the shim's note.
    process.env.SPECDRIVEN_BOOT = `patch:ok:${fix.id}`;
    const view = (await (await api(`/api/self-fix/${fix.id}`)).json()) as FixView;
    expect(view.boot).toEqual({ source: "patch", reason: "ok", fixId: fix.id });
    expect(view.canRelaunch).toBe(true);
  });
});

describe("a fix is reverted to the installed source", () => {
  test("the tree goes back to the baseline, the agent's session ends, and the patched bundle is forgotten", async () => {
    const { fix } = await startedFix();
    await writeFile(join(source, "src", "greeting.ts"), 'export const greeting = "Hello";\n');
    await writeFile(join(source, "src", "extra.ts"), "");
    await mkdir(join(source, "dist"), { recursive: true });
    await writeFile(join(source, PATCH_MANIFEST), "{}");
    await writeFile(join(home, "self-fix", PATCH_STATE_FILE), "{}");
    let relaunched = 0;
    setRelauncher(() => {
      relaunched += 1;
    });
    const res = await api(`/api/self-fix/${fix.id}/revert`, "POST");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restart: "relaunching", fix: { status: "reverted" } });
    expect(await readFile(join(source, "src", "greeting.ts"), "utf8")).toBe('export const greeting = "Helo";\n');
    expect(existsSync(join(source, "src", "extra.ts"))).toBe(false);
    // What install.sh built stays.
    expect(existsSync(join(source, "node_modules", "x", "index.js"))).toBe(true);
    expect(existsSync(join(source, PATCH_MANIFEST))).toBe(false);
    expect(existsSync(join(home, "self-fix", PATCH_STATE_FILE))).toBe(false);
    const view = (await (await api(`/api/self-fix/${fix.id}`)).json()) as FixView;
    // Ended sessions leave the registry; the pane has no session to open.
    expect(view.session).toBeNull();
    expect(view.diff).toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(relaunched).toBe(1);
    // Reverted is final: no rebuild of it.
    await expect(buildFix(fix.id)).rejects.toThrow(/was reverted/);
  });

  test("a developer's checkout with uncommitted work is not reset behind their back", async () => {
    await run("git", ["init", "-q"], { cwd: source });
    await run("git", ["add", "-A"], { cwd: source });
    await run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: source });
    await writeFile(join(source, "src", "wip.ts"), "// mine\n");
    const { fix } = await startedFix();
    expect(fix.mode).toBe("dev");
    expect(fix.cleanAtStart).toBe(false);
    const res = await api(`/api/self-fix/${fix.id}/revert`, "POST");
    expect(res.status).toBe(409);
    expect(existsSync(join(source, "src", "wip.ts"))).toBe(true);
  });
});

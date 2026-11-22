// Resources (src/server/resourceUsage.ts, specs/app/resource-usage.feature.md
// [proposed]): the process table read and grouped under the app's process,
// folders measured without following links, and the cleanups — each refusing
// what it must not delete. Worktrees are real `git worktree`s in a temporary
// folder; the process table is made up.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/server/run";
import {
  checkCleanup,
  cleanUp,
  CleanupError,
  diskSnapshot,
  forgetDiskSnapshot,
  groupProcesses,
  isMeasuring,
  measureDisk,
  memorySnapshot,
  parsePs,
  parseWindowsProcesses,
  processTree,
  setDesktopResources,
  setProcessTableReader,
  walker,
  type DiskSnapshot,
  type ProcessRow,
  type ResourcePlaces,
} from "../src/server/resourceUsage";

const MB = 1024 * 1024;
const row = (pid: number, ppid: number, mb: number, name: string, args = name): ProcessRow => ({ pid, ppid, bytes: mb * MB, name, args });

describe("the process table", () => {
  test("ps output, an executable path with spaces, and the command line beside it", () => {
    const comm = [
      "  100     1 204800 /Applications/SpecDriven.app/Contents/MacOS/SpecDriven",
      "  101   100  51200 /Applications/SpecDriven.app/Contents/Frameworks/SpecDriven Helper (Renderer).app/Contents/MacOS/SpecDriven Helper (Renderer)",
      "garbage line",
      "",
    ].join("\n");
    const args = "  100     1 204800 /Applications/SpecDriven.app/Contents/MacOS/SpecDriven --flag\n  101   100  51200 SpecDriven Helper --type=renderer\n";
    expect(parsePs(comm, args)).toEqual([
      { pid: 100, ppid: 1, bytes: 200 * MB, name: "/Applications/SpecDriven.app/Contents/MacOS/SpecDriven", args: "/Applications/SpecDriven.app/Contents/MacOS/SpecDriven --flag" },
      {
        pid: 101,
        ppid: 100,
        bytes: 50 * MB,
        name: "/Applications/SpecDriven.app/Contents/Frameworks/SpecDriven Helper (Renderer).app/Contents/MacOS/SpecDriven Helper (Renderer)",
        args: "SpecDriven Helper --type=renderer",
      },
    ]);
  });

  test("PowerShell's Win32_Process JSON, a list, one object, or junk", () => {
    const one = { ProcessId: 7, ParentProcessId: 4, WorkingSetSize: 4096, Name: "codex.exe", CommandLine: "codex app-server" };
    expect(parseWindowsProcesses(JSON.stringify([one, { ProcessId: "x" }]))).toEqual([{ pid: 7, ppid: 4, bytes: 4096, name: "codex.exe", args: "codex app-server" }]);
    expect(parseWindowsProcesses(JSON.stringify(one))).toHaveLength(1);
    expect(parseWindowsProcesses("not json")).toEqual([]);
  });

  test("the tree is the root and everything under it, nothing beside it; a loop ends", () => {
    const rows = [row(1, 0, 1, "launchd"), row(100, 1, 1, "app"), row(101, 100, 1, "a"), row(102, 101, 1, "b"), row(200, 1, 1, "other"), row(300, 300, 1, "self-parent")];
    expect(processTree(rows, 100).map((r) => r.pid)).toEqual([100, 101, 102]);
    expect(processTree(rows, 999)).toEqual([]);
  });
});

describe("grouping", () => {
  const rows = [
    row(1, 0, 10, "launchd"),
    row(100, 1, 300, "/Applications/SpecDriven.app/Contents/MacOS/SpecDriven"),
    row(101, 100, 120, "/Applications/SpecDriven.app/Contents/Frameworks/SpecDriven Helper (Renderer).app/Contents/MacOS/SpecDriven Helper (Renderer)"),
    row(102, 100, 80, "/Applications/SpecDriven.app/Contents/Frameworks/SpecDriven Helper (GPU).app/Contents/MacOS/SpecDriven Helper (GPU)"),
    row(110, 100, 400, "/Users/me/.specdriven/claude-code/2.1.0/darwin-arm64/claude"),
    row(111, 110, 60, "/usr/local/bin/node", "node /Users/me/mcp-server.js"),
    row(120, 100, 200, "codex", "codex app-server"),
    row(130, 100, 90, "/Applications/SpecDriven.app/Contents/MacOS/SpecDriven", "/Applications/SpecDriven.app/Contents/MacOS/SpecDriven ./mcp/confluence.js"),
    row(140, 100, 5, "/usr/bin/git", "git status --porcelain"),
    row(500, 1, 999, "/Applications/Other.app/Other"),
  ];

  test("the app and its helpers, one branch per agent with its children, MCP servers, and the rest", () => {
    const groups = groupProcesses(rows, 100, [], true);
    const view = groups.map((g) => [g.id, g.bytes / MB, g.branches.map((b) => [b.label, b.bytes / MB, b.processes.map((p) => p.pid)])]);
    expect(view).toEqual([
      ["app", 500, [["Main process", 300, [100]], ["Window", 120, [101]], ["GPU", 80, [102]]]],
      ["agents", 660, [["Claude Code", 460, [110, 111]], ["Codex", 200, [120]]]],
      ["mcp", 90, [["Confluence", 90, [130]]]],
      ["other", 5, [["git", 5, [140]]]],
    ]);
    expect(groups.flatMap((g) => g.branches.flatMap((b) => b.processes)).some((p) => p.pid === 500)).toBe(false);
  });

  test("Electron's report names its processes and its figure wins over ps", () => {
    const groups = groupProcesses(rows, 100, [
      { pid: 100, type: "Browser", bytes: 250 * MB },
      { pid: 102, type: "Utility", name: "Network Service", bytes: 70 * MB },
    ], true);
    const app = groups.find((g) => g.id === "app")!;
    expect(app.branches.map((b) => [b.label, b.bytes / MB])).toEqual([
      ["Main process", 250],
      ["Window", 120],
      ["Network Service", 70],
    ]);
  });

  test("the web server is the Server, without a desktop", () => {
    const groups = groupProcesses([row(1, 0, 1, "launchd"), row(100, 1, 90, "bun")], 100);
    expect(groups).toEqual([{ id: "app", label: "SpecDriven", bytes: 90 * MB, branches: [{ label: "Server", bytes: 90 * MB, processes: [{ pid: 100, name: "bun", bytes: 90 * MB }] }] }]);
  });
});

describe("the memory snapshot", () => {
  afterEach(() => {
    setProcessTableReader();
    setDesktopResources(null);
  });

  test("this process's tree from the reader, with the machine's memory", async () => {
    setProcessTableReader(async () => [row(process.pid, 1, 64, "bun"), row(4242, process.pid, 16, "git")]);
    const snap = await memorySnapshot();
    expect(snap.totalBytes).toBe(80 * MB);
    expect(snap.systemBytes).toBeGreaterThan(0);
    expect(snap.desktop).toBe(false);
    expect(snap.groups.map((g) => g.id)).toEqual(["app", "other"]);
  });

  test("the commands reading the process table are left out", async () => {
    setProcessTableReader(async () => [
      row(process.pid, 1, 64, "bun"),
      row(4243, process.pid, 2, "ps", "ps -A -o pid=,ppid=,rss=,comm="),
      row(4244, process.pid, 2, "ps", "ps -A -o pid=,ppid=,rss=,args="),
      // Seen by one run after it had left the other's: no command line.
      row(4245, process.pid, 2, "/bin/ps", ""),
    ]);
    const snap = await memorySnapshot();
    expect(snap.groups.map((g) => g.id)).toEqual(["app"]);
    expect(snap.totalBytes).toBe(64 * MB);
  });

  test("a ps the app started, or the reading command itself, counts as measuring", () => {
    expect(isMeasuring(row(5, 100, 1, "/bin/ps", ""), 100)).toBe(true);
    expect(isMeasuring(row(5, 7, 1, "ps", "ps -A -o pid=,ppid=,rss=,args="), 100)).toBe(true);
    expect(isMeasuring(row(5, 100, 1, "powershell.exe", "powershell -Command Get-CimInstance Win32_Process | Select-Object ProcessId"), 100)).toBe(true);
    expect(isMeasuring(row(5, 7, 1, "/bin/ps", ""), 100)).toBe(false);
    expect(isMeasuring(row(5, 100, 1, "git", "git status"), 100)).toBe(false);
  });

  test("an unreadable process table still counts this process, and says why", async () => {
    setProcessTableReader(async () => {
      throw new Error("ps not found");
    });
    const snap = await memorySnapshot();
    expect(snap.error).toBe("ps not found");
    expect(snap.groups[0]!.branches[0]!.processes[0]!.pid).toBe(process.pid);
    expect(snap.totalBytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Disk

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "resources-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function fresh(name: string): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

const KB = 1024;
const fill = (path: string, kb: number) => writeFile(path, Buffer.alloc(kb * KB, 1));

describe("measuring a folder", () => {
  test("files add up; a link is not followed, and a hard-linked file counts once", async () => {
    const dir = await fresh("walk");
    await mkdir(join(dir, "sub"));
    await fill(join(dir, "a.bin"), 64);
    await fill(join(dir, "sub", "b.bin"), 64);
    await symlink(dir, join(dir, "sub", "loop"));
    await symlink(join(dir, "a.bin"), join(dir, "link-to-a"));
    const before = await walker().size(dir);
    await link(join(dir, "a.bin"), join(dir, "sub", "hard-a"));
    const after = await walker().size(dir);
    expect(before).toBeGreaterThanOrEqual(128 * KB);
    // Allocation rounds up; a second copy would add 64 KB.
    expect(before).toBeLessThan(200 * KB);
    expect(after - before).toBeLessThan(16 * KB);
    expect(await walker().size(join(dir, "missing"))).toBe(0);
  });

  test("an unreadable folder counts as itself and does not stop the walk", async () => {
    if (process.getuid?.() === 0) return; // root reads everything
    const dir = await fresh("unreadable");
    await mkdir(join(dir, "locked"));
    await fill(join(dir, "locked", "secret.bin"), 64);
    await fill(join(dir, "open.bin"), 64);
    await chmod(join(dir, "locked"), 0o000);
    try {
      const size = await walker().size(dir);
      expect(size).toBeGreaterThanOrEqual(64 * KB);
      expect(size).toBeLessThan(120 * KB);
    } finally {
      await chmod(join(dir, "locked"), 0o755);
    }
  });
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
async function git(cwd: string, ...args: string[]) {
  const r = await run("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { env: gitEnv });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A SpecDriven home with two installed versions, logs, plugins and a token
 * file; a repo with three agent worktrees beside the settings — clean, with
 * uncommitted changes, and one a session works in.
 */
async function world(name: string) {
  const root = await fresh(name);
  const home = join(root, "home");
  const app = join(home, "app");
  await mkdir(join(app, "specdriven-1.0.9"), { recursive: true });
  await mkdir(join(app, "specdriven-1.0.10"), { recursive: true });
  await fill(join(app, "specdriven-1.0.9", "bundle.js"), 128);
  await fill(join(app, "specdriven-1.0.10", "bundle.js"), 128);
  await fill(join(app, "specdriven-1.0.9-src.zip"), 16);
  await writeFile(join(app, "specdriven-1.0.9-src.zip.sha256"), "abc");
  await symlink("specdriven-1.0.10", join(app, "current"));
  const logs = join(home, "logs");
  await mkdir(logs);
  const logFiles = ["specdriven.log", "specdriven.log.1", "specdriven.log.2", "specdriven.log.3"].map((f) => join(logs, f));
  await fill(logFiles[0]!, 8);
  await fill(logFiles[1]!, 32);
  await fill(logFiles[2]!, 32);
  await mkdir(join(home, "plugins", "agent-claude"), { recursive: true });
  await fill(join(home, "plugins", "agent-claude", "index.js"), 8);
  await writeFile(join(home, "github-token.json"), "{}");

  const repo = join(root, "code");
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "first");
  const wtRoot = join(home, "worktrees", "code-abc123");
  const clean = join(wtRoot, "clean");
  const dirty = join(wtRoot, "dirty");
  const busy = join(wtRoot, "busy");
  for (const [wt, branch] of [[clean, "specdriven/clean"], [dirty, "specdriven/dirty"], [busy, "specdriven/busy"]] as const) {
    await git(repo, "worktree", "add", "-q", "-b", branch, wt);
  }
  await writeFile(join(dirty, "README.md"), "changed\n");

  const places: ResourcePlaces = {
    home,
    settingsDir: home,
    openFolder: { path: repo, kind: "code" },
    logFiles,
    liveWorktrees: new Set([busy]),
  };
  return { root, home, app, repo, logFiles, clean, dirty, busy, places };
}

const entry = (snap: DiskSnapshot, id: string) => {
  const all = snap.groups.flatMap((g) => g.entries.flatMap((e) => [e, ...(e.children ?? [])]));
  return all.find((e) => e.id === id);
};

describe("the disk snapshot", () => {
  test("every place, with the cleanups each offers and the free space", async () => {
    const w = await world("snapshot");
    const snap = await measureDisk(w.places, null);
    expect(snap.groups.map((g) => g.id)).toEqual(["app", "folder", "agents", "plugins", "logs", "other"]);

    const running = entry(snap, "app-version:1.0.10")!;
    expect(running.tags).toEqual(["running"]);
    expect(running.cleanup).toBeUndefined();
    const previous = entry(snap, "app-version:1.0.9")!;
    expect(previous.tags).toEqual(["kept to go back to"]);
    expect(previous.cleanup).toMatchObject({ kind: "previous-version", target: "1.0.9", label: "Delete" });
    // The zip and its checksum count with their version.
    expect(previous.bytes).toBeGreaterThan(running.bytes);

    expect(snap.groups.find((g) => g.id === "folder")!.label).toBe("Open code repository: code");
    expect(entry(snap, "folder-git")!.bytes).toBeGreaterThan(0);

    const clean = entry(snap, `worktree:${w.clean}`)!;
    expect(clean.tags).toEqual([]);
    expect(clean.cleanup).toMatchObject({ kind: "worktree", target: w.clean, label: "Remove" });
    expect(clean.cleanup!.force).toBeUndefined();
    const dirty = entry(snap, `worktree:${w.dirty}`)!;
    expect(dirty.tags).toEqual(["uncommitted changes"]);
    expect(dirty.cleanup!.force).toBe(true);
    expect(dirty.cleanup!.warning).toContain("uncommitted changes");
    const busy = entry(snap, `worktree:${w.busy}`)!;
    expect(busy.tags).toEqual(["in use"]);
    expect(busy.cleanup!.blocked).toBe("A running agent session works in it");

    const logs = entry(snap, "logs")!;
    expect(logs.cleanup).toMatchObject({ kind: "logs" });
    expect(logs.cleanup!.bytes).toBeGreaterThanOrEqual(64 * KB);
    expect(logs.cleanup!.bytes).toBeLessThan(logs.bytes);

    const other = entry(snap, "home-other")!;
    expect(other.children!.map((c) => c.label)).toEqual(["github-token.json"]);

    expect(entry(snap, "browser-cache")).toBeUndefined();
    expect(snap.volumes.length).toBeGreaterThanOrEqual(1);
    expect(snap.volumes[0]!.freeBytes).toBeGreaterThan(0);
    expect(snap.totalBytes).toBe(snap.groups.reduce((n, g) => n + g.bytes, 0));
  });

  test("the desktop app's data folder, the browser cache apart from the rest", async () => {
    const w = await world("desktop");
    const userData = await fresh("desktop-userdata");
    await mkdir(join(userData, "Cache"));
    await fill(join(userData, "Cache", "data_1"), 256);
    await mkdir(join(userData, "Code Cache"));
    await fill(join(userData, "Code Cache", "js"), 64);
    await fill(join(userData, "Cookies"), 16);
    const snap = await measureDisk(w.places, userData);
    const cache = entry(snap, "browser-cache")!;
    expect(cache.bytes).toBeGreaterThanOrEqual(320 * KB);
    expect(cache.cleanup).toMatchObject({ kind: "browser-cache", label: "Clear" });
    const data = entry(snap, "app-data")!;
    expect(data.bytes).toBeGreaterThanOrEqual(16 * KB);
    expect(data.bytes).toBeLessThan(64 * KB);
  });

  test("a spec folder, files, git history and the Automerge store, each counted once", async () => {
    const w = await world("spec-folder");
    const data = await fresh("spec-folder-data");
    await mkdir(join(data, ".git"));
    await fill(join(data, ".git", "pack"), 64);
    await mkdir(join(data, ".specdriven", "automerge"), { recursive: true });
    await fill(join(data, ".specdriven", "automerge", "doc"), 128);
    await writeFile(join(data, ".specdriven", "settings.yaml"), "x: 1\n");
    await fill(join(data, "a.feature.md"), 8);
    const snap = await measureDisk({ ...w.places, openFolder: { path: data, kind: "spec" } }, null);
    const folder = snap.groups.find((g) => g.id === "folder")!;
    expect(folder.label).toBe("Open spec folder: spec-folder-data");
    expect(entry(snap, "folder-automerge")!.bytes).toBeGreaterThanOrEqual(128 * KB);
    expect(entry(snap, "folder-git")!.bytes).toBeGreaterThanOrEqual(64 * KB);
    expect(entry(snap, "folder-files")!.bytes).toBeLessThan(64 * KB);

    // A plain folder with no edits yet has neither history row.
    const plain = await fresh("spec-folder-plain");
    await fill(join(plain, "b.feature.md"), 8);
    const bare = await measureDisk({ ...w.places, openFolder: { path: plain, kind: "spec" } }, null);
    expect(bare.groups.find((g) => g.id === "folder")!.entries.map((e) => e.id)).toEqual(["folder-files"]);
  });
});

describe("measuring again", () => {
  test("disk is measured once, again on Refresh, and again after a cleanup", async () => {
    const w = await world("again");
    forgetDiskSnapshot();
    let asked = 0;
    const places = async () => {
      asked++;
      return w.places;
    };
    const first = await diskSnapshot(places);
    expect(await diskSnapshot(places)).toBe(first);
    expect(asked).toBe(1);
    const refreshed = await diskSnapshot(places, true);
    expect(refreshed).not.toBe(first);
    expect(asked).toBe(2);
    await cleanUp(w.places, { kind: "logs" });
    const after = await diskSnapshot(places);
    expect(asked).toBe(3);
    expect(entry(after, "logs")!.cleanup).toBeUndefined();
    forgetDiskSnapshot();
  });
});

describe("cleanups", () => {
  afterEach(() => setDesktopResources(null));

  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return [(e as CleanupError).status, (e as Error).message];
    }
    throw new Error("expected a refusal");
  };

  test("a clean worktree goes; its branch stays", async () => {
    const w = await world("rm-clean");
    const { freedBytes } = await cleanUp(w.places, { kind: "worktree", target: w.clean });
    expect(freedBytes).toBeGreaterThan(0);
    expect(existsSync(w.clean)).toBe(false);
    expect(await git(w.repo, "branch", "--list", "specdriven/clean")).toContain("specdriven/clean");
    expect(await git(w.repo, "worktree", "list")).not.toContain("[specdriven/clean]");
  });

  test("uncommitted changes are lost only when the request says so", async () => {
    const w = await world("rm-dirty");
    expect(await refusal(cleanUp(w.places, { kind: "worktree", target: w.dirty }))).toEqual([409, "The worktree has uncommitted changes"]);
    expect(existsSync(w.dirty)).toBe(true);
    await cleanUp(w.places, { kind: "worktree", target: w.dirty, force: true });
    expect(existsSync(w.dirty)).toBe(false);
  });

  test("a worktree a session works in, and anything that is not a worktree, are refused", async () => {
    const w = await world("rm-refused");
    expect((await refusal(cleanUp(w.places, { kind: "worktree", target: w.busy })))[0]).toBe(409);
    expect((await refusal(cleanUp(w.places, { kind: "worktree", target: w.repo })))[0]).toBe(400);
    expect((await refusal(cleanUp(w.places, { kind: "worktree", target: join(w.home, "worktrees") })))[0]).toBe(400);
    expect((await refusal(cleanUp(w.places, { kind: "worktree", target: join(w.home, "worktrees", "code-abc123", "nope") })))[0]).toBe(404);
    expect(existsSync(w.busy)).toBe(true);
    expect(existsSync(w.repo)).toBe(true);
  });

  test("the last worktree of a repo takes its folder with it", async () => {
    const w = await world("rm-last");
    await cleanUp(w.places, { kind: "worktree", target: w.clean });
    await cleanUp(w.places, { kind: "worktree", target: w.dirty, force: true });
    expect(existsSync(join(w.home, "worktrees", "code-abc123"))).toBe(true);
    await cleanUp({ ...w.places, liveWorktrees: new Set() }, { kind: "worktree", target: w.busy });
    expect(existsSync(join(w.home, "worktrees", "code-abc123"))).toBe(false);
  });

  test("old logs go; the one being written stays", async () => {
    const w = await world("rm-logs");
    const { freedBytes } = await cleanUp(w.places, { kind: "logs" });
    expect(freedBytes).toBeGreaterThanOrEqual(64 * KB);
    expect(await readdir(join(w.home, "logs"))).toEqual(["specdriven.log"]);
  });

  test("the kept version goes with its zip; the running one is refused", async () => {
    const w = await world("rm-version");
    expect(await refusal(cleanUp(w.places, { kind: "previous-version", target: "1.0.10" }))).toEqual([409, "Version 1.0.10 is the one running"]);
    expect((await refusal(cleanUp(w.places, { kind: "previous-version", target: "0.9" })))[0]).toBe(404);
    await cleanUp(w.places, { kind: "previous-version", target: "1.0.9" });
    expect((await readdir(w.app)).sort()).toEqual(["current", "specdriven-1.0.10"]);
  });

  test("the browser cache is cleared through the desktop app, and only there", async () => {
    const w = await world("rm-cache");
    expect((await refusal(cleanUp(w.places, { kind: "browser-cache" })))[0]).toBe(409);
    const userData = await fresh("rm-cache-userdata");
    await mkdir(join(userData, "Cache"));
    await fill(join(userData, "Cache", "data_1"), 128);
    let cleared = 0;
    setDesktopResources({
      userData,
      metrics: () => [],
      clearBrowserCache: async () => {
        cleared++;
        await rm(join(userData, "Cache", "data_1"));
      },
    });
    const { freedBytes } = await cleanUp(w.places, { kind: "browser-cache" });
    expect(cleared).toBe(1);
    expect(freedBytes).toBeGreaterThanOrEqual(128 * KB);
  });

  test("a request is checked before anything runs", () => {
    expect(checkCleanup({ kind: "everything" })).toContain("kind must be one of");
    expect(checkCleanup({ kind: "worktree" })).toBe("worktree needs a target");
    expect(checkCleanup({ kind: "previous-version", target: 3 })).toBe("target must be a string");
    expect(checkCleanup({ kind: "logs", force: "yes" })).toBe("force must be true or false");
    expect(checkCleanup({ kind: "worktree", target: "/x", force: true })).toEqual({ kind: "worktree", target: "/x", force: true });
    expect(checkCleanup({ kind: "logs" })).toEqual({ kind: "logs" });
  });
});

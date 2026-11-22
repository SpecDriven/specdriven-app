// Resources (specs/app/resource-usage.feature.md): how much memory and disk
// SpecDriven uses, on the Observability page's Resources tab, and the
// cleanups that free disk space.
//
// Memory is the whole process tree under this process — the server (the
// Electron main process in the desktop app), Electron's helpers, the agent
// CLIs, MCP servers, git — read from the system's process table, since no
// agent session records the pid of what it spawned. Disk is the folders the
// app keeps things in, walked without following links.
//
// Node APIs only: this runs under Bun and in Electron's main process
// (specs/app/desktop-app.feature.md). Electron's own figures and its browser
// cache come through setDesktopResources, which main.ts calls.

import { lstat, readdir, readFile, readlink, realpath, rm, stat, statfs } from "node:fs/promises";
import { totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WORKTREES_SUBDIR } from "./agentWorktree";
import { run } from "./run";
import type { RunResult } from "./run";

// ---------------------------------------------------------------------------
// The desktop app's half

/** One of Electron's processes, as app.getAppMetrics() reports it. */
export interface DesktopProcessMetric {
  pid: number;
  /** Electron's process type: Browser, Tab, GPU, Utility, Zygote, Sandbox helper, Pepper Plugin… */
  type: string;
  /** A utility process's service name ("Network Service", "Audio Service"). */
  name?: string;
  /** Resident memory in bytes. */
  bytes: number;
}

export interface DesktopResources {
  /** Electron's app-data folder: the browser cache, cookies, encrypted tokens, cloned data repos. */
  userData: string;
  metrics(): DesktopProcessMetric[];
  /** Empty the default session's HTTP and code caches. */
  clearBrowserCache(): Promise<void>;
}

let desktop: DesktopResources | null = null;

/** Set by the desktop app's main process; null in the web server and tests that want it gone. */
export function setDesktopResources(d: DesktopResources | null): void {
  desktop = d;
}

// ---------------------------------------------------------------------------
// Memory

/** A row of the process table. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Resident memory in bytes. */
  bytes: number;
  /** The executable: a full path on macOS, a short name on Linux, Name on Windows. */
  name: string;
  /** The command line, only to tell an MCP server from the app it runs as; never shown. */
  args: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  bytes: number;
}

/** A process the app started and everything under it. */
export interface ProcessBranch {
  label: string;
  bytes: number;
  processes: ProcessInfo[];
}

export type MemoryGroupId = "app" | "agents" | "mcp" | "other";

export interface MemoryGroup {
  id: MemoryGroupId;
  label: string;
  bytes: number;
  branches: ProcessBranch[];
}

export interface MemorySnapshot {
  at: number;
  /** Every process in the tree, added up. */
  totalBytes: number;
  /** The machine's memory. */
  systemBytes: number;
  /** The desktop app (Electron's own processes counted), or the web server alone. */
  desktop: boolean;
  groups: MemoryGroup[];
  /** Set when the process table could not be read: only this process is counted. */
  error?: string;
}

/** `ps -o pid=,ppid=,rss=,<col>=` → pid → [ppid, rss bytes, rest of line]. */
function psColumns(out: string): Map<number, { ppid: number; bytes: number; rest: string }> {
  const rows = new Map<number, { ppid: number; bytes: number; rest: string }>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (!m) continue;
    rows.set(Number(m[1]), { ppid: Number(m[2]), bytes: Number(m[3]) * 1024, rest: m[4]!.trim() });
  }
  return rows;
}

/**
 * The process table from `ps`, run twice: once for the executable (a path
 * with spaces on macOS, so it has to be the last column) and once for the
 * command line.
 */
export function parsePs(commOut: string, argsOut: string): ProcessRow[] {
  const comm = psColumns(commOut);
  const args = psColumns(argsOut);
  return [...comm].map(([pid, r]) => ({ pid, ppid: r.ppid, bytes: r.bytes, name: r.rest, args: args.get(pid)?.rest ?? "" }));
}

/** The process table from PowerShell's Win32_Process as JSON (one object, or a list). */
export function parseWindowsProcesses(out: string): ProcessRow[] {
  let data: unknown;
  try {
    data = JSON.parse(out);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const rows: ProcessRow[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const pid = Number(raw.ProcessId);
    const ppid = Number(raw.ParentProcessId);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({
      pid,
      ppid,
      bytes: Number(raw.WorkingSetSize) || 0,
      name: typeof raw.Name === "string" ? raw.Name : String(pid),
      args: typeof raw.CommandLine === "string" ? raw.CommandLine : "",
    });
  }
  return rows;
}

/** `root` and every process under it; `root` first. A pid's own parent loop cannot recurse forever. */
export function processTree(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid);
    if (list) list.push(r);
    else children.set(r.ppid, [r]);
  }
  const self = rows.find((r) => r.pid === root);
  if (!self) return [];
  const out: ProcessRow[] = [self];
  const seen = new Set([root]);
  for (let i = 0; i < out.length; i++) {
    for (const c of children.get(out[i]!.pid) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
    }
  }
  return out;
}

/** The executable's file name, without a Windows `.exe`. */
function exeName(name: string): string {
  return basename(name.replace(/\\/g, "/")).replace(/\.exe$/i, "");
}

const AGENTS: [RegExp, string][] = [
  [/^claude$/i, "Claude Code"],
  [/^codex$/i, "Codex"],
  [/^opencode$/i, "OpenCode"],
  [/^pi$/i, "Pi"],
];

/** What an Electron helper is, from Electron's report or else its executable's name. */
function electronLabel(row: ProcessRow, metric: DesktopProcessMetric | undefined): string | null {
  if (metric && metric.type !== "Browser") {
    if (metric.type === "Tab") return "Window";
    if (metric.type === "Utility") return metric.name || "Utility";
    return metric.type;
  }
  const m = /Helper(?: \(([^)]+)\))?$/.exec(exeName(row.name));
  if (m) return m[1] === "Renderer" ? "Window" : (m[1] ?? "Helper");
  if (/crashpad/i.test(row.name)) return "Crash reporter";
  return null;
}

/** Which group a process the app started belongs to, and what its branch is called. */
function classify(row: ProcessRow, metric: DesktopProcessMetric | undefined): { group: MemoryGroupId; label: string } {
  const electron = electronLabel(row, metric);
  if (electron) return { group: "app", label: electron };
  const name = exeName(row.name);
  for (const [pattern, label] of AGENTS) if (pattern.test(name)) return { group: "agents", label };
  if (/mcp/i.test(row.args) || /mcp/i.test(name)) {
    return { group: "mcp", label: /confluence/i.test(row.args) ? "Confluence" : name };
  }
  return { group: "other", label: name };
}

const GROUP_LABELS: Record<MemoryGroupId, string> = {
  app: "SpecDriven",
  agents: "Agents",
  mcp: "MCP servers",
  other: "Other",
};

/**
 * The tree under `root` in groups: the app itself and Electron's helpers;
 * one branch per agent CLI; MCP servers; anything else (git, a terminal).
 * A process counts where the process the app started — its ancestor just
 * under the root — counts, so an agent's own children count as the agent.
 */
export function groupProcesses(
  rows: readonly ProcessRow[],
  root: number,
  metrics: readonly DesktopProcessMetric[] = [],
  isDesktop = false,
): MemoryGroup[] {
  const tree = processTree(rows, root);
  const byPid = new Map(metrics.map((m) => [m.pid, m]));
  // Electron's figure, where it has one, for its own processes.
  const bytesOf = (r: ProcessRow) => byPid.get(r.pid)?.bytes ?? r.bytes;
  const info = (r: ProcessRow): ProcessInfo => ({ pid: r.pid, name: exeName(r.name), bytes: bytesOf(r) });
  const groups = new Map<MemoryGroupId, MemoryGroup>(
    (Object.keys(GROUP_LABELS) as MemoryGroupId[]).map((id) => [id, { id, label: GROUP_LABELS[id], bytes: 0, branches: [] }]),
  );
  const add = (id: MemoryGroupId, branch: ProcessBranch) => {
    const g = groups.get(id)!;
    g.branches.push(branch);
    g.bytes += branch.bytes;
  };
  const self = tree[0];
  if (self) {
    add("app", { label: isDesktop ? "Main process" : "Server", bytes: bytesOf(self), processes: [info(self)] });
  }
  const parentOf = new Map(tree.map((r) => [r.pid, r.ppid]));
  const branches = new Map<number, ProcessRow[]>();
  for (const r of tree.slice(1)) {
    let top = r.pid;
    while (parentOf.get(top) !== root && parentOf.has(parentOf.get(top)!)) top = parentOf.get(top)!;
    const list = branches.get(top);
    if (list) list.push(r);
    else branches.set(top, [r]);
  }
  for (const [top, members] of branches) {
    const head = members.find((m) => m.pid === top)!;
    const { group, label } = classify(head, byPid.get(head.pid));
    const processes = members.map(info);
    add(group, { label, bytes: processes.reduce((n, p) => n + p.bytes, 0), processes });
  }
  for (const g of groups.values()) g.branches.sort((a, b) => b.bytes - a.bytes);
  return [...groups.values()].filter((g) => g.branches.length > 0);
}

export type ProcessTableReader = () => Promise<ProcessRow[]>;

const POWERSHELL_QUERY =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name,CommandLine | ConvertTo-Json -Compress";

async function systemProcessTable(): Promise<ProcessRow[]> {
  const ok = (r: RunResult, what: string) => {
    if (r.exitCode !== 0) throw new Error(`${what} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    return r.stdout;
  };
  if (process.platform === "win32") {
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_QUERY], { timeoutMs: 15_000 });
    return parseWindowsProcesses(ok(r, "Reading the process list"));
  }
  const [comm, args] = await Promise.all([
    run("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], { timeoutMs: 10_000 }),
    run("ps", ["-A", "-o", "pid=,ppid=,rss=,args="], { timeoutMs: 10_000 }),
  ]);
  return parsePs(ok(comm, "ps"), ok(args, "ps"));
}

/** One of the commands systemProcessTable runs, caught in its own reading. */
export function isMeasuring(row: ProcessRow, root: number = process.pid): boolean {
  // The two ps runs see each other, one sometimes after the other has
  // exited, so without its command line: a ps the app started is one of them.
  if (row.ppid === root && exeName(row.name) === "ps") return true;
  return row.args.includes("pid=,ppid=,rss=") || row.args.includes("Win32_Process | Select-Object ProcessId");
}

let readProcessTable: ProcessTableReader = systemProcessTable;

/** Tests: read a made-up process table; no argument restores the system's. */
export function setProcessTableReader(reader?: ProcessTableReader): void {
  readProcessTable = reader ?? systemProcessTable;
  cachedMemory = null;
}

/** Two windows polling share one reading. */
const MEMORY_CACHE_MS = 2_000;
let cachedMemory: { at: number; snapshot: Promise<MemorySnapshot> } | null = null;

async function measureMemory(): Promise<MemorySnapshot> {
  const metrics = desktop?.metrics() ?? [];
  const isDesktop = desktop !== null;
  const base = { at: Date.now(), systemBytes: totalmem(), desktop: isDesktop };
  let rows: ProcessRow[];
  let error: string | undefined;
  try {
    // The commands reading the table are not what the app uses.
    rows = (await readProcessTable()).filter((r) => !isMeasuring(r));
    if (!rows.some((r) => r.pid === process.pid)) throw new Error("this process is not in the process list");
  } catch (e) {
    // Without the table, Electron's report (or this process alone) still says something.
    error = (e as Error).message;
    const main = { pid: process.pid, ppid: 0, bytes: process.memoryUsage().rss, name: isDesktop ? "SpecDriven" : "server", args: "" };
    rows = [main, ...metrics.filter((m) => m.pid !== process.pid).map((m) => ({ pid: m.pid, ppid: process.pid, bytes: m.bytes, name: m.type, args: "" }))];
  }
  const groups = groupProcesses(rows, process.pid, metrics, isDesktop);
  return { ...base, totalBytes: groups.reduce((n, g) => n + g.bytes, 0), groups, ...(error ? { error } : {}) };
}

export function memorySnapshot(): Promise<MemorySnapshot> {
  const now = Date.now();
  if (cachedMemory && now - cachedMemory.at < MEMORY_CACHE_MS) return cachedMemory.snapshot;
  const snapshot = measureMemory();
  cachedMemory = { at: now, snapshot };
  snapshot.catch(() => {
    cachedMemory = null;
  });
  return snapshot;
}

// ---------------------------------------------------------------------------
// Disk: measuring a folder

/** Bytes a file takes on disk: its allocated blocks where the system says, else its length. */
function onDisk(s: { blocks?: number; size: number }): number {
  return typeof s.blocks === "number" && s.blocks > 0 ? s.blocks * 512 : s.size;
}

/** Limits how many folders are read at once. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((go) => waiting.push(go));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export interface Walker {
  /** Bytes under `path` (a file or a folder); links are counted as links, never followed. 0 when it is not there. */
  size(path: string): Promise<number>;
}

/**
 * A walker that counts a hard-linked file once across every folder it
 * measures, and skips what it cannot read.
 */
export function walker(): Walker {
  const seen = new Set<string>();
  const limit = limiter(16);
  const entry = async (path: string): Promise<number> => {
    let s;
    try {
      s = await lstat(path);
    } catch {
      return 0;
    }
    if (s.nlink > 1 && !s.isDirectory()) {
      const key = `${s.dev}:${s.ino}`;
      if (seen.has(key)) return 0;
      seen.add(key);
    }
    if (!s.isDirectory()) return onDisk(s);
    let names: string[];
    try {
      names = await limit(() => readdir(path));
    } catch {
      return onDisk(s);
    }
    const sizes = await Promise.all(names.map((n) => entry(join(path, n))));
    return sizes.reduce((a, b) => a + b, onDisk(s));
  };
  return { size: entry };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function children(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** `child` is `parent` or inside it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Disk: the places

/** Where the app keeps things, resolved by the route (api.ts) so tests can point them at a temporary folder. */
export interface ResourcePlaces {
  /** `~/.specdriven`, or SPECDRIVEN_HOME. */
  home: string;
  /** Where the settings file is, with the agent session records and worktrees beside it. */
  settingsDir: string;
  /** The folder open now, if any. */
  openFolder: { path: string; kind: "spec" | "code" } | null;
  /** The log files, the one written now first; null when logging to a file is off. */
  logFiles: string[] | null;
  /** Worktree folders a running agent session works in. */
  liveWorktrees: ReadonlySet<string>;
}

export type CleanupKind = "worktree" | "logs" | "browser-cache" | "previous-version";

/** A cleanup a row offers: what it frees and what the confirmation must say. */
export interface CleanupOffer {
  kind: CleanupKind;
  /** The worktree folder or the version; absent for logs and the browser cache. */
  target?: string;
  /** The button: "Remove", "Clear", "Delete". */
  label: string;
  /** What the confirmation says goes for good. */
  warning: string;
  /** About how much it frees. */
  bytes: number;
  /** The server wants `force` for this one (a worktree with uncommitted changes). */
  force?: true;
  /** Why it cannot be done now (a running session works in it); the button is off. */
  blocked?: string;
}

export interface DiskEntry {
  id: string;
  label: string;
  path: string;
  bytes: number;
  /** "current version", "in use", "uncommitted changes"… */
  tags?: string[];
  cleanup?: CleanupOffer;
  children?: DiskEntry[];
}

export interface DiskGroup {
  id: string;
  label: string;
  bytes: number;
  entries: DiskEntry[];
}

export interface Volume {
  /** A folder on it, the first measured. */
  path: string;
  freeBytes: number;
  totalBytes: number;
}

export interface DiskSnapshot {
  at: number;
  totalBytes: number;
  groups: DiskGroup[];
  volumes: Volume[];
}

const APP_VERSION_DIR = /^specdriven-(\d[\w.+-]*?)$/;
const APP_VERSION_FILE = /^specdriven-(\d[\w.+-]*?)-src\.zip(?:\.sha256)?$/;

/** The installed versions under `<home>/app`: version → its folder and files. */
async function appVersions(appDir: string): Promise<{ current: string | null; versions: Map<string, string[]> }> {
  let current: string | null = null;
  try {
    const m = APP_VERSION_DIR.exec(basename(await readlink(join(appDir, "current"))));
    current = m ? m[1]! : null;
  } catch {
    // no current link: a development run, or nothing installed
  }
  const versions = new Map<string, string[]>();
  for (const name of await children(appDir)) {
    // The zip's name would pass for a version folder's, so it is matched first.
    const m = APP_VERSION_FILE.exec(name) ?? APP_VERSION_DIR.exec(name);
    if (!m) continue;
    const list = versions.get(m[1]!) ?? [];
    list.push(join(appDir, name));
    versions.set(m[1]!, list);
  }
  return { current, versions };
}

/** Electron's caches inside its app-data folder; nothing in them is needed again. */
const BROWSER_CACHE = /^(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GraphiteDawnCache|GrShaderCache|ShaderCache)$/;

/** The repo a worktree belongs to, from its `.git` file; null when that is not a worktree's or its repo is gone. */
async function worktreeRepo(worktree: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(worktree, ".git"), "utf8");
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const gitdir = resolve(worktree, m[1]!.trim());
  // <repo>/.git/worktrees/<name>
  if (basename(dirname(gitdir)) !== "worktrees") return null;
  const common = dirname(dirname(gitdir));
  if (!(await isDir(common))) return null;
  return basename(common) === ".git" ? dirname(common) : common;
}

async function hasChanges(worktree: string): Promise<boolean | null> {
  const r = await run("git", ["-C", worktree, "status", "--porcelain"], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: 30_000,
  });
  return r.exitCode === 0 ? r.stdout.trim() !== "" : null;
}

/** The worktree folders under `<settings dir>/worktrees/<repo>-<hash>/<name>`. */
async function worktreeFolders(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const repo of await children(root)) {
    const dir = join(root, repo);
    if (!(await isDir(dir))) continue;
    for (const name of await children(dir)) {
      const wt = join(dir, name);
      if (await isDir(wt)) out.push(wt);
    }
  }
  return out;
}

function group(id: string, label: string, entries: DiskEntry[]): DiskGroup {
  return { id, label, bytes: entries.reduce((n, e) => n + e.bytes, 0), entries };
}

const HOME_LABELS: Record<string, string> = {
  app: "App versions",
  logs: "Logs",
  plugins: "Plugins",
  "plugin-builds": "Plugin builds",
  "plugin-backups": "Plugin backups",
  marketplaces: "Plugin marketplaces",
  sessions: "Agent session records",
  worktrees: "Agent worktrees",
  "claude-code": "Claude Code",
  "self-fix": "Self-fix",
  secrets: "Secrets",
};

/**
 * Measure every place. `userData` is Electron's app-data folder, present in
 * the desktop app only.
 */
export async function measureDisk(places: ResourcePlaces, userData: string | null = desktop?.userData ?? null): Promise<DiskSnapshot> {
  const w = walker();
  const claimed: string[] = [];
  const measure = async (id: string, label: string, path: string, extra: Partial<DiskEntry> = {}): Promise<DiskEntry> => {
    claimed.push(path);
    return { id, label, path, bytes: await w.size(path), ...extra };
  };
  const groups: DiskGroup[] = [];

  // App: the installed versions, and Electron's app-data folder.
  const appDir = join(places.home, "app");
  const app: DiskEntry[] = [];
  const { current, versions } = await appVersions(appDir);
  for (const [version, files] of [...versions].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }))) {
    const sizes = await Promise.all(files.map((f) => w.size(f)));
    const bytes = sizes.reduce((a, b) => a + b, 0);
    const isCurrent = version === current;
    app.push({
      id: `app-version:${version}`,
      label: `Version ${version}`,
      path: files.find((f) => !APP_VERSION_FILE.test(basename(f))) ?? files[0]!,
      bytes,
      tags: isCurrent ? ["running"] : current ? ["kept to go back to"] : [],
      ...(isCurrent || !current
        ? {}
        : {
            cleanup: {
              kind: "previous-version" as const,
              target: version,
              label: "Delete",
              warning: `Version ${version} is deleted. It is kept so SpecDriven can go back to it if an update goes wrong; the next update keeps the version running now instead.`,
              bytes,
            },
          }),
    });
  }
  claimed.push(appDir);
  if (userData && (await isDir(userData))) {
    const cache: string[] = [];
    const rest: string[] = [];
    const reposDir = process.env.SPECDRIVEN_REPOS_DIR ? resolve(process.env.SPECDRIVEN_REPOS_DIR) : null;
    for (const name of await children(userData)) {
      const path = join(userData, name);
      if (BROWSER_CACHE.test(name)) cache.push(path);
      else if (path === reposDir) continue;
      else if (!within(places.home, path)) rest.push(path);
    }
    const cacheBytes = (await Promise.all(cache.map((p) => w.size(p)))).reduce((a, b) => a + b, 0);
    app.push({
      id: "browser-cache",
      label: "Browser cache",
      path: userData,
      bytes: cacheBytes,
      ...(cacheBytes > 0
        ? {
            cleanup: {
              kind: "browser-cache" as const,
              label: "Clear",
              warning: "The window's cached pages, scripts and images are deleted. Nothing you made is in them; pages may load a little slower once.",
              bytes: cacheBytes,
            },
          }
        : {}),
    });
    const restBytes = (await Promise.all(rest.map((p) => w.size(p)))).reduce((a, b) => a + b, 0);
    app.push({ id: "app-data", label: "App data", path: userData, bytes: restBytes });
    if (reposDir && within(userData, reposDir) && (await isDir(reposDir))) {
      const repos = await Promise.all(
        (await children(reposDir)).map((name) => measure(`repo:${name}`, name, join(reposDir, name))),
      );
      app.push({ id: "repos", label: "Cloned spec folders", path: reposDir, bytes: repos.reduce((n, r) => n + r.bytes, 0), children: repos });
    }
  }
  if (app.length) groups.push(group("app", "App", app));

  // The open folder: its files, its git history, and (a spec folder) its Automerge store.
  if (places.openFolder && (await isDir(places.openFolder.path))) {
    const dir = places.openFolder.path;
    const special = new Set([join(dir, ".git"), join(dir, ".specdriven", "automerge")]);
    // Each only where it is: a folder need not be a git repo, nor have edits yet.
    const git = (await exists(join(dir, ".git"))) ? await measure("folder-git", "Git history (.git)", join(dir, ".git")) : null;
    const automerge = join(dir, ".specdriven", "automerge");
    const store = places.openFolder.kind === "spec" && (await exists(automerge)) ? await measure("folder-automerge", "Edit history (Automerge)", automerge) : null;
    // Everything else: walk the top level by hand so the two above are not counted twice.
    let files = 0;
    for (const name of await children(dir)) {
      const path = join(dir, name);
      if (special.has(path)) continue;
      if (name === ".specdriven") {
        for (const sub of await children(path)) if (!special.has(join(path, sub))) files += await w.size(join(path, sub));
        continue;
      }
      files += await w.size(path);
    }
    claimed.push(dir);
    const entries: DiskEntry[] = [{ id: "folder-files", label: "Files", path: dir, bytes: files }];
    if (git) entries.push(git);
    if (store) entries.push(store);
    groups.push(group("folder", places.openFolder.kind === "spec" ? `Open spec folder: ${basename(dir)}` : `Open code repository: ${basename(dir)}`, entries));
  }

  // Agents: worktrees, session records, the Claude Code binaries the plugin downloads.
  const agents: DiskEntry[] = [];
  const worktreesDir = join(places.settingsDir, WORKTREES_SUBDIR);
  const live = new Set([...places.liveWorktrees].map((p) => resolve(p)));
  const wts: DiskEntry[] = [];
  for (const wt of await worktreeFolders(worktreesDir)) {
    const bytes = await w.size(wt);
    const repo = await worktreeRepo(wt);
    const changes = repo ? await hasChanges(wt) : null;
    const inUse = live.has(resolve(wt));
    const tags = [inUse ? "in use" : null, changes ? "uncommitted changes" : null, repo ? null : "repository gone"].filter(
      (t): t is string => t !== null,
    );
    wts.push({
      id: `worktree:${wt}`,
      label: `${basename(wt)}`,
      path: wt,
      bytes,
      tags,
      cleanup: {
        kind: "worktree",
        target: wt,
        label: "Remove",
        warning: !repo
          ? "Its repository is gone, so the folder is deleted as it is, with anything in it."
          : changes
            ? "It has uncommitted changes, and they are lost. Its branch and every commit on it stay in the repository."
            : "The folder goes. Its branch and every commit on it stay in the repository.",
        bytes,
        ...(changes || !repo ? { force: true as const } : {}),
        ...(inUse ? { blocked: "A running agent session works in it" } : {}),
      },
    });
  }
  claimed.push(worktreesDir);
  if (wts.length) {
    agents.push({ id: "worktrees", label: "Agent worktrees", path: worktreesDir, bytes: wts.reduce((n, e) => n + e.bytes, 0), children: wts });
  }
  const sessions = join(places.settingsDir, "sessions");
  if (await exists(sessions)) agents.push(await measure("sessions", "Agent session records", sessions));
  const claudeCode = join(places.home, "claude-code");
  if (await exists(claudeCode)) agents.push(await measure("claude-code", "Claude Code", claudeCode));
  if (agents.length) groups.push(group("agents", "Agents", agents));

  // Plugins.
  const plugins: DiskEntry[] = [];
  for (const name of ["plugins", "plugin-builds", "plugin-backups", "marketplaces"]) {
    const path = join(places.home, name);
    if (await exists(path)) plugins.push(await measure(name, HOME_LABELS[name]!, path));
  }
  if (plugins.length) groups.push(group("plugins", "Plugins", plugins));

  // Logs: the file written now stays; the rotated ones can go.
  if (places.logFiles && places.logFiles.length) {
    const dir = dirname(places.logFiles[0]!);
    const total = await measure("logs", "Logs", dir);
    let rotated = 0;
    for (const f of places.logFiles.slice(1)) rotated += await walker().size(f);
    if (rotated > 0) {
      total.cleanup = {
        kind: "logs",
        label: "Delete old logs",
        warning: "The rotated log files are deleted; the one being written now stays. Observability then shows only what was logged since it started.",
        bytes: rotated,
      };
    }
    groups.push(group("logs", "Logs", [total]));
  }

  // Whatever else is in the SpecDriven home: settings, tokens, self-fix.
  const other: DiskEntry[] = [];
  for (const name of await children(places.home)) {
    const path = join(places.home, name);
    if (claimed.some((c) => within(c, path) || within(path, c))) continue;
    other.push({ id: `home:${name}`, label: HOME_LABELS[name] ?? name, path, bytes: await w.size(path) });
  }
  if (other.length) {
    const bytes = other.reduce((n, e) => n + e.bytes, 0);
    groups.push(group("other", "Other", [{ id: "home-other", label: "Settings, tokens and other files", path: places.home, bytes, children: other }]));
  }

  // Free space on every disk involved, once each.
  const volumes: Volume[] = [];
  const devices = new Set<number>();
  for (const path of [places.home, userData, places.openFolder?.path].filter((p): p is string => !!p)) {
    try {
      const dev = (await stat(path)).dev;
      if (devices.has(dev)) continue;
      devices.add(dev);
      const fs = await statfs(path);
      volumes.push({ path, freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize });
    } catch {
      // not there
    }
  }

  for (const g of groups) if (g.id !== "app") g.entries.sort((a, b) => b.bytes - a.bytes);
  return { at: Date.now(), totalBytes: groups.reduce((n, g) => n + g.bytes, 0), groups, volumes };
}

let cachedDisk: Promise<DiskSnapshot> | null = null;

/** The last measurement, or a new one with `refresh` (or none yet). One walk at a time. */
export function diskSnapshot(places: () => Promise<ResourcePlaces>, refresh = false): Promise<DiskSnapshot> {
  if (cachedDisk && !refresh) return cachedDisk;
  const pending = cachedDisk;
  const next = (async () => {
    // A refresh asked for while a walk runs waits for it, then walks again.
    if (pending) await pending.catch(() => {});
    return measureDisk(await places());
  })();
  cachedDisk = next;
  next.catch(() => {
    if (cachedDisk === next) cachedDisk = null;
  });
  return next;
}

/** Tests: forget the last measurement. */
export function forgetDiskSnapshot(): void {
  cachedDisk = null;
}

// ---------------------------------------------------------------------------
// Cleanup

export class CleanupError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CleanupRequest {
  kind: CleanupKind;
  target?: string;
  force?: boolean;
}

export function checkCleanup(body: Record<string, unknown>): CleanupRequest | string {
  const kinds: CleanupKind[] = ["worktree", "logs", "browser-cache", "previous-version"];
  if (typeof body.kind !== "string" || !kinds.includes(body.kind as CleanupKind)) return `kind must be one of ${kinds.join(", ")}`;
  if (body.target !== undefined && typeof body.target !== "string") return "target must be a string";
  if (body.force !== undefined && typeof body.force !== "boolean") return "force must be true or false";
  if ((body.kind === "worktree" || body.kind === "previous-version") && !body.target) return `${body.kind} needs a target`;
  return { kind: body.kind as CleanupKind, ...(body.target ? { target: body.target as string } : {}), ...(body.force ? { force: true } : {}) };
}

async function sizeOf(paths: string[]): Promise<number> {
  const w = walker();
  return (await Promise.all(paths.map((p) => w.size(p)))).reduce((a, b) => a + b, 0);
}

async function removeWorktree(places: ResourcePlaces, target: string, force: boolean): Promise<number> {
  const root = resolve(places.settingsDir, WORKTREES_SUBDIR);
  const wt = resolve(target);
  // Only a folder two levels under the worktrees folder: <repo>-<hash>/<name>.
  const rel = relative(root, wt);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).length !== 2) {
    throw new CleanupError(400, `Not an agent worktree: ${target}`);
  }
  if (!(await isDir(wt))) throw new CleanupError(404, `Worktree not found: ${target}`);
  if ([...places.liveWorktrees].some((p) => resolve(p) === wt)) {
    throw new CleanupError(409, "A running agent session works in this worktree; close the session first");
  }
  const bytes = await sizeOf([wt]);
  const repo = await worktreeRepo(wt);
  if (!repo) {
    if (!force) throw new CleanupError(409, "Its repository is gone; removing it deletes the folder as it is");
    await rm(wt, { recursive: true, force: true });
    return bytes;
  }
  const changes = await hasChanges(wt);
  if (changes && !force) throw new CleanupError(409, "The worktree has uncommitted changes");
  const git = (args: string[]) => run("git", ["-C", repo, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 60_000 });
  const removed = await git(["worktree", "remove", ...(force ? ["--force"] : []), wt]);
  if (removed.exitCode !== 0) throw new CleanupError(500, `git worktree remove failed: ${removed.stderr.trim()}`);
  await git(["worktree", "prune"]);
  // The <repo>-<hash> folder goes with its last worktree.
  const parent = dirname(wt);
  if ((await children(parent)).length === 0) await rm(parent, { recursive: true, force: true });
  return bytes;
}

async function deleteRotatedLogs(places: ResourcePlaces): Promise<number> {
  if (!places.logFiles || places.logFiles.length < 2) return 0;
  const old = places.logFiles.slice(1);
  const bytes = await sizeOf(old);
  for (const f of old) await rm(f, { force: true });
  return bytes;
}

async function deleteVersion(places: ResourcePlaces, version: string): Promise<number> {
  const appDir = join(places.home, "app");
  const { current, versions } = await appVersions(appDir);
  const files = versions.get(version);
  if (!files) throw new CleanupError(404, `Version ${version} is not installed`);
  if (!current) throw new CleanupError(409, "No version is marked as running, so none is deleted");
  if (version === current) throw new CleanupError(409, `Version ${version} is the one running`);
  // The running app may also be a version the link no longer names (an update waiting for a restart).
  const running = await realpath(join(appDir, "current")).catch(() => null);
  if (running && files.some((f) => resolve(f) === running)) throw new CleanupError(409, `Version ${version} is the one running`);
  const bytes = await sizeOf(files);
  for (const f of files) await rm(f, { recursive: true, force: true });
  return bytes;
}

/** Run a cleanup; answers how many bytes it freed. The disk measurement is forgotten either way. */
export async function cleanUp(places: ResourcePlaces, req: CleanupRequest): Promise<{ freedBytes: number }> {
  try {
    switch (req.kind) {
      case "worktree":
        return { freedBytes: await removeWorktree(places, req.target!, req.force === true) };
      case "logs":
        return { freedBytes: await deleteRotatedLogs(places) };
      case "previous-version":
        return { freedBytes: await deleteVersion(places, req.target!) };
      case "browser-cache": {
        if (!desktop) throw new CleanupError(409, "There is a browser cache to clear in the desktop app only");
        const paths = (await children(desktop.userData)).filter((n) => BROWSER_CACHE.test(n)).map((n) => join(desktop!.userData, n));
        const before = await sizeOf(paths);
        await desktop.clearBrowserCache();
        const after = await sizeOf(paths);
        return { freedBytes: Math.max(0, before - after) };
      }
    }
  } finally {
    cachedDisk = null;
  }
}

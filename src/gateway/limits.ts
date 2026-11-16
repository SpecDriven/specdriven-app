// What one person's worker may use of the container it shares
// (docs/hosted-tenant-isolation.md "Step 1", specs/app/hosted-app.feature.md
// "One person cannot use up what the others need"): how many processes and
// open files, how much of the volume and how much memory. The first two are
// the kernel's to enforce (`prlimit`, workers.ts); the others the gateway
// measures on its sweep, since the container gives it no way to cap them.
//
// Every command that looks inside a person's folder runs as that person's
// uid (asUser), never as root: the folder's contents are theirs to arrange.

import { readFile, statfs } from "node:fs/promises";
import { run, type RunResult } from "../server/run";

type Env = Record<string, string | undefined>;

/** Workers run as uids from here up — clear of any account the image has. */
export const OS_UID_BASE = 200_000;
/** The uid the gateway itself runs as once the spawner has started it (spawner.ts): no worker's, and not root. */
export const GATEWAY_UID = 199_000;

export interface WorkerLimits {
  /** Processes and threads one person's uid may have at once. */
  processes: number;
  /** Files one process may hold open. */
  openFiles: number;
  /** A person's folder may grow to this many megabytes; null for no budget. */
  maxDiskMb: number | null;
  /** A worker's resident memory may reach this many megabytes; null for no budget. */
  maxMemoryMb: number | null;
  /** No worker starts while the volume has less than this many megabytes free. */
  minFreeMb: number;
}

export const DEFAULT_LIMITS: WorkerLimits = {
  // A Bun server and the git it runs keep some dozens of threads; this
  // leaves room for that many times over and still stops a fork bomb.
  processes: 512,
  openFiles: 4096,
  maxDiskMb: null,
  maxMemoryMb: null,
  // Room for the gateway's own database and datastore clone.
  minFreeMb: 256,
};

function positive(value: string | undefined): number | null {
  const n = Number(value?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** The limits from the environment; what is unset keeps its default. */
export function readWorkerLimits(env: Env = process.env): WorkerLimits {
  return {
    processes: positive(env.SPECDRIVEN_WORKER_MAX_PROCESSES) ?? DEFAULT_LIMITS.processes,
    openFiles: positive(env.SPECDRIVEN_WORKER_MAX_OPEN_FILES) ?? DEFAULT_LIMITS.openFiles,
    maxDiskMb: positive(env.SPECDRIVEN_WORKER_MAX_DISK_MB),
    maxMemoryMb: positive(env.SPECDRIVEN_WORKER_MAX_MEMORY_MB),
    minFreeMb: positive(env.SPECDRIVEN_MIN_FREE_MB) ?? DEFAULT_LIMITS.minFreeMb,
  };
}

/** Where the operating system's own tools are, whatever PATH the gateway was started with. */
export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The full path of one of the system's tools (setpriv, prlimit, chown, du,
 * head), or null where it is not installed. Root runs these, so they are
 * looked up in the system's folders first, not wherever PATH points.
 */
export function systemTool(name: string): string | null {
  return Bun.which(name, { PATH: SYSTEM_PATH }) ?? Bun.which(name);
}

/**
 * The prefix that runs a command as `uid`: no other groups, and no way to
 * gain privileges again.
 */
export function asUser(uid: number): string[] {
  const setpriv = systemTool("setpriv") ?? "setpriv";
  return [setpriv, `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--"];
}

/**
 * Run a command as `uid`, or as the gateway's own user when there is none.
 * Its environment is PATH alone: a process running as a person's uid is one
 * that person's worker can inspect, so the gateway's keys must not be in it.
 */
export function runAs(uid: number | null, argv: string[], timeoutMs: number): Promise<RunResult> {
  const [tool, ...rest] = argv;
  const [cmd, ...args] = [...(uid === null ? [] : asUser(uid)), systemTool(tool!) ?? tool!, ...rest];
  return run(cmd!, args, { timeoutMs, env: { PATH: SYSTEM_PATH } });
}

/** Megabytes a folder holds, measured as `uid` when there is one; null when it cannot be measured. */
export async function diskUsageMb(dir: string, uid: number | null): Promise<number | null> {
  const res = await runAs(uid, ["du", "-sk", dir], 60_000);
  const kb = Number(res.stdout.trim().split(/\s+/)[0]);
  // du answers non-zero for a file that went away mid-walk; its total stands.
  return Number.isFinite(kb) && res.stdout.trim() ? kb / 1024 : null;
}

/** Megabytes of memory a process holds, from /proc; null where there is no /proc. */
export async function residentMb(pid: number): Promise<number | null> {
  try {
    const pages = Number((await readFile(`/proc/${pid}/statm`, "utf8")).split(" ")[1]);
    return Number.isFinite(pages) ? (pages * 4096) / (1024 * 1024) : null;
  } catch {
    return null;
  }
}

/** Megabytes free on the volume a folder is on; null when it cannot be told. */
export async function freeMb(dir: string): Promise<number | null> {
  try {
    const fs = await statfs(dir);
    return (fs.bavail * fs.bsize) / (1024 * 1024);
  } catch {
    return null;
  }
}

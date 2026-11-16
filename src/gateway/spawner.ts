// The part of the hosted gateway that stays root
// (docs/hosted-tenant-isolation.md "Step 2", specs/app/hosted-app.feature.md
// "The part that answers the internet is not root"). Giving each worker a
// uid of its own takes root; answering HTTP, signing people in and holding
// the master key do not. So root keeps only this: it makes a person's
// folders, starts their worker as their uid, stops it, and reports on it.
// Those are its three requests. It never parses HTTP and opens no network
// connection.
//
// In the hosted image it is a process of its own (spawnerMain.ts) that the
// gateway reaches over a unix socket (spawnerSocket.ts), and whatever asks
// may be a gateway someone has taken over. So nothing in a request picks
// what root does:
//
//   - the paths root touches come from the user id, which must be a UUID,
//     under the data folder the spawner itself was started with;
//   - the uid must be a worker's, never root's or the gateway's;
//   - the worker's environment is the gateway's to choose, and reaches no
//     program that runs as root: the tools that drop to the worker's uid
//     get an environment of PATH alone, and the launcher applies the
//     worker's own once it is that uid (launcher.ts);
//   - the program that runs is the one the spawner was started with.
//
// Where the gateway is one process (development, tests) the pool uses a
// Spawner directly.

import type { Subprocess } from "bun";
import { chmod, lchown, lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  asUser,
  DEFAULT_LIMITS,
  diskUsageMb,
  OS_UID_BASE,
  residentMb,
  runAs,
  SYSTEM_PATH,
  systemTool,
  type WorkerLimits,
} from "./limits";
import { readSettingsText, type SettingsText } from "./repos";
import { sandboxSpec, type LaunchSpec } from "./sandbox";

/** A Linux uid is at most this; a worker's is from OS_UID_BASE up. */
const MAX_UID = 2_000_000_000;

export interface StartRequest {
  userId: string;
  /** The uid the worker runs as; null runs it as the spawner's own user (development, tests). */
  uid: number | null;
  /** Names this start, so its end can be told from an earlier worker's. */
  instance: string;
  /** The worker's whole environment. */
  env: Record<string, string>;
  limits: Pick<WorkerLimits, "processes" | "openFiles">;
  /** The one local port the worker may connect to (egress.ts); null leaves its network alone. */
  egressPort: number | null;
}

export interface StopRequest {
  userId: string;
  uid: number | null;
}

export interface ReportRequest {
  userId: string;
  uid: number | null;
  /** Also read the worker's settings file, as its uid. */
  settings?: boolean;
  /** Also measure the person's folder, as its uid. */
  disk?: boolean;
}

export interface WorkerReport {
  running: boolean;
  /** Megabytes of memory the worker holds; null when it is not running or cannot be told. */
  residentMb: number | null;
  diskMb?: number | null;
  /** The settings file's text, unparsed: root reads it, the gateway makes sense of it. */
  settings?: SettingsText | null;
}

export interface WorkerExit {
  userId: string;
  instance: string;
  code: number | null;
}

/** What the worker pool asks of whatever starts its workers (workers.ts). */
export interface SpawnerApi {
  /** Make the person's folders, end anything left running as the uid, and start the worker. */
  start(req: StartRequest): Promise<void>;
  /** Stop the worker and every other process of its uid; with no worker, the uid is still cleared. */
  stop(req: StopRequest): Promise<void>;
  report(req: ReportRequest): Promise<WorkerReport>;
  /** Told when a worker's process has ended, however it ended, and nothing of its uid is left. */
  onExit(listener: (exit: WorkerExit) => void): void;
}

/**
 * Whether workers can run as uids of their own: this process is root and
 * `setpriv` is installed. SPECDRIVEN_WORKER_ISOLATION=off turns it off.
 */
export function workerIsolation(env: Record<string, string | undefined> = process.env): boolean {
  if (env.SPECDRIVEN_WORKER_ISOLATION === "off") return false;
  return process.getuid?.() === 0 && systemTool("setpriv") !== null;
}

/** The launcher a worker with a uid starts through (launcher.ts). */
export const LAUNCHER = join(import.meta.dir, "launcher.ts");

/**
 * The command that starts a worker. Without a uid it is the app itself.
 * With one it drops to that uid — under the kernel's own caps on how many
 * processes the uid may have and how many files each may hold open
 * (`prlimit`, in the image beside `setpriv`) — and runs the launcher, which
 * reads what to start from its input: nothing the gateway chose is on this
 * command line or in its environment.
 */
export function workerCommand(entry: string, uid: number | null, limits: Pick<WorkerLimits, "processes" | "openFiles"> = DEFAULT_LIMITS): string[] {
  if (uid === null) return [process.execPath, entry];
  const prlimit = systemTool("prlimit");
  const capped = prlimit ? [prlimit, `--nproc=${limits.processes}`, `--nofile=${limits.openFiles}`, "--"] : [];
  return [...capped, ...asUser(uid), process.execPath, LAUNCHER];
}

/**
 * The processes running as `uid`, from /proc — each is a folder there that
 * its uid owns. One that has ended and only waits to be collected (a
 * zombie) runs nothing and is left out. Empty where there is no /proc.
 */
export async function pidsOf(uid: number): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const owner = await stat(`/proc/${entry}`).then(
      (info) => info.uid,
      () => null,
    );
    if (owner !== uid) continue;
    // "pid (name) S …": the state follows the name, which may itself hold ")".
    const line = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
    if (line.slice(line.lastIndexOf(")") + 2, line.lastIndexOf(")") + 3) === "Z") continue;
    pids.push(Number(entry));
  }
  return pids;
}

/**
 * End every process running as a worker's uid (endProcesses.ts): the worker
 * itself is one process, but what it started and detached would otherwise
 * outlive a sign-out, a password reset or a changed token, still holding
 * the old token. It is done as that uid, so the kernel keeps it to that
 * person's processes whatever uid it is handed.
 *
 * A process of that uid can end the one sent to end it first. So root then
 * looks, and ends by itself whatever is left — one at a time, which the
 * worker's processes cannot stop.
 */
export async function endProcessesOf(uid: number): Promise<void> {
  if (!Number.isInteger(uid) || uid < OS_UID_BASE) throw new Error(`Not a worker uid: ${uid}`);
  const res = await runAs(uid, [process.execPath, join(import.meta.dir, "endProcesses.ts")], 15_000);
  if (res.exitCode !== 0) console.error(`ending the processes of uid ${uid} failed: ${res.stderr.trim()}`);
  if (process.getuid?.() !== 0) return;
  for (let round = 0; round < 100; round++) {
    const left = await pidsOf(uid);
    if (left.length === 0) return;
    if (round === 0) console.error(`${left.length} processes of uid ${uid} outlived their ending: root ends them`);
    for (const pid of left) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone in the meantime.
      }
    }
    await Bun.sleep(20);
  }
  throw new Error(`The processes of uid ${uid} could not be ended`);
}

export function userDirs(dataDir: string, userId: string) {
  // User ids are UUIDs the gateway made (accounts.ts); refuse anything else
  // so no id can name a path outside users/.
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/.test(userId)) throw new Error(`Not a user id: ${userId}`);
  const base = join(dataDir, "users", userId);
  return {
    base,
    home: join(base, "home"),
    root: join(base, "root"),
    repos: join(base, "repos"),
    run: join(base, "run"),
    tmp: join(base, "tmp"),
    socket: join(base, "run", "app.sock"),
  };
}

// ---------------------------------------------------------------------------
// What a request must look like before root acts on it.

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function whole(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${what} is not a whole number from ${min} to ${max}`);
  }
  return value;
}

function workerUid(value: unknown, requireUid: boolean): number | null {
  if (value === null || value === undefined) {
    if (requireUid) throw new Error("A worker's uid is required");
    return null;
  }
  return whole(value, OS_UID_BASE, MAX_UID, "The uid");
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENV_ENTRIES = 512;
const MAX_ENV_BYTES = 512 * 1024;

function environment(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  let bytes = 0;
  const entries = Object.entries(object(value, "The environment"));
  if (entries.length > MAX_ENV_ENTRIES) throw new Error("The environment has too many variables");
  for (const [name, text] of entries) {
    if (!ENV_NAME.test(name)) throw new Error("An environment variable's name is not a name");
    if (typeof text !== "string" || text.includes("\0")) throw new Error(`The value of ${name} is not text`);
    bytes += name.length + text.length;
    env[name] = text;
  }
  if (bytes > MAX_ENV_BYTES) throw new Error("The environment is too large");
  return env;
}

export interface CheckOptions {
  /** Refuse a request with no uid: the spawner that is root never runs a worker as itself. */
  requireUid?: boolean;
}

/** A start request as the spawner accepts it, or a thrown reason. */
export function checkStart(raw: unknown, opts: CheckOptions = {}): StartRequest {
  const req = object(raw, "The request");
  const limits = object(req.limits, "The limits");
  const userId = req.userId as string;
  userDirs("/", userId);
  if (typeof req.instance !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(req.instance)) {
    throw new Error("The instance is not a short name");
  }
  return {
    userId,
    uid: workerUid(req.uid, opts.requireUid ?? false),
    instance: req.instance,
    env: environment(req.env),
    limits: {
      processes: whole(limits.processes, 1, 1_000_000, "The process cap"),
      openFiles: whole(limits.openFiles, 16, 1_048_576, "The open-file cap"),
    },
    egressPort: req.egressPort === null || req.egressPort === undefined ? null : whole(req.egressPort, 1, 65_535, "The port"),
  };
}

export function checkStop(raw: unknown, opts: CheckOptions = {}): StopRequest {
  const req = object(raw, "The request");
  const userId = req.userId as string;
  userDirs("/", userId);
  return { userId, uid: workerUid(req.uid, opts.requireUid ?? false) };
}

export function checkReport(raw: unknown, opts: CheckOptions = {}): ReportRequest {
  const req = object(raw, "The request");
  return { ...checkStop(raw, opts), settings: req.settings === true, disk: req.disk === true };
}

// ---------------------------------------------------------------------------

export interface SpawnerOptions {
  /** The volume; each person's folders go under users/<id>. */
  dataDir: string;
  /** The app's server entry point (src/index.ts): what every worker runs. */
  entry: string;
  /**
   * The gateway's group where the gateway is a process of its own: the only
   * one, besides the worker, let into the folder a worker's socket is in.
   */
  gatewayGid?: number | null;
  /** Whether a worker with a uid is also confined by the kernel (sandbox.ts); on unless said otherwise. */
  sandbox?: boolean;
  /** Where a worker's output goes; the spawner's own by default. */
  stdio?: "inherit" | "ignore";
}

interface Child {
  proc: Subprocess;
  uid: number | null;
  /** Settled once the process is gone, its uid cleared and the listeners told. */
  done: Promise<void>;
}

export class Spawner implements SpawnerApi {
  private children = new Map<string, Child>();
  /** The clean-up after each person's last worker; their next start waits for it. */
  private settling = new Map<string, Promise<void>>();
  /** One request about a person at a time. */
  private queues = new Map<string, Promise<unknown>>();
  private listeners: ((exit: WorkerExit) => void)[] = [];

  constructor(private opts: SpawnerOptions) {}

  onExit(listener: (exit: WorkerExit) => void): void {
    this.listeners.push(listener);
  }

  private serial<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(userId) ?? Promise.resolve()).then(work, work);
    const tail = next.catch(() => {});
    this.queues.set(userId, tail);
    void tail.then(() => {
      if (this.queues.get(userId) === tail) this.queues.delete(userId);
    });
    return next;
  }

  start(req: StartRequest): Promise<void> {
    return this.serial(req.userId, async () => {
      const dirs = userDirs(this.opts.dataDir, req.userId);
      const running = this.children.get(req.userId);
      if (running) await this.end(running);
      // Nothing of an earlier worker's is left running as this uid — and so
      // nothing of it can rearrange the folders while root prepares them.
      await this.settling.get(req.userId);
      if (req.uid !== null) await endProcessesOf(req.uid);
      await this.prepareDirs(dirs, req.uid);
      // Unlinking never follows a link, and `run` is a folder root just checked.
      await rm(dirs.socket, { force: true });
      const proc = this.spawn(dirs, req);
      const child: Child = { proc, uid: req.uid, done: Promise.resolve() };
      child.done = proc.exited.then(async (code) => {
        if (this.children.get(req.userId) === child) this.children.delete(req.userId);
        // It may have gone by itself: clear what it left running.
        if (req.uid !== null) {
          await endProcessesOf(req.uid).catch((e: Error) =>
            console.error(`clearing up after the worker of ${req.userId} failed: ${e.message}`),
          );
        }
        for (const listener of this.listeners) listener({ userId: req.userId, instance: req.instance, code });
      });
      this.children.set(req.userId, child);
      this.settling.set(req.userId, child.done);
      void child.done.then(() => {
        if (this.settling.get(req.userId) === child.done) this.settling.delete(req.userId);
      });
    });
  }

  stop(req: StopRequest): Promise<void> {
    return this.serial(req.userId, async () => {
      const running = this.children.get(req.userId);
      if (running) return this.end(running);
      // With no worker there may still be something one left behind.
      await this.settling.get(req.userId);
      if (req.uid !== null) await endProcessesOf(req.uid);
    });
  }

  async report(req: ReportRequest): Promise<WorkerReport> {
    const dirs = userDirs(this.opts.dataDir, req.userId);
    const child = this.children.get(req.userId);
    const report: WorkerReport = { running: Boolean(child), residentMb: child ? await residentMb(child.proc.pid) : null };
    if (req.settings) report.settings = await readSettingsText(dirs.root, req.uid);
    if (req.disk) report.diskMb = await diskUsageMb(dirs.base, req.uid);
    return report;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.children.values()].map((child) => this.end(child)));
  }

  /** Stop a worker and wait until its uid is cleared. */
  private async end(child: Child): Promise<void> {
    if (child.proc.exitCode === null && child.proc.signalCode === null) {
      child.proc.kill("SIGTERM");
      const exited = await Promise.race([child.proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
      if (!exited) child.proc.kill("SIGKILL");
    }
    await child.done;
  }

  private spawn(dirs: ReturnType<typeof userDirs>, req: StartRequest): Subprocess {
    const stdio = this.opts.stdio ?? "inherit";
    if (req.uid === null) {
      return Bun.spawn(workerCommand(this.opts.entry, null), {
        cwd: dirs.root,
        env: req.env,
        stdin: "ignore",
        stdout: stdio,
        stderr: stdio,
      });
    }
    const spec: LaunchSpec = {
      argv: [process.execPath, this.opts.entry],
      cwd: dirs.root,
      env: req.env,
      sandbox:
        this.opts.sandbox === false
          ? null
          : sandboxSpec({
              own: [dirs.home, dirs.root, dirs.repos, dirs.run, dirs.tmp],
              code: [dirname(dirname(this.opts.entry)), dirname(process.execPath)],
              connectPort: req.egressPort,
            }),
    };
    const proc = Bun.spawn(workerCommand(this.opts.entry, req.uid, req.limits), {
      cwd: "/",
      // Root's own tools, and the launcher until it is the worker: nothing
      // the request carries, and no cache written on the way.
      env: { PATH: SYSTEM_PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdin: "pipe",
      stdout: stdio,
      stderr: stdio,
    });
    try {
      proc.stdin.write(JSON.stringify(spec));
      void Promise.resolve(proc.stdin.end()).catch(() => {});
    } catch {
      // The launcher went before it read: its exit says so.
    }
    return proc;
  }

  /**
   * The person's folders. Without separate uids they are the spawner's own,
   * 0700. With them, the top folder is root's — the worker's group may pass
   * through and list it, but only root can add, rename or replace an entry
   * — and the five folders in it are the worker's, 0700. So each name root
   * opens here is a folder root made, never a link a worker put in its
   * place; the folders above are 0711, passable but not listable.
   *
   * Where the gateway is a process of its own it is neither root nor the
   * worker, and must still reach the worker's socket: the top folder lets
   * others pass through (0751, still not list), and `run` belongs to the
   * gateway's group as well (0750). The other four stay the worker's alone.
   */
  private async prepareDirs(dirs: ReturnType<typeof userDirs>, uid: number | null): Promise<void> {
    const users = join(this.opts.dataDir, "users");
    await mkdir(users, { recursive: true, mode: 0o711 });
    const own = [dirs.home, dirs.root, dirs.repos, dirs.run, dirs.tmp];
    if (uid === null) {
      for (const dir of [dirs.base, ...own]) await mkdir(dir, { recursive: true, mode: 0o700 });
      return;
    }
    const gatewayGid = this.opts.gatewayGid ?? null;
    const baseMode = gatewayGid === null ? 0o750 : 0o751;
    await chmod(this.opts.dataDir, 0o711);
    await chmod(users, 0o711);
    await folder(dirs.base, baseMode);
    // A top folder from before this rule belonged to the worker: take it back.
    await lchown(dirs.base, 0, uid);
    await chmod(dirs.base, baseMode);
    for (const dir of own) {
      const owner = (await folder(dir, 0o700)).uid;
      if (owner === uid) continue;
      // Root's own: just made, or from before workers had uids. No worker
      // could write in it, so handing over what it holds follows no link of
      // a worker's. Anyone else's is not this person's folder at all.
      if (owner !== 0) throw new Error(`${dir} belongs to uid ${owner}, not to this worker's ${uid}`);
      const chown = Bun.spawn([systemTool("chown") ?? "chown", "-R", "-h", `${uid}:${uid}`, dir], {
        env: { PATH: SYSTEM_PATH },
        stdout: "ignore",
        stderr: "pipe",
      });
      if ((await chown.exited) !== 0) {
        throw new Error(`chown of ${dir} failed: ${await new Response(chown.stderr).text()}`);
      }
    }
    if (gatewayGid !== null) {
      // `run` is a folder root just looked at, in a folder only root can
      // change, with nothing running as the worker: no link to follow.
      await lchown(dirs.run, uid, gatewayGid);
      await chmod(dirs.run, 0o750);
    }
  }
}

/**
 * Make the folder at `path` unless something is there already, and answer
 * what is there — which must be a folder itself, not a link to one: root
 * goes on to change its owner.
 */
export async function folder(path: string, mode: number) {
  await mkdir(path, { mode }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error(`${path} is not a folder`);
  return info;
}

// One app server per signed-in user (docs/deployment-railway.md
// "Architecture"): the app is single-user by design — one settings file, one
// GitHub token, one data repo — so instead of teaching it about users, each
// user gets their own copy of it, started on first use with their own
// folders and their own decrypted secrets, listening on a unix socket in a
// folder only this process can read. The gateway proxies to it (proxy.ts)
// and stops it after a while unused; it starts again on the next request.
//
// The worker's environment is built from scratch, never copied from the
// gateway's: the master key, the mail service key and the other users'
// secrets must not reach it.
//
// Where the gateway runs as root (the Railway image), each worker also runs
// as a Linux uid of its own (`setpriv`), and its folders belong to that uid
// with mode 0700. A user controls their data repo's contents, symlinks
// included, so a folder kept apart only by convention would not be apart:
// with separate uids the kernel refuses one worker another's files, the
// gateway's database and the gateway's own environment.
//
// The same reasoning binds the gateway (docs/hosted-tenant-isolation.md
// "Step 1"): as root it would follow a symlink a worker left anywhere it
// looked. So root keeps each person's top folder for itself — its five
// entries are fixed, the worker can read them but not rename or replace
// them — and never opens anything inside them. What must happen in there
// (the git author, the remembered repos, reading the settings, measuring
// the folder) the worker does for itself (workerStart.ts) or the gateway
// does as that person's uid (limits.ts runAs).

import type { Subprocess } from "bun";
import { chmod, lchown, lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { agentKeyEnvName } from "../server/agentKeys";
import { TOKEN_ENV } from "../server/tokenStore";
import { OS_UID_BASE } from "./accounts";
import {
  asUser,
  DEFAULT_LIMITS,
  diskUsageMb,
  freeMb,
  residentMb,
  runAs,
  systemTool,
  type WorkerLimits,
} from "./limits";
import { cleanRepos, HOSTED_REPOS_ENV, readWorkerRepos } from "./repos";
import type { UserSecrets } from "./secrets";

/** Variables a worker inherits from the gateway: runtime, logging, network. */
const PASSTHROUGH = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_ENV",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SPECDRIVEN_LOG_FILE",
  "SPECDRIVEN_LOG_LEVEL",
  "SPECDRIVEN_DEBUG",
  "SPECDRIVEN_GITHUB_URL",
  "SPECDRIVEN_GITHUB_API_URL",
];

export interface WorkerPoolOptions {
  /** The volume; each user's folders go under users/<id>. */
  dataDir: string;
  /** The app's server entry point (src/index.ts). */
  entry: string;
  /** Stop a worker unused for this long. */
  idleMs: number;
  /** The user's secrets, opened, for the worker's environment. */
  secrets(userId: string): Promise<UserSecrets>;
  /** The account's email, which the app shows as its user. */
  emailOf?(userId: string): string | null;
  /**
   * The Linux uid to run the user's worker as, or absent to run workers as
   * the gateway's own user (development, tests). See workerIsolation().
   */
  osUid?(userId: string): number;
  /**
   * The user's remembered data repos (repos.ts): written into a worker that
   * starts with no settings file, and read back while it runs and as it
   * stops, so a redeploy that loses the volume still opens their repo.
   */
  repos?: { get(userId: string): string[]; set(userId: string, repos: string[]): unknown };
  /** What one worker may use of the shared container (limits.ts); the defaults when absent. */
  limits?: WorkerLimits;
  /** The environment the passthrough variables come from. */
  baseEnv?: Record<string, string | undefined>;
  startTimeoutMs?: number;
  /** Where a worker's output goes; the gateway's own by default. */
  stdio?: "inherit" | "ignore";
}

interface Running {
  proc: Subprocess;
  /** The uid it runs as; null when workers share the gateway's user. */
  uid: number | null;
  socket: string;
  lastUsed: number;
  stopping: boolean;
}

/** Repeated crashes of one user's worker back off instead of looping. */
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const CRASH_PAUSE_MS = 30_000;

export class WorkerUnavailableError extends Error {}

/**
 * Whether workers can run as uids of their own: the gateway is root and
 * `setpriv` is installed. SPECDRIVEN_WORKER_ISOLATION=off turns it off.
 */
export function workerIsolation(env: Record<string, string | undefined> = process.env): boolean {
  if (env.SPECDRIVEN_WORKER_ISOLATION === "off") return false;
  return process.getuid?.() === 0 && systemTool("setpriv") !== null;
}

/**
 * The command that starts a worker, as `uid` when there is one — and then
 * under the kernel's own caps on how many processes that uid may have and
 * how many files each may hold open (`prlimit`, in the image beside
 * `setpriv`), so one person's runaway worker cannot starve the others.
 */
export function workerCommand(entry: string, uid: number | null, limits: WorkerLimits = DEFAULT_LIMITS): string[] {
  const bun = [process.execPath, entry];
  if (uid === null) return bun;
  const prlimit = systemTool("prlimit");
  const capped = prlimit ? [prlimit, `--nproc=${limits.processes}`, `--nofile=${limits.openFiles}`, "--"] : [];
  return [...capped, ...asUser(uid), ...bun];
}

/**
 * End every process running as a worker's uid (endProcesses.ts): the worker
 * itself is one process, but what it started and detached would otherwise
 * outlive a sign-out, a password reset or a changed token, still holding
 * the old token. Run as that uid, so the kernel keeps it to that person's
 * processes whatever uid it is handed.
 */
export async function endProcessesOf(uid: number): Promise<void> {
  if (!Number.isInteger(uid) || uid < OS_UID_BASE) throw new Error(`Not a worker uid: ${uid}`);
  const res = await runAs(uid, [process.execPath, join(import.meta.dir, "endProcesses.ts")], 15_000);
  if (res.exitCode !== 0) console.error(`ending the processes of uid ${uid} failed: ${res.stderr.trim()}`);
}

export function userDirs(dataDir: string, userId: string) {
  // User ids are UUIDs the gateway made (accounts.ts); refuse anything else
  // so no id can name a path outside users/.
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error(`Not a user id: ${userId}`);
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

/** The environment a user's worker starts with. */
export function workerEnv(
  dirs: ReturnType<typeof userDirs>,
  secrets: UserSecrets,
  base: Record<string, string | undefined> = process.env,
  email: string | null = null,
  repos: string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(base)) {
    if (name.startsWith("OTEL_") && value !== undefined) env[name] = value;
  }
  Object.assign(env, {
    HOME: dirs.home,
    XDG_CONFIG_HOME: join(dirs.home, ".config"),
    // A temp folder of its own: /tmp is every worker's.
    TMPDIR: dirs.tmp,
    SPECDRIVEN_ROOT: dirs.root,
    SPECDRIVEN_REPOS_DIR: dirs.repos,
    SPECDRIVEN_HOSTED: "1",
    SPECDRIVEN_UNIX_SOCKET: dirs.socket,
    // Only the gateway reaches the socket, and it checks Host and Origin
    // itself before forwarding the request unchanged.
    SPECDRIVEN_ALLOWED_HOSTS: "*",
    // git must fail rather than wait for a password nobody will type.
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  if (email) env.SPECDRIVEN_ACCOUNT_EMAIL = email;
  const remembered = cleanRepos(repos);
  if (remembered.length) env[HOSTED_REPOS_ENV] = JSON.stringify(remembered);
  if (secrets.github) env[TOKEN_ENV] = JSON.stringify(secrets.github);
  for (const [name, value] of Object.entries(secrets.agentKeys)) env[agentKeyEnvName(name)] = value;
  return env;
}

export class WorkerPool {
  private running = new Map<string, Running>();
  private starting = new Map<string, Promise<Running>>();
  private crashes = new Map<string, number[]>();
  /** The clean-up after a worker that exited by itself; the next start waits for it. */
  private settling = new Map<string, Promise<void>>();
  /** People whose folder was over its budget when last measured, and by how much. */
  private overDisk = new Map<string, number>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: WorkerPoolOptions) {}

  private get limits(): WorkerLimits {
    return this.opts.limits ?? DEFAULT_LIMITS;
  }

  private uidOf(userId: string): number | null {
    return this.opts.osUid ? this.opts.osUid(userId) : null;
  }

  /** The socket of the user's worker, starting it when it is not running. */
  async socketFor(userId: string): Promise<string> {
    const live = this.running.get(userId);
    if (live && !live.stopping) {
      live.lastUsed = Date.now();
      return live.socket;
    }
    let pending = this.starting.get(userId);
    if (!pending) {
      pending = this.start(userId).finally(() => this.starting.delete(userId));
      this.starting.set(userId, pending);
    }
    const worker = await pending;
    worker.lastUsed = Date.now();
    return worker.socket;
  }

  /** Mark the user's worker used — a streaming response keeps it alive. */
  touch(userId: string): void {
    const live = this.running.get(userId);
    if (live) live.lastUsed = Date.now();
  }

  isRunning(userId: string): boolean {
    return this.running.has(userId);
  }

  /** Stop the user's worker so the next request starts one with fresh secrets. */
  async restart(userId: string): Promise<void> {
    await this.starting.get(userId)?.catch(() => {});
    await this.stop(userId);
  }

  /**
   * Stop the user's worker and everything else running as its uid. With no
   * worker running there may still be something it left behind — it can exit
   * by itself — so the uid is cleared either way.
   */
  async stop(userId: string): Promise<void> {
    const live = this.running.get(userId);
    if (live) {
      live.stopping = true;
      this.running.delete(userId);
      live.proc.kill("SIGTERM");
      const exited = await Promise.race([live.proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
      if (!exited) live.proc.kill("SIGKILL");
    }
    await this.settling.get(userId);
    const uid = live ? live.uid : this.knownUid(userId);
    if (uid !== null) await endProcessesOf(uid);
    if (live) await this.captureRepos(userId);
  }

  /** The uid of an account that may be gone by now; null then, and without separate uids. */
  private knownUid(userId: string): number | null {
    try {
      return this.uidOf(userId);
    } catch {
      return null;
    }
  }

  /** Copy the repos the user's settings file names into the gateway's list. */
  async captureRepos(userId: string): Promise<void> {
    if (!this.opts.repos) return;
    try {
      const repos = await readWorkerRepos(userDirs(this.opts.dataDir, userId).root, this.knownUid(userId));
      if (repos) this.opts.repos.set(userId, repos);
    } catch (e) {
      console.error(`reading the repos of ${userId} failed: ${(e as Error).message}`);
    }
  }

  async stopAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  /**
   * Stop the workers left unused past the idle limit, note the repos of the
   * ones still running, and stop any that is over its budget; runs every
   * minute once started.
   */
  async sweepIdle(now = Date.now()): Promise<void> {
    const idle = [...this.running.entries()].filter(([, w]) => now - w.lastUsed >= this.opts.idleMs);
    await Promise.all(idle.map(([id]) => this.stop(id)));
    await Promise.all([...this.running.keys()].map((id) => this.captureRepos(id)));
    await this.enforceBudgets();
  }

  startSweeper(everyMs = 60_000): void {
    this.sweeper ??= setInterval(() => void this.sweepIdle(), everyMs);
    this.sweeper.unref?.();
  }

  /**
   * Stop a worker that holds more memory, or whose folder holds more, than
   * one person's share (limits.ts). Memory comes back with the stop, so that
   * worker starts again on its person's next request; a folder stays as big
   * as it was, so that one stays stopped until it is under its budget.
   */
  private async enforceBudgets(): Promise<void> {
    const { maxDiskMb, maxMemoryMb } = this.limits;
    if (maxDiskMb === null && maxMemoryMb === null) return;
    for (const [userId, worker] of [...this.running.entries()]) {
      if (maxMemoryMb !== null) {
        const held = await residentMb(worker.proc.pid);
        if (held !== null && held > maxMemoryMb) {
          console.error(`worker for ${userId} holds ${Math.round(held)} MB of memory, over ${maxMemoryMb}: stopped`);
          await this.stop(userId);
          continue;
        }
      }
      if (maxDiskMb !== null) {
        const used = await diskUsageMb(userDirs(this.opts.dataDir, userId).base, worker.uid);
        if (used !== null && used > maxDiskMb) {
          console.error(`the folder of ${userId} holds ${Math.round(used)} MB, over ${maxDiskMb}: worker stopped`);
          this.overDisk.set(userId, used);
          await this.stop(userId);
        }
      }
    }
  }

  /**
   * Refuse a start the volume has no room for: when it is nearly full —
   * the gateway's own database is on it — and for a person whose folder was
   * over its budget and still is.
   */
  private async checkRoom(userId: string, base: string, uid: number | null): Promise<void> {
    const { maxDiskMb, minFreeMb } = this.limits;
    const free = await freeMb(this.opts.dataDir);
    if (free !== null && free < minFreeMb) {
      console.error(`the volume has ${Math.round(free)} MB free, under ${minFreeMb}: no worker starts`);
      throw new WorkerUnavailableError("The service is out of disk space — tell its admin");
    }
    if (maxDiskMb === null || !this.overDisk.has(userId)) return;
    const used = await diskUsageMb(base, uid);
    if (used !== null && used > maxDiskMb) {
      this.overDisk.set(userId, used);
      throw new WorkerUnavailableError(
        `Your workspace holds ${Math.round(used)} MB, over its ${maxDiskMb} MB — ask the admin to make room`,
      );
    }
    this.overDisk.delete(userId);
  }

  private async start(userId: string): Promise<Running> {
    const recent = (this.crashes.get(userId) ?? []).filter((t) => Date.now() - t < CRASH_WINDOW_MS);
    if (recent.length >= CRASH_LIMIT && Date.now() - recent[recent.length - 1]! < CRASH_PAUSE_MS) {
      throw new WorkerUnavailableError("Your workspace keeps stopping — try again in a minute");
    }
    const dirs = userDirs(this.opts.dataDir, userId);
    const uid = this.uidOf(userId);
    const email = this.opts.emailOf?.(userId) ?? null;
    // Nothing of an earlier worker's is left running as this uid — and so
    // nothing of it can rearrange the folders while root prepares them.
    await this.settling.get(userId);
    if (uid !== null) await endProcessesOf(uid);
    await this.checkRoom(userId, dirs.base, uid);
    await this.prepareDirs(dirs, uid);
    // Unlinking never follows a link, and `run` is a folder root just checked.
    await rm(dirs.socket, { force: true });
    const repos = this.opts.repos?.get(userId) ?? [];
    const env = workerEnv(dirs, await this.opts.secrets(userId), this.opts.baseEnv, email, repos);
    const stdio = this.opts.stdio ?? "inherit";
    const proc = Bun.spawn(workerCommand(this.opts.entry, uid, this.limits), {
      cwd: dirs.root,
      env,
      stdin: "ignore",
      stdout: stdio,
      stderr: stdio,
    });
    const worker: Running = { proc, uid, socket: dirs.socket, lastUsed: Date.now(), stopping: false };
    void proc.exited.then((code) => {
      if (this.running.get(userId) === worker) this.running.delete(userId);
      if (worker.stopping) return;
      console.error(`worker for ${userId} exited with code ${code}`);
      this.crashes.set(userId, [...recent, Date.now()].slice(-CRASH_LIMIT));
      // It went by itself: clear what it left running, then note its repos.
      // The next start waits for this, so the clean-up never meets it.
      const settled = (uid === null ? Promise.resolve() : endProcessesOf(uid))
        .then(() => this.captureRepos(userId))
        .catch((e: Error) => console.error(`clearing up after the worker of ${userId} failed: ${e.message}`))
        .finally(() => {
          if (this.settling.get(userId) === settled) this.settling.delete(userId);
        });
      this.settling.set(userId, settled);
    });
    try {
      await this.waitReady(worker);
    } catch (e) {
      worker.stopping = true;
      proc.kill("SIGKILL");
      if (uid !== null) await endProcessesOf(uid);
      throw e;
    }
    this.running.set(userId, worker);
    return worker;
  }

  /**
   * The user's folders. Without separate uids they are the gateway's own,
   * 0700. With them, the top folder is root's — the worker's group may pass
   * through and list it, 0750, but only root can add, rename or replace an
   * entry — and the five folders in it are the worker's, 0700. So each name
   * root opens here is a folder root made, never a link a worker put in its
   * place; the folders above are 0711, passable but not listable.
   */
  private async prepareDirs(dirs: ReturnType<typeof userDirs>, uid: number | null): Promise<void> {
    const users = join(this.opts.dataDir, "users");
    await mkdir(users, { recursive: true, mode: 0o711 });
    const own = [dirs.home, dirs.root, dirs.repos, dirs.run, dirs.tmp];
    if (uid === null) {
      for (const dir of [dirs.base, ...own]) await mkdir(dir, { recursive: true, mode: 0o700 });
      return;
    }
    await chmod(this.opts.dataDir, 0o711);
    await chmod(users, 0o711);
    await folder(dirs.base, 0o750);
    // A top folder from before this rule belonged to the worker: take it back.
    await lchown(dirs.base, 0, uid);
    await chmod(dirs.base, 0o750);
    for (const dir of own) {
      const owner = (await folder(dir, 0o700)).uid;
      if (owner === uid) continue;
      // Root's own: just made, or from before workers had uids. No worker
      // could write in it, so handing over what it holds follows no link of
      // a worker's. Anyone else's is not this person's folder at all.
      if (owner !== 0) throw new Error(`${dir} belongs to uid ${owner}, not to this worker's ${uid}`);
      const chown = Bun.spawn([systemTool("chown") ?? "chown", "-R", "-h", `${uid}:${uid}`, dir], { stdout: "ignore", stderr: "pipe" });
      if ((await chown.exited) !== 0) {
        throw new Error(`chown of ${dir} failed: ${await new Response(chown.stderr).text()}`);
      }
    }
  }

  /** Wait until the worker answers on its socket, or fail when it exits or takes too long. */
  private async waitReady(worker: Running): Promise<void> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 30_000);
    let exitCode: number | null = null;
    void worker.proc.exited.then((code) => {
      exitCode = code;
    });
    while (Date.now() < deadline) {
      if (exitCode !== null) throw new WorkerUnavailableError(`Your workspace failed to start (exit ${exitCode})`);
      try {
        // Any answer will do — an unknown path is the app's quick 404.
        const res = await fetch("http://localhost/__specdriven_ready", { unix: worker.socket });
        await res.body?.cancel();
        return;
      } catch {
        await Bun.sleep(50);
      }
    }
    throw new WorkerUnavailableError("Your workspace took too long to start");
  }
}

/**
 * Make the folder at `path` unless something is there already, and answer
 * what is there — which must be a folder itself, not a link to one: root
 * goes on to change its owner.
 */
async function folder(path: string, mode: number) {
  await mkdir(path, { mode }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error(`${path} is not a folder`);
  return info;
}

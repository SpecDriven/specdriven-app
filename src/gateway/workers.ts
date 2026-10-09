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
// as a Linux uid of its own (`setpriv`), and its folder belongs to that uid
// with mode 0700. A user controls their data repo's contents, symlinks
// included, so a folder kept apart only by convention would not be apart:
// with separate uids the kernel refuses one worker another's files, the
// gateway's database and the gateway's own environment.

import type { Subprocess } from "bun";
import { chmod, chown, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentKeyEnvName } from "../server/agentKeys";
import { TOKEN_ENV } from "../server/tokenStore";
import type { UserSecrets } from "./secrets";

/** Variables a worker inherits from the gateway: runtime, logging, network. */
const PASSTHROUGH = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_ENV",
  "TMPDIR",
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
  /** The environment the passthrough variables come from. */
  baseEnv?: Record<string, string | undefined>;
  startTimeoutMs?: number;
  /** Where a worker's output goes; the gateway's own by default. */
  stdio?: "inherit" | "ignore";
}

interface Running {
  proc: Subprocess;
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
  return process.getuid?.() === 0 && Bun.which("setpriv") !== null;
}

/** The command that starts a worker, as `uid` when there is one. */
export function workerCommand(entry: string, uid: number | null): string[] {
  const bun = [process.execPath, entry];
  if (uid === null) return bun;
  // Resolved here: the worker's own PATH is not the gateway's.
  const setpriv = Bun.which("setpriv") ?? "setpriv";
  return [setpriv, `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--", ...bun];
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
    socket: join(base, "run", "app.sock"),
  };
}

/** The environment a user's worker starts with. */
export function workerEnv(
  dirs: ReturnType<typeof userDirs>,
  secrets: UserSecrets,
  base: Record<string, string | undefined> = process.env,
  email: string | null = null,
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
  if (secrets.github) env[TOKEN_ENV] = JSON.stringify(secrets.github);
  for (const [name, value] of Object.entries(secrets.agentKeys)) env[agentKeyEnvName(name)] = value;
  return env;
}

export class WorkerPool {
  private running = new Map<string, Running>();
  private starting = new Map<string, Promise<Running>>();
  private crashes = new Map<string, number[]>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: WorkerPoolOptions) {}

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

  async stop(userId: string): Promise<void> {
    const live = this.running.get(userId);
    if (!live) return;
    live.stopping = true;
    this.running.delete(userId);
    live.proc.kill("SIGTERM");
    const exited = await Promise.race([live.proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (!exited) live.proc.kill("SIGKILL");
  }

  async stopAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  /** Stop the workers left unused past the idle limit; runs every minute once started. */
  async sweepIdle(now = Date.now()): Promise<void> {
    const idle = [...this.running.entries()].filter(([, w]) => now - w.lastUsed >= this.opts.idleMs);
    await Promise.all(idle.map(([id]) => this.stop(id)));
  }

  startSweeper(everyMs = 60_000): void {
    this.sweeper ??= setInterval(() => void this.sweepIdle(), everyMs);
    this.sweeper.unref?.();
  }

  private async start(userId: string): Promise<Running> {
    const recent = (this.crashes.get(userId) ?? []).filter((t) => Date.now() - t < CRASH_WINDOW_MS);
    if (recent.length >= CRASH_LIMIT && Date.now() - recent[recent.length - 1]! < CRASH_PAUSE_MS) {
      throw new WorkerUnavailableError("Your workspace keeps stopping — try again in a minute");
    }
    const dirs = userDirs(this.opts.dataDir, userId);
    const uid = this.opts.osUid ? this.opts.osUid(userId) : null;
    const email = this.opts.emailOf?.(userId) ?? null;
    await this.prepareDirs(dirs, uid);
    if (email) await this.writeGitIdentity(dirs, uid, email);
    await rm(dirs.socket, { force: true });
    const env = workerEnv(dirs, await this.opts.secrets(userId), this.opts.baseEnv, email);
    const stdio = this.opts.stdio ?? "inherit";
    const proc = Bun.spawn(workerCommand(this.opts.entry, uid), {
      cwd: dirs.root,
      env,
      stdin: "ignore",
      stdout: stdio,
      stderr: stdio,
    });
    const worker: Running = { proc, socket: dirs.socket, lastUsed: Date.now(), stopping: false };
    void proc.exited.then((code) => {
      if (this.running.get(userId) === worker) this.running.delete(userId);
      if (!worker.stopping) {
        console.error(`worker for ${userId} exited with code ${code}`);
        this.crashes.set(userId, [...recent, Date.now()].slice(-CRASH_LIMIT));
      }
    });
    try {
      await this.waitReady(worker);
    } catch (e) {
      worker.stopping = true;
      proc.kill("SIGKILL");
      throw e;
    }
    this.running.set(userId, worker);
    return worker;
  }

  /**
   * The user's folders, 0700. With a uid of their own they belong to it, and
   * the folders above are 0711 — passable on the way to their own folder,
   * but not listable.
   */
  private async prepareDirs(dirs: ReturnType<typeof userDirs>, uid: number | null): Promise<void> {
    const users = join(this.opts.dataDir, "users");
    await mkdir(users, { recursive: true, mode: 0o711 });
    if (uid !== null) {
      await chmod(this.opts.dataDir, 0o711);
      await chmod(users, 0o711);
    }
    const all = [dirs.base, dirs.home, dirs.root, dirs.repos, dirs.run];
    for (const dir of all) await mkdir(dir, { recursive: true, mode: 0o700 });
    if (uid === null) return;
    const owners = await Promise.all(all.map(async (d) => (await stat(d)).uid));
    if (owners.every((o) => o === uid)) return;
    // A folder made or last owned by someone else: hand the whole tree over.
    const chown = Bun.spawn(["chown", "-R", `${uid}:${uid}`, dirs.base], { stdout: "ignore", stderr: "pipe" });
    if ((await chown.exited) !== 0) {
      throw new Error(`chown of ${dirs.base} failed: ${await new Response(chown.stderr).text()}`);
    }
  }

  /**
   * The account as git's default author, in the worker's ~/.gitconfig: the
   * GitHub identity the app passes with each command (src/server/git) wins
   * when there is a token, and without one commits are still attributed.
   */
  private async writeGitIdentity(dirs: ReturnType<typeof userDirs>, uid: number | null, email: string): Promise<void> {
    const path = join(dirs.home, ".gitconfig");
    await writeFile(path, `[user]\n\tname = ${email}\n\temail = ${email}\n`, { mode: 0o600 });
    if (uid !== null) await chown(path, uid, uid);
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

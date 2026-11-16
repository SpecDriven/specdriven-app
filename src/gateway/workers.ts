// One app server per signed-in user (docs/deployment-railway.md
// "Architecture"): the app is single-user by design — one settings file, one
// GitHub token, one data repo — so instead of teaching it about users, each
// user gets their own copy of it, started on first use with their own
// folders and their own decrypted secrets, listening on a unix socket in a
// folder of its own. The gateway proxies to it (proxy.ts) and stops it
// after a while unused; it starts again on the next request.
//
// The worker's environment is built from scratch, never copied from the
// gateway's: the master key, the mail service key and the other users'
// secrets must not reach it.
//
// This file is the policy: who has a worker, when it starts and stops, what
// it may use. Making the folders and starting the process is the spawner's
// (spawner.ts) — in the hosted image a root process of its own, which gives
// each worker a Linux uid and confines it, while the gateway is not root
// (docs/hosted-tenant-isolation.md "Step 2"). Elsewhere (development,
// tests) the pool keeps a spawner in its own process and the workers share
// its user.
//
// The gateway never opens anything inside a worker's folders but its
// socket: the git author and the remembered repos the worker sets up for
// itself (workerStart.ts), and its settings and folder size the spawner
// reads as that worker's uid.
//
// Where the service has a GitHub App (docs/hosted-tenant-isolation.md "Step
// 3") a worker is given no GitHub token either. The pool listens on a socket
// of that worker's own (tokenSocket.ts) and answers its git with an hour's
// token for the one repository it asks for; when the worker stops, the
// socket goes and the tokens it was given are revoked.

import { join } from "node:path";
import { GITHUB_APP_ENV, IDENTITY_ENV, TOKEN_SOCKET_ENV } from "../server/hostedToken";
import { TOKEN_ENV } from "../server/tokenStore";
import { randomToken } from "./crypto";
import type { GithubIdentity, RepoToken } from "./githubApp";
import { DEFAULT_LIMITS, freeMb, type WorkerLimits } from "./limits";
import { cleanRepos, HOSTED_REPOS_ENV, reposInSettings } from "./repos";
import type { UserSecrets } from "./secrets";
import { Spawner, userDirs, type SpawnerApi } from "./spawner";
import { serveTokens, type TokenServer } from "./tokenSocket";

export { endProcessesOf, userDirs, workerCommand, workerIsolation } from "./spawner";

/** The key a worker asks of every request, so only its own gateway's reach it (src/server/hostedMode.ts). */
export const WORKER_KEY_ENV = "SPECDRIVEN_WORKER_KEY";
export const WORKER_KEY_HEADER = "x-specdriven-worker-key";

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
  /** What makes the folders and starts the workers; one in this process when absent (spawner.ts). */
  spawner?: SpawnerApi;
  /** The local port of the workers' one way out (egress.ts); absent leaves their network alone. */
  egressPort?: number | null;
  /**
   * GitHub through the service's own app (githubLinks.ts): a worker whose
   * person has connected their account holds no token and asks for each
   * repository's. Absent, a worker gets the token its person pasted.
   */
  github?: GithubTokens;
}

/** The slice of the GitHub App's tokens the pool uses (githubLinks.ts RepoTokens). */
export interface GithubTokens {
  /** The person's GitHub account, when they have connected one. */
  identity(userId: string): GithubIdentity | null;
  /** An hour's token for one repository, or a thrown reason the worker is told. */
  tokenFor(userId: string, repo: string): Promise<RepoToken>;
  /** End every token made for the person's worker. */
  forget(userId: string): void;
}

/** Where a person's worker listens, and the key it asks of every request. */
export interface WorkerAddress {
  socket: string;
  key: string;
}

interface Running extends WorkerAddress {
  /** Names this start to the spawner, which names it back when the worker ends. */
  instance: string;
  /** The uid it runs as; null when workers share the gateway's user. */
  uid: number | null;
  lastUsed: number;
  stopping: boolean;
  /** Settles with the exit code once the worker's process has ended. */
  ended: Promise<number | null>;
  end(code: number | null): void;
  /** Where this worker's git asks for GitHub tokens; null when it is given none that way. */
  tokens: TokenServer | null;
}

/** Repeated crashes of one user's worker back off instead of looping. */
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
const CRASH_PAUSE_MS = 30_000;

export class WorkerUnavailableError extends Error {}

/** The environment a user's worker starts with. */
export function workerEnv(
  dirs: ReturnType<typeof userDirs>,
  secrets: UserSecrets,
  base: Record<string, string | undefined> = process.env,
  email: string | null = null,
  repos: string[] = [],
  own: {
    key?: string;
    egressPort?: number | null;
    /** The service has a GitHub App; with the person's account, their worker asks it for tokens. */
    github?: { identity: GithubIdentity | null } | null;
  } = {},
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
  if (own.key) env[WORKER_KEY_ENV] = own.key;
  if (own.egressPort) {
    // Its one way out: git and the app's own requests go where these point,
    // and nothing is to bypass it.
    const proxy = `http://127.0.0.1:${own.egressPort}`;
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) env[name] = proxy;
    delete env.NO_PROXY;
    delete env.no_proxy;
  }
  if (email) env.SPECDRIVEN_ACCOUNT_EMAIL = email;
  const remembered = cleanRepos(repos);
  if (remembered.length) env[HOSTED_REPOS_ENV] = JSON.stringify(remembered);
  if (own.github) env[GITHUB_APP_ENV] = "1";
  if (own.github?.identity) {
    // Who the person is on GitHub and where to ask: no token, pasted or made.
    const { id, login, name, email } = own.github.identity;
    env[IDENTITY_ENV] = JSON.stringify({ id, login, name, email });
    env[TOKEN_SOCKET_ENV] = dirs.tokenSocket;
  } else if (secrets.github) {
    env[TOKEN_ENV] = JSON.stringify(secrets.github);
  }
  return env;
}

export class WorkerPool {
  private running = new Map<string, Running>();
  private starting = new Map<string, Promise<Running>>();
  /** Every worker the spawner was asked for and has not yet said ended, by its instance. */
  private instances = new Map<string, { userId: string; worker: Running }>();
  private crashes = new Map<string, number[]>();
  /** The clean-up after a worker that exited by itself; the next start waits for it. */
  private settling = new Map<string, Promise<void>>();
  /** People whose folder was over its budget when last measured, and by how much. */
  private overDisk = new Map<string, number>();
  /** People whose account is being deleted: no worker starts for them again. */
  private removing = new Set<string>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private spawner: SpawnerApi;

  constructor(private opts: WorkerPoolOptions) {
    this.spawner =
      opts.spawner ?? new Spawner({ dataDir: opts.dataDir, entry: opts.entry, stdio: opts.stdio });
    this.spawner.onExit(({ instance, code }) => this.ended(instance, code));
  }

  private get limits(): WorkerLimits {
    return this.opts.limits ?? DEFAULT_LIMITS;
  }

  private uidOf(userId: string): number | null {
    return this.opts.osUid ? this.opts.osUid(userId) : null;
  }

  /** The user's worker, starting it when it is not running. */
  async workerFor(userId: string): Promise<WorkerAddress> {
    const live = this.running.get(userId);
    if (live && !live.stopping) {
      live.lastUsed = Date.now();
      return live;
    }
    if (this.removing.has(userId)) throw new Error("This account is being deleted");
    let pending = this.starting.get(userId);
    if (!pending) {
      pending = this.start(userId).finally(() => this.starting.delete(userId));
      this.starting.set(userId, pending);
    }
    const worker = await pending;
    worker.lastUsed = Date.now();
    return worker;
  }

  /** The socket of the user's worker, starting it when it is not running. */
  async socketFor(userId: string): Promise<string> {
    return (await this.workerFor(userId)).socket;
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
    }
    await this.settling.get(userId);
    const uid = live ? live.uid : this.knownUid(userId);
    // First, so nothing more is handed to a worker that is on its way out.
    if (live) this.release(userId, live);
    if (live || uid !== null) await this.spawner.stop({ userId, uid });
    if (live) await this.captureRepos(userId);
  }

  /**
   * The account is being deleted (admin.ts): stop the worker, clear the uid
   * and delete the person's folder. `uid` is the one the account was given,
   * or null if it never had one — read before, as the row may go next.
   * No worker starts for them while this runs; if it fails, one can again.
   */
  async remove(userId: string, uid: number | null): Promise<void> {
    this.removing.add(userId);
    try {
      await this.starting.get(userId)?.catch(() => {});
      if (this.running.has(userId)) await this.stop(userId);
      await this.settling.get(userId);
      await this.spawner.remove({ userId, uid });
      this.crashes.delete(userId);
      this.overDisk.delete(userId);
    } finally {
      this.removing.delete(userId);
    }
  }

  /**
   * A worker is going or gone: its token socket closes, and the GitHub
   * tokens it was given end now rather than with their hour.
   */
  private release(userId: string, worker: Running): void {
    worker.tokens?.close();
    worker.tokens = null;
    this.opts.github?.forget(userId);
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
      const report = await this.spawner.report({ userId, uid: this.knownUid(userId), settings: true });
      const repos = reposInSettings(report.settings ?? null);
      if (repos) this.opts.repos.set(userId, repos);
    } catch (e) {
      console.error(`reading the repos of ${userId} failed: ${(e as Error).message}`);
    }
  }

  async stopAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    // One still starting is stopped too, once it is up or has failed.
    await Promise.all([...this.starting.values()].map((start) => start.catch(() => {})));
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
    this.sweeper ??= setInterval(() => void this.sweepIdle().catch((e: Error) => console.error(`the sweep failed: ${e.message}`)), everyMs);
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
      const report = await this.spawner.report({ userId, uid: worker.uid, disk: maxDiskMb !== null });
      const held = report.residentMb;
      if (maxMemoryMb !== null && held !== null && held > maxMemoryMb) {
        console.error(`worker for ${userId} holds ${Math.round(held)} MB of memory, over ${maxMemoryMb}: stopped`);
        await this.stop(userId);
        continue;
      }
      const used = report.diskMb ?? null;
      if (maxDiskMb !== null && used !== null && used > maxDiskMb) {
        console.error(`the folder of ${userId} holds ${Math.round(used)} MB, over ${maxDiskMb}: worker stopped`);
        this.overDisk.set(userId, used);
        await this.stop(userId);
      }
    }
  }

  /**
   * Refuse a start the volume has no room for: when it is nearly full —
   * the gateway's own database is on it — and for a person whose folder was
   * over its budget and still is.
   */
  private async checkRoom(userId: string, uid: number | null): Promise<void> {
    const { maxDiskMb, minFreeMb } = this.limits;
    const free = await freeMb(this.opts.dataDir);
    if (free !== null && free < minFreeMb) {
      console.error(`the volume has ${Math.round(free)} MB free, under ${minFreeMb}: no worker starts`);
      throw new WorkerUnavailableError("The service is out of disk space — tell its admin");
    }
    if (maxDiskMb === null || !this.overDisk.has(userId)) return;
    const used = (await this.spawner.report({ userId, uid, disk: true })).diskMb ?? null;
    if (used !== null && used > maxDiskMb) {
      this.overDisk.set(userId, used);
      throw new WorkerUnavailableError(
        `Your workspace holds ${Math.round(used)} MB, over its ${maxDiskMb} MB — ask the admin to make room`,
      );
    }
    this.overDisk.delete(userId);
  }

  private recentCrashes(userId: string): number[] {
    return (this.crashes.get(userId) ?? []).filter((t) => Date.now() - t < CRASH_WINDOW_MS);
  }

  private async start(userId: string): Promise<Running> {
    const recent = this.recentCrashes(userId);
    if (recent.length >= CRASH_LIMIT && Date.now() - recent[recent.length - 1]! < CRASH_PAUSE_MS) {
      throw new WorkerUnavailableError("Your workspace keeps stopping — try again in a minute");
    }
    const dirs = userDirs(this.opts.dataDir, userId);
    const uid = this.uidOf(userId);
    const email = this.opts.emailOf?.(userId) ?? null;
    await this.settling.get(userId);
    await this.checkRoom(userId, uid);
    const repos = this.opts.repos?.get(userId) ?? [];
    const egressPort = this.opts.egressPort ?? null;
    // A key of its own for every start: a request that reaches this worker
    // through another worker's socket, or any other way, does not carry it.
    const key = randomToken();
    const identity = this.opts.github?.identity(userId) ?? null;
    const github = this.opts.github ? { identity } : null;
    const env = workerEnv(dirs, await this.opts.secrets(userId), this.opts.baseEnv, email, repos, { key, egressPort, github });
    let end!: (code: number | null) => void;
    const ended = new Promise<number | null>((resolve) => (end = resolve));
    const worker: Running = {
      instance: randomToken().slice(0, 22),
      uid,
      socket: dirs.socket,
      key,
      lastUsed: Date.now(),
      stopping: false,
      ended,
      end,
      tokens: null,
    };
    this.instances.set(worker.instance, { userId, worker });
    try {
      const { processes, openFiles } = this.limits;
      await this.spawner.start({ userId, uid, instance: worker.instance, env, limits: { processes, openFiles }, egressPort });
      if (identity) {
        // The spawner has made the folder; the worker's git waits a moment
        // for the socket if it asks before this is done.
        worker.tokens = await serveTokens({
          path: dirs.tokenSocket,
          uid,
          answer: (repo) => this.opts.github!.tokenFor(userId, repo),
        });
      }
      await this.waitReady(worker);
    } catch (e) {
      worker.stopping = true;
      this.release(userId, worker);
      await this.spawner.stop({ userId, uid }).catch(() => {});
      this.instances.delete(worker.instance);
      throw e;
    }
    this.running.set(userId, worker);
    return worker;
  }

  /** The spawner says a worker's process has ended, and nothing of its uid is left. */
  private ended(instance: string, code: number | null): void {
    const known = this.instances.get(instance);
    if (!known) return;
    this.instances.delete(instance);
    const { userId, worker } = known;
    worker.end(code);
    if (this.running.get(userId) === worker) this.running.delete(userId);
    if (worker.stopping) return;
    this.release(userId, worker);
    console.error(`worker for ${userId} exited with code ${code}`);
    this.crashes.set(userId, [...this.recentCrashes(userId), Date.now()].slice(-CRASH_LIMIT));
    // It went by itself: note its repos. The next start waits for this.
    const settled = this.captureRepos(userId).finally(() => {
      if (this.settling.get(userId) === settled) this.settling.delete(userId);
    });
    this.settling.set(userId, settled);
  }

  /** Wait until the worker answers on its socket, or fail when it exits or takes too long. */
  private async waitReady(worker: Running): Promise<void> {
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 30_000);
    let exited = false;
    let exitCode: number | null = null;
    void worker.ended.then((code) => {
      exited = true;
      exitCode = code;
    });
    while (Date.now() < deadline) {
      if (exited) throw new WorkerUnavailableError(`Your workspace failed to start (exit ${exitCode})`);
      try {
        // Any answer will do — an unknown path is the app's quick 404.
        const res = await fetch("http://localhost/__specdriven_ready", {
          unix: worker.socket,
          headers: { [WORKER_KEY_HEADER]: worker.key },
        });
        await res.body?.cancel();
        return;
      } catch {
        await Bun.sleep(50);
      }
    }
    throw new WorkerUnavailableError("Your workspace took too long to start");
  }
}

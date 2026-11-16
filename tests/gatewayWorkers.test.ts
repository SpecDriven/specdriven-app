// The hosted gateway's workers (src/gateway/workers.ts): the real app
// server, one per user, each in its own folders on its own socket, started
// on first use with an environment built from scratch — the gateway's own
// keys never reach it — and stopped when unused.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, chown, lchown, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings } from "./helpers/settingsFile";
import { startEgressProxy } from "../src/gateway/egress";
import { isWorkerUid } from "../src/gateway/endProcesses";
import { asUser, DEFAULT_LIMITS, GATEWAY_UID, SYSTEM_PATH, systemTool } from "../src/gateway/limits";
import { LAUNCHER, pidsOf, Spawner } from "../src/gateway/spawner";
import { proxyToWorker } from "../src/gateway/proxy";
import { HOSTED_REPOS_ENV } from "../src/gateway/repos";
import { checkSandbox } from "../src/gateway/sandboxCheck";
import type { UserSecrets } from "../src/gateway/secrets";
import {
  endProcessesOf,
  userDirs,
  workerCommand,
  workerEnv,
  WORKER_KEY_ENV,
  WORKER_KEY_HEADER,
  workerIsolation,
  WorkerPool,
  type WorkerAddress,
} from "../src/gateway/workers";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let dataDir: string;
let pool: WorkerPool;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "sdw-"));
  pool = new WorkerPool({
    dataDir,
    entry: join(import.meta.dir, "..", "src", "index.ts"),
    idleMs: 60_000,
    secrets: async (): Promise<UserSecrets> => ({ github: null }),
    baseEnv: { ...process.env, SPECDRIVEN_MASTER_KEY: "must-not-leak", RESEND_API_KEY: "must-not-leak" },
    emailOf: (userId) => (userId === A ? "a@example.com" : null),
    stdio: "ignore",
  });
});

afterAll(async () => {
  await pool.stopAll();
  await rm(dataDir, { recursive: true, force: true });
});

/** Ask a worker as its gateway would: on its socket, with the key it was started with. */
function api(worker: WorkerAddress, method: string, path: string, body?: unknown) {
  return proxyToWorker(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    worker,
    { secure: false },
  );
}

test("the worker environment carries the user's folders and secrets, not the gateway's keys", () => {
  const dirs = userDirs("/data", A);
  const env = workerEnv(
    dirs,
    { github: { token: "ghp_x", login: "o", name: null, email: null, id: 1 } },
    {
      PATH: "/bin",
      TMPDIR: "/tmp/shared",
      SPECDRIVEN_MASTER_KEY: "secret",
      RESEND_API_KEY: "secret",
      SPECDRIVEN_DATASTORE_TOKEN: "secret",
      OTEL_SERVICE_NAME: "sd",
    },
    "a@example.com",
    ["https://github.com/acme/specs.git", "/a/local/folder"],
  );
  expect(env.SPECDRIVEN_ACCOUNT_EMAIL).toBe("a@example.com");
  // A temp folder of its own, not the one every worker would share.
  expect(env.TMPDIR).toBe(`/data/users/${A}/tmp`);
  // The remembered repos, for the worker to write into a missing settings file.
  expect(JSON.parse(env[HOSTED_REPOS_ENV]!)).toEqual(["https://github.com/acme/specs"]);
  expect(env.SPECDRIVEN_MASTER_KEY).toBeUndefined();
  expect(env.RESEND_API_KEY).toBeUndefined();
  expect(env.SPECDRIVEN_DATASTORE_TOKEN).toBeUndefined();
  expect(env.PATH).toBe("/bin");
  expect(env.OTEL_SERVICE_NAME).toBe("sd");
  expect(env.HOME).toBe(`/data/users/${A}/home`);
  expect(env.SPECDRIVEN_ROOT).toBe(`/data/users/${A}/root`);
  expect(env.SPECDRIVEN_HOSTED).toBe("1");
  expect(JSON.parse(env.SPECDRIVEN_GITHUB_TOKEN_RECORD!).token).toBe("ghp_x");
  // No AI agent's API key is kept, so none reaches a worker.
  expect(Object.keys(env).filter((name) => name.startsWith("SPECDRIVEN_AGENT_KEY_"))).toEqual([]);
});

test("user ids that are not UUIDs never become paths", () => {
  expect(() => userDirs("/data", "../../etc")).toThrow();
});

test("two users get two workers with separate settings, folders and environments", async () => {
  const socketA = await pool.workerFor(A);
  const socketB = await pool.workerFor(B);
  expect(socketA.socket).not.toBe(socketB.socket);
  expect(socketA.key).not.toBe(socketB.key);
  expect((await stat(userDirs(dataDir, A).base)).mode & 0o777).toBe(0o700);

  const stateA = (await (await api(socketA, "GET", "/api/state")).json()) as Record<string, unknown>;
  expect(stateA.hosted).toBe(true);
  expect(stateA.agents).toEqual([]);

  expect((await api(socketA, "PUT", "/api/state", { reloadFrequencySeconds: 300 })).status).toBe(200);
  const stateB = (await (await api(socketB, "GET", "/api/state")).json()) as Record<string, unknown>;
  expect(stateB.reloadFrequencySeconds).not.toBe(300);

  const settingsA = await readSettings(join(userDirs(dataDir, A).root, ".specdriven", "settings.yaml"));
  expect(settingsA.reloadFrequencySeconds).toBe(300);

  // The account is git's default author in the worker's home: the worker
  // wrote it itself (src/gateway/workerStart.ts).
  const gitconfig = await readFile(join(userDirs(dataDir, A).home, ".gitconfig"), "utf8");
  expect(gitconfig).toContain("email = a@example.com");

  // A second request reuses the running worker.
  expect(await pool.workerFor(A)).toBe(socketA);
}, 60_000);

test("restart stops the worker; the next request starts a fresh one", async () => {
  await pool.socketFor(A);
  expect(pool.isRunning(A)).toBe(true);
  await pool.restart(A);
  expect(pool.isRunning(A)).toBe(false);
  const worker = await pool.workerFor(A);
  expect((await api(worker, "GET", "/api/state")).status).toBe(200);
}, 60_000);

// specs/app/hosted-app.feature.md "A worker serves only its own gateway's
// requests": a worker owns the folder its socket is in, and could put a link
// to another person's socket there for the gateway to follow.
test("a worker refuses a request that does not carry its own key", async () => {
  const a = await pool.workerFor(A);
  const b = await pool.workerFor(B);
  expect((await api(a, "GET", "/api/state")).status).toBe(200);
  // What a link from A's socket to B's would bring B: A's requests, with A's key.
  const misled = await api({ socket: b.socket, key: a.key }, "GET", "/api/state");
  expect(misled.status).toBe(401);
  expect(await misled.text()).not.toContain("reloadFrequencySeconds");
  expect((await api({ socket: b.socket, key: "" }, "GET", "/api/state")).status).toBe(401);
  // A browser cannot bring a key of its own: the gateway's replaces it.
  const forged = await proxyToWorker(
    new Request("http://localhost/api/state", { headers: { [WORKER_KEY_HEADER]: b.key } }),
    { socket: b.socket, key: a.key },
    { secure: false },
  );
  expect(forged.status).toBe(401);
  // A new start, a new key.
  await pool.restart(A);
  expect((await pool.workerFor(A)).key).not.toBe(a.key);
}, 60_000);

test("the worker's environment sends git and its own requests through the gateway's proxy, when there is one", () => {
  const dirs = userDirs("/data", A);
  const base = { PATH: "/bin", HTTPS_PROXY: "http://corp:3128", NO_PROXY: "github.com", no_proxy: "github.com" };
  const direct = workerEnv(dirs, { github: null }, base);
  expect(direct.HTTPS_PROXY).toBe("http://corp:3128");
  const proxied = workerEnv(dirs, { github: null }, base, null, [], { key: "k", egressPort: 4100 });
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) expect(proxied[name]).toBe("http://127.0.0.1:4100");
  // Nothing goes round it.
  expect(proxied.NO_PROXY).toBeUndefined();
  expect(proxied.no_proxy).toBeUndefined();
  expect(proxied[WORKER_KEY_ENV]).toBe("k");
  expect(direct[WORKER_KEY_ENV]).toBeUndefined();
});

test("idle workers are stopped by the sweep", async () => {
  await pool.socketFor(B);
  await pool.sweepIdle(Date.now() + 61_000);
  expect(pool.isRunning(B)).toBe(false);
}, 60_000);

// Separate uids need root and setpriv: the hosted image has both, as does a
// root CI container; elsewhere these tests have nothing to check.
const isolated = workerIsolation();
const UID_A = 200_101;
const UID_B = 200_102;

/** The repos the gateway last noted for each user, in place of its database. */
const noted = new Map<string, string[]>();

function isolatedPool(dataDir: string, spawner: { gatewayGid?: number } = {}): WorkerPool {
  const uids: Record<string, number> = { [A]: UID_A, [B]: UID_B };
  noted.clear();
  const entry = join(import.meta.dir, "..", "src", "index.ts");
  return new WorkerPool({
    dataDir,
    spawner: new Spawner({ dataDir, entry, stdio: "ignore", ...spawner }),
    entry: join(import.meta.dir, "..", "src", "index.ts"),
    idleMs: 60_000,
    secrets: async (): Promise<UserSecrets> => ({ github: null }),
    emailOf: (userId) => (userId === A ? "a@example.com" : null),
    osUid: (userId) => uids[userId]!,
    repos: { get: () => [], set: (userId, repos) => noted.set(userId, repos) },
    stdio: "ignore",
  });
}

/** Run a shell line as a worker's uid: what a worker under attack could do. */
function as(uid: number, line: string) {
  return Bun.spawnSync([...asUser(uid), "/bin/sh", "-c", line]);
}

test.skipIf(!isolated)("each worker runs as its own uid, owning its folders alone", async () => {
  const isoDir = await mkdtemp(join(tmpdir(), "sdi-"));
  const iso = isolatedPool(isoDir);
  try {
    const socketA = await iso.workerFor(A);
    await iso.socketFor(B);
    expect((await api(socketA, "GET", "/api/state")).status).toBe(200);

    const a = userDirs(isoDir, A);
    const b = userDirs(isoDir, B);
    // The top folder is root's: the worker's group may pass through it,
    // and nobody but root can add, rename or replace an entry in it.
    const top = await stat(a.base);
    expect(top.uid).toBe(0);
    expect(top.gid).toBe(UID_A);
    expect(top.mode & 0o777).toBe(0o750);
    for (const dir of [a.home, a.root, a.repos, a.run, a.tmp]) {
      const info = await stat(dir);
      expect(info.uid).toBe(UID_A);
      expect(info.mode & 0o777).toBe(0o700);
    }
    // A file the worker itself wrote belongs to its uid: it ran as that uid.
    expect((await api(socketA, "PUT", "/api/state", { reloadFrequencySeconds: 300 })).status).toBe(200);
    expect((await stat(join(a.root, ".specdriven", "settings.yaml"))).uid).toBe(UID_A);
    expect((await stat(join(a.home, ".gitconfig"))).uid).toBe(UID_A);
    expect((await stat(isoDir)).mode & 0o777).toBe(0o711);

    // What a symlink in A's data repo would ask for: B's files, the user
    // list, the gateway's own process — all refused to A's uid.
    await Bun.write(join(b.root, "secret.txt"), "b only");
    expect(as(UID_A, `cat ${join(b.root, "secret.txt")}`).exitCode).not.toBe(0);
    expect(as(UID_A, `ls ${b.base}`).exitCode).not.toBe(0);
    expect(as(UID_A, `ls ${join(isoDir, "users")}`).exitCode).not.toBe(0);
    expect(as(UID_A, `cat /proc/${process.pid}/environ`).exitCode).not.toBe(0);
    expect(as(UID_A, `ls ${a.root}`).exitCode).toBe(0);
    // Its own top folder it can list, and change nothing in.
    expect(as(UID_A, `ls ${a.base}`).exitCode).toBe(0);
    expect(as(UID_A, `mv ${a.home} ${a.base}/gone`).exitCode).not.toBe(0);
    expect(as(UID_A, `ln -s /etc ${a.base}/extra`).exitCode).not.toBe(0);

    // The gateway notes the worker's repos by reading its settings as its uid.
    const settings = join(a.root, ".specdriven", "settings.yaml");
    await writeFile(settings, "dataRepo: https://github.com/acme/specs\n");
    await chown(settings, UID_A, UID_A);
    await iso.sweepIdle();
    expect(noted.get(A)).toEqual(["https://github.com/acme/specs"]);

    // A volume from before root kept the top folder: the worker's own,
    // 0700. The next start takes it back and the worker runs as before.
    await iso.stop(A);
    await chown(a.base, UID_A, UID_A);
    await chmod(a.base, 0o700);
    expect((await api(await iso.workerFor(A), "GET", "/api/state")).status).toBe(200);
    expect((await stat(a.base)).uid).toBe(0);
    expect((await stat(a.base)).mode & 0o777).toBe(0o750);
  } finally {
    await iso.stopAll();
    await rm(isoDir, { recursive: true, force: true });
  }
}, 60_000);

// specs/app/hosted-app.feature.md "The gateway never writes inside a
// person's folder": root follows a link wherever it leads, so a worker
// under attack leaves links where the gateway used to write and read as root.
test.skipIf(!isolated)("links a worker leaves in its folders lead the gateway nowhere", async () => {
  const isoDir = await mkdtemp(join(tmpdir(), "sdl-"));
  const iso = isolatedPool(isoDir);
  try {
    await iso.socketFor(A);
    await iso.stop(A);
    const a = userDirs(isoDir, A);
    // Root's own file, standing in for the app's code or the accounts database.
    const victim = join(isoDir, "victim");
    await writeFile(victim, "root only", { mode: 0o600 });

    expect(as(UID_A, `ln -sf ${victim} ${a.home}/.gitconfig`).exitCode).toBe(0);
    expect(as(UID_A, `rm -rf ${a.root}/.specdriven && mkdir ${a.root}/.specdriven`).exitCode).toBe(0);
    expect(as(UID_A, `ln -s ${victim} ${a.root}/.specdriven/settings.yaml`).exitCode).toBe(0);
    expect(as(UID_A, `ln -s ${victim} ${a.run}/app.sock`).exitCode).toBe(0);

    const worker = await iso.workerFor(A);
    expect((await api(worker, "GET", "/api/state")).status).toBe(200);
    await iso.sweepIdle();
    await iso.stop(A);

    // Read as the worker's uid, the settings link shows nothing of root's file.
    expect(noted.has(A)).toBe(false);
    expect(await readFile(victim, "utf8")).toBe("root only");
    const after = await stat(victim);
    expect(after.uid).toBe(0);
    expect(after.mode & 0o777).toBe(0o600);
    // The worker put its own author file in the link's place.
    expect((await lstat(join(a.home, ".gitconfig"))).isFile()).toBe(true);
  } finally {
    await iso.stopAll();
    await rm(isoDir, { recursive: true, force: true });
  }
}, 60_000);

test.skipIf(!isolated)("a folder that is a link, or another uid's, stops the worker from starting", async () => {
  const isoDir = await mkdtemp(join(tmpdir(), "sdf-"));
  const iso = isolatedPool(isoDir);
  try {
    // A top folder from before root kept it: the worker's own, so the
    // worker could put a link where one of its folders goes.
    const a = userDirs(isoDir, A);
    await mkdir(a.base, { recursive: true });
    await symlink("/etc", a.home);
    for (const path of [a.base, a.home]) await lchown(path, UID_A, UID_A);
    expect(iso.socketFor(A)).rejects.toThrow("is not a folder");
    await iso.socketFor(A).catch(() => {});
    expect((await stat("/etc")).uid).toBe(0);
    // Root took the top folder back all the same.
    expect((await stat(a.base)).uid).toBe(0);

    const b = userDirs(isoDir, B);
    await mkdir(b.root, { recursive: true });
    await chown(b.root, UID_A, UID_A);
    expect(iso.socketFor(B)).rejects.toThrow(`belongs to uid ${UID_A}`);
    await iso.socketFor(B).catch(() => {});
  } finally {
    await iso.stopAll();
    await rm(isoDir, { recursive: true, force: true });
  }
}, 60_000);

// specs/app/hosted-app.feature.md "Stopping a worker ends everything it started".
test.skipIf(!isolated)("stopping a worker ends every process of its uid, and no one else's", async () => {
  const isoDir = await mkdtemp(join(tmpdir(), "sdk-"));
  const iso = isolatedPool(isoDir);
  // Processes a worker started and let go of: not children of the worker.
  const sleeper = (uid: number) =>
    Bun.spawn([...asUser(uid), systemTool("sleep")!, "600"], { stdout: "ignore", stderr: "ignore" });
  const alive = (proc: { exitCode: number | null; signalCode: unknown }) =>
    proc.exitCode === null && proc.signalCode === null;
  try {
    await iso.socketFor(A);
    await iso.socketFor(B);
    const leftA = sleeper(UID_A);
    const leftB = sleeper(UID_B);
    await Bun.sleep(200);
    expect(alive(leftA)).toBe(true);

    await iso.stop(A);
    await leftA.exited;
    expect(leftA.signalCode).toBe("SIGKILL");
    expect(alive(leftB)).toBe(true);
    expect(iso.isRunning(B)).toBe(true);

    // With no worker running, a restart still clears what one left behind;
    // so does the next start.
    const again = sleeper(UID_A);
    await Bun.sleep(200);
    await iso.restart(A);
    await again.exited;
    expect(again.signalCode).toBe("SIGKILL");
    const before = sleeper(UID_A);
    await Bun.sleep(200);
    await iso.socketFor(A);
    await before.exited;
    expect(before.signalCode).toBe("SIGKILL");
    expect(iso.isRunning(A)).toBe(true);

    leftB.kill("SIGKILL");
  } finally {
    await iso.stopAll();
    await rm(isoDir, { recursive: true, force: true });
  }
}, 60_000);

// specs/app/hosted-app.feature.md "The part that answers the internet is not
// root": where the gateway is a uid of its own, it and the worker — and no
// other worker — reach the worker's socket.
test.skipIf(!isolated)("the gateway's uid reaches a worker's socket; another worker's uid does not", async () => {
  const isoDir = await mkdtemp(join(tmpdir(), "sdg-"));
  const iso = isolatedPool(isoDir, { gatewayGid: GATEWAY_UID });
  // Ask a socket as some uid, the way the gateway does: any answer means it was reached.
  const reaches = (uid: number, socket: string) =>
    Bun.spawnSync([
      ...asUser(uid),
      process.execPath,
      "-e",
      `await fetch("http://localhost/api/state", { unix: ${JSON.stringify(socket)} }).then(() => process.exit(0), () => process.exit(7))`,
    ]).exitCode === 0;
  try {
    const a = await iso.workerFor(A);
    await iso.socketFor(B);
    const dirs = userDirs(isoDir, A);
    const top = await stat(dirs.base);
    expect([top.uid, top.gid, top.mode & 0o777]).toEqual([0, UID_A, 0o751]);
    const run = await stat(dirs.run);
    expect([run.uid, run.gid, run.mode & 0o777]).toEqual([UID_A, GATEWAY_UID, 0o750]);
    // The other four folders are still the worker's alone.
    for (const dir of [dirs.home, dirs.root, dirs.repos, dirs.tmp]) expect((await stat(dir)).mode & 0o777).toBe(0o700);

    expect(reaches(GATEWAY_UID, a.socket)).toBe(true);
    expect(reaches(UID_B, a.socket)).toBe(false);
    // The gateway's uid gets no further into a person's folder than the socket.
    expect(as(GATEWAY_UID, `ls ${dirs.base}`).exitCode).not.toBe(0);
    expect(as(GATEWAY_UID, `ls ${dirs.root}`).exitCode).not.toBe(0);
    expect(as(GATEWAY_UID, `ls ${dirs.run}`).exitCode).toBe(0);
    expect(as(UID_B, `ls ${dirs.run}`).exitCode).not.toBe(0);
  } finally {
    await iso.stopAll();
    await rm(isoDir, { recursive: true, force: true });
  }
}, 60_000);

// specs/app/hosted-app.feature.md "A worker is confined to its own folder
// and one way out". A stand-in program is started exactly as a worker is
// and tries what a worker someone has taken over would.
test.skipIf(!isolated)("a worker is confined to its own folders and the proxy's port, and gets only its own environment", async () => {
  const isoDir = await mkdtemp(join(tmpdir(), "sdx-"));
  const outside = join(isoDir, "anyone-may-read.txt");
  await writeFile(outside, "not this worker's", { mode: 0o644 });
  // A stand-in GitHub the proxy lets through, and a host it does not.
  const arrived: string[] = [];
  const standIn = (name: string) =>
    Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        arrived.push(`${name} ${new URL(req.url).pathname}`);
        return new Response(name);
      },
    });
  const [github, other] = [standIn("github"), standIn("other")];
  const proxy = await startEgressProxy(new Set([`127.0.0.1:${github.port}`]), () => {});
  const entry = join(import.meta.dir, "fixtures", "confinedProbe.ts");
  const iso = new WorkerPool({
    dataDir: isoDir,
    entry,
    idleMs: 60_000,
    secrets: async (): Promise<UserSecrets> => ({ github: null }),
    osUid: () => UID_A,
    egressPort: proxy.port,
    // The system's own git: the tests' PATH is a folder outside what a worker may read.
    baseEnv: { PATH: SYSTEM_PATH, SPECDRIVEN_MASTER_KEY: "must-not-leak" },
    stdio: "ignore",
    spawner: new Spawner({ dataDir: isoDir, entry, stdio: "ignore" }),
  });
  try {
    // What the stand-in is to try, left in the folder that becomes its own.
    const root = userDirs(isoDir, A).root;
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "probe-config.json"),
      JSON.stringify({
        outside,
        proxyPort: proxy.port,
        otherPort: other.port,
        allowedUrl: `http://127.0.0.1:${github.port}`,
        refusedUrl: `http://127.0.0.1:${other.port}`,
      }),
    );
    await iso.workerFor(A);
    const facts = JSON.parse(await readFile(join(userDirs(isoDir, A).root, "probe.json"), "utf8")) as Record<string, unknown>;
    expect(facts.uid).toBe(UID_A);
    expect(facts.writesOwn).toBe(true);
    expect(facts.reachesProxy).toBe(true);
    expect(facts.proxyEnv).toBe(`http://127.0.0.1:${proxy.port}`);
    expect(facts.hasKey).toBe(true);
    // The tools root ran to get here had an environment of their own.
    expect(facts.launcherEnv).toBeNull();
    const kernel = (await checkSandbox()).applied;
    if (kernel.files) {
      // The file is readable by anyone, and /tmp writable by anyone: only
      // the worker's own rules keep it out.
      expect(facts.readsOutside).toBe(false);
      expect(facts.writesTmp).toBe(false);
    }
    if (kernel.network) expect(facts.reachesOther).toBe(false);
    // Through the proxy, the app's own requests and git reach the host on
    // its list; the other host hears nothing, by either way.
    expect(facts.fetchAllowed).toBe(200);
    expect(facts.fetchRefused).toBe(403);
    expect(facts.gitRefused).toBeGreaterThan(0);
    expect(arrived).toContain("github /from-fetch");
    expect(arrived).toContain("github /acme/specs.git/info/refs");
    expect(arrived.filter((line) => line.startsWith("other"))).toEqual([]);

    // The kernel's own word on the process: it can gain no privilege, and a filter is on it.
    const pids: string[] = [];
    for (const entry of await readdir("/proc")) {
      if (/^\d+$/.test(entry) && (await stat(`/proc/${entry}`).catch(() => null))?.uid === UID_A) pids.push(entry);
    }
    expect(pids.length).toBe(1);
    const status = await readFile(`/proc/${pids[0]}/status`, "utf8");
    expect(status).toMatch(/NoNewPrivs:\s+1/);
    expect(status).toMatch(/Seccomp:\s+2/);
  } finally {
    await iso.stopAll();
    await proxy.close();
    for (const server of [github, other]) server.stop(true);
    await rm(isoDir, { recursive: true, force: true });
  }
}, 60_000);

// A process of the worker's uid can end the one sent to end it before that
// one acts: root then ends what is left by itself.
test.skipIf(!isolated)("a process that ends whatever is sent to end it is ended all the same", async () => {
  const hostile = Bun.spawn(
    [...asUser(UID_A), process.execPath, "-e", 'for (;;) { try { process.kill(-1, "SIGKILL"); } catch {} }'],
    { stdout: "ignore", stderr: "ignore" },
  );
  const bystander = Bun.spawn([...asUser(UID_B), systemTool("sleep")!, "600"], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(300);
  expect(await pidsOf(UID_A)).toContain(hostile.pid);
  await endProcessesOf(UID_A);
  await hostile.exited;
  expect(hostile.signalCode).toBe("SIGKILL");
  expect(await pidsOf(UID_A)).toEqual([]);
  // Nobody else's process is touched.
  expect(await pidsOf(UID_B)).toContain(bystander.pid);
  bystander.kill("SIGKILL");
}, 60_000);

test("only a worker's uid can have its processes ended", async () => {
  // The program itself refuses to run as root or as an ordinary user...
  for (const uid of [undefined, 0, 501, 1000, 199_999, 200_000.5]) expect(isWorkerUid(uid)).toBe(false);
  expect(isWorkerUid(200_000)).toBe(true);
  // ...and the gateway never starts it for one.
  expect(endProcessesOf(0)).rejects.toThrow("Not a worker uid");
  expect(endProcessesOf(process.getuid?.() ?? 501)).rejects.toThrow("Not a worker uid");
  expect(endProcessesOf(199_999)).rejects.toThrow("Not a worker uid");
});

test.skipIf(!isolated)("a worker starts under the kernel's caps on processes and open files", async () => {
  const isoDir = await mkdtemp(join(tmpdir(), "sdc-"));
  const iso = isolatedPool(isoDir);
  try {
    await iso.socketFor(A);
    // The one process of its uid: /proc lists each process as a folder its uid owns.
    const pids: string[] = [];
    for (const entry of await readdir("/proc")) {
      if (/^\d+$/.test(entry) && (await stat(`/proc/${entry}`).catch(() => null))?.uid === UID_A) pids.push(entry);
    }
    expect(pids.length).toBe(1);
    const limits = await readFile(`/proc/${pids[0]}/limits`, "utf8");
    expect(limits).toMatch(new RegExp(`Max processes\\s+${DEFAULT_LIMITS.processes}\\s+${DEFAULT_LIMITS.processes}`));
    expect(limits).toMatch(new RegExp(`Max open files\\s+\\d+\\s+${DEFAULT_LIMITS.openFiles}`));
  } finally {
    await iso.stopAll();
    await rm(isoDir, { recursive: true, force: true });
  }
}, 60_000);

test("the worker command drops to the user's uid with no way back, under its caps", () => {
  expect(workerCommand("/app/src/index.ts", null)).toEqual([process.execPath, "/app/src/index.ts"]);
  const prlimit = systemTool("prlimit");
  expect(workerCommand("/app/src/index.ts", 200_001, { ...DEFAULT_LIMITS, processes: 64, openFiles: 1024 })).toEqual([
    ...(prlimit ? [prlimit, "--nproc=64", "--nofile=1024", "--"] : []),
    systemTool("setpriv") ?? "setpriv",
    "--reuid=200001",
    "--regid=200001",
    "--clear-groups",
    "--no-new-privs",
    "--",
    process.execPath,
    // Not the app but the launcher, which is told what to start on its
    // input: no path or variable the gateway chose reaches a tool root runs.
    LAUNCHER,
  ]);
});

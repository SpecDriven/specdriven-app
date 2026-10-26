// The hosted gateway's workers (src/gateway/workers.ts): the real app
// server, one per user, each in its own folders on its own socket, started
// on first use with an environment built from scratch — the gateway's own
// keys never reach it — and stopped when unused.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyToWorker } from "../src/gateway/proxy";
import type { UserSecrets } from "../src/gateway/secrets";
import { userDirs, workerCommand, workerEnv, workerIsolation, WorkerPool } from "../src/gateway/workers";

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
    secrets: async (userId): Promise<UserSecrets> => ({
      github: null,
      agentKeys: userId === A ? { anthropic: "sk-a" } : {},
    }),
    baseEnv: { ...process.env, SPECDRIVEN_MASTER_KEY: "must-not-leak", RESEND_API_KEY: "must-not-leak" },
    emailOf: (userId) => (userId === A ? "a@example.com" : null),
    stdio: "ignore",
  });
});

afterAll(async () => {
  await pool.stopAll();
  await rm(dataDir, { recursive: true, force: true });
});

function api(socket: string, method: string, path: string, body?: unknown) {
  return proxyToWorker(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    socket,
    { secure: false },
  );
}

test("the worker environment carries the user's folders and secrets, not the gateway's keys", () => {
  const dirs = userDirs("/data", A);
  const env = workerEnv(
    dirs,
    { github: { token: "ghp_x", login: "o", name: null, email: null, id: 1 }, agentKeys: { anthropic: "sk-a" } },
    {
      PATH: "/bin",
      SPECDRIVEN_MASTER_KEY: "secret",
      RESEND_API_KEY: "secret",
      SPECDRIVEN_DATASTORE_TOKEN: "secret",
      OTEL_SERVICE_NAME: "sd",
    },
    "a@example.com",
  );
  expect(env.SPECDRIVEN_ACCOUNT_EMAIL).toBe("a@example.com");
  expect(env.SPECDRIVEN_MASTER_KEY).toBeUndefined();
  expect(env.RESEND_API_KEY).toBeUndefined();
  expect(env.SPECDRIVEN_DATASTORE_TOKEN).toBeUndefined();
  expect(env.PATH).toBe("/bin");
  expect(env.OTEL_SERVICE_NAME).toBe("sd");
  expect(env.HOME).toBe(`/data/users/${A}/home`);
  expect(env.SPECDRIVEN_ROOT).toBe(`/data/users/${A}/root`);
  expect(env.SPECDRIVEN_HOSTED).toBe("1");
  expect(JSON.parse(env.SPECDRIVEN_GITHUB_TOKEN_RECORD!).token).toBe("ghp_x");
  expect(env.SPECDRIVEN_AGENT_KEY_ANTHROPIC).toBe("sk-a");
});

test("user ids that are not UUIDs never become paths", () => {
  expect(() => userDirs("/data", "../../etc")).toThrow();
});

test("two users get two workers with separate settings, folders and environments", async () => {
  const socketA = await pool.socketFor(A);
  const socketB = await pool.socketFor(B);
  expect(socketA).not.toBe(socketB);
  expect((await stat(userDirs(dataDir, A).base)).mode & 0o777).toBe(0o700);

  const stateA = (await (await api(socketA, "GET", "/api/state")).json()) as Record<string, unknown>;
  expect(stateA.hosted).toBe(true);
  expect(stateA.agents).toEqual([]);

  expect((await api(socketA, "PUT", "/api/state", { reloadFrequencySeconds: 300 })).status).toBe(200);
  const stateB = (await (await api(socketB, "GET", "/api/state")).json()) as Record<string, unknown>;
  expect(stateB.reloadFrequencySeconds).not.toBe(300);

  const settingsA = await readFile(join(userDirs(dataDir, A).root, ".specdriven", "settings.json"), "utf8");
  expect(JSON.parse(settingsA).reloadFrequencySeconds).toBe(300);

  // The account is git's default author in the worker's home.
  const gitconfig = await readFile(join(userDirs(dataDir, A).home, ".gitconfig"), "utf8");
  expect(gitconfig).toContain("email = a@example.com");

  // A second request reuses the running worker.
  expect(await pool.socketFor(A)).toBe(socketA);
}, 60_000);

test("restart stops the worker; the next request starts a fresh one", async () => {
  await pool.socketFor(A);
  expect(pool.isRunning(A)).toBe(true);
  await pool.restart(A);
  expect(pool.isRunning(A)).toBe(false);
  const socket = await pool.socketFor(A);
  expect((await api(socket, "GET", "/api/state")).status).toBe(200);
}, 60_000);

test("idle workers are stopped by the sweep", async () => {
  await pool.socketFor(B);
  await pool.sweepIdle(Date.now() + 61_000);
  expect(pool.isRunning(B)).toBe(false);
}, 60_000);

// Separate uids need root and setpriv: the hosted image has both, as does a
// root CI container; elsewhere these tests have nothing to check.
const isolated = workerIsolation();

test.skipIf(!isolated)("each worker runs as its own uid, owning its folder alone", async () => {
  const uids: Record<string, number> = { [A]: 200_101, [B]: 200_102 };
  const isoDir = await mkdtemp(join(tmpdir(), "sdi-"));
  const iso = new WorkerPool({
    dataDir: isoDir,
    entry: join(import.meta.dir, "..", "src", "index.ts"),
    idleMs: 60_000,
    secrets: async (): Promise<UserSecrets> => ({ github: null, agentKeys: {} }),
    osUid: (userId) => uids[userId]!,
    stdio: "ignore",
  });
  try {
    const socketA = await iso.socketFor(A);
    await iso.socketFor(B);
    expect((await api(socketA, "GET", "/api/state")).status).toBe(200);

    const a = userDirs(isoDir, A);
    const b = userDirs(isoDir, B);
    const info = await stat(a.base);
    expect(info.uid).toBe(200_101);
    expect(info.mode & 0o777).toBe(0o700);
    // A file the worker itself wrote belongs to its uid: it ran as that uid.
    expect((await api(socketA, "PUT", "/api/state", { reloadFrequencySeconds: 300 })).status).toBe(200);
    expect((await stat(join(a.root, ".specdriven", "settings.json"))).uid).toBe(200_101);
    expect((await stat(isoDir)).mode & 0o777).toBe(0o711);

    // What a symlink in A's data repo would ask for: B's files, the user
    // list, the gateway's own process — all refused to A's uid.
    await Bun.write(join(b.root, "secret.txt"), "b only");
    const asA = (cmd: string) =>
      Bun.spawnSync([Bun.which("setpriv")!, "--reuid=200101", "--regid=200101", "--clear-groups", "--", "sh", "-c", cmd]);
    expect(asA(`cat ${join(b.root, "secret.txt")}`).exitCode).not.toBe(0);
    expect(asA(`ls ${join(isoDir, "users")}`).exitCode).not.toBe(0);
    expect(asA(`cat /proc/${process.pid}/environ`).exitCode).not.toBe(0);
    expect(asA(`ls ${a.root}`).exitCode).toBe(0);
  } finally {
    await iso.stopAll();
    await rm(isoDir, { recursive: true, force: true });
  }
}, 60_000);

test("the worker command drops to the user's uid with no way back", () => {
  expect(workerCommand("/app/src/index.ts", null)).toEqual([process.execPath, "/app/src/index.ts"]);
  expect(workerCommand("/app/src/index.ts", 200_001)).toEqual([
    Bun.which("setpriv") ?? "setpriv",
    "--reuid=200001",
    "--regid=200001",
    "--clear-groups",
    "--no-new-privs",
    "--",
    process.execPath,
    "/app/src/index.ts",
  ]);
});

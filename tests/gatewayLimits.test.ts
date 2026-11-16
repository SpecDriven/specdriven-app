// specs/app/hosted-app.feature.md "One person cannot use up what the others
// need": the caps a worker starts under and the budgets the gateway's sweep
// holds it to (src/gateway/limits.ts, src/gateway/workers.ts).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS, diskUsageMb, freeMb, readWorkerLimits, residentMb, runAs } from "../src/gateway/limits";
import type { UserSecrets } from "../src/gateway/secrets";
import { userDirs, WorkerPool, WorkerUnavailableError } from "../src/gateway/workers";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sd-limits-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function pool(name: string, limits: Partial<typeof DEFAULT_LIMITS>): { pool: WorkerPool; dataDir: string } {
  const dataDir = join(dir, name);
  return {
    dataDir,
    pool: new WorkerPool({
      dataDir,
      entry: join(import.meta.dir, "..", "src", "index.ts"),
      idleMs: 60_000,
      secrets: async (): Promise<UserSecrets> => ({ github: null }),
      limits: { ...DEFAULT_LIMITS, ...limits },
      stdio: "ignore",
    }),
  };
}

test("limits come from the environment; what is unset or not a number keeps its default", () => {
  expect(readWorkerLimits({})).toEqual(DEFAULT_LIMITS);
  expect(DEFAULT_LIMITS.maxDiskMb).toBeNull();
  expect(DEFAULT_LIMITS.maxMemoryMb).toBeNull();
  expect(
    readWorkerLimits({
      SPECDRIVEN_WORKER_MAX_PROCESSES: "64",
      SPECDRIVEN_WORKER_MAX_OPEN_FILES: "nope",
      SPECDRIVEN_WORKER_MAX_DISK_MB: "2048",
      SPECDRIVEN_WORKER_MAX_MEMORY_MB: "0",
      SPECDRIVEN_MIN_FREE_MB: " 100 ",
    }),
  ).toEqual({ processes: 64, openFiles: DEFAULT_LIMITS.openFiles, maxDiskMb: 2048, maxMemoryMb: null, minFreeMb: 100 });
});

test("a folder's size and the volume's free space are measured; what is not there is not", async () => {
  const folder = join(dir, "measured");
  await Bun.write(join(folder, "big.bin"), new Uint8Array(3 * 1024 * 1024));
  const used = await diskUsageMb(folder, null);
  expect(used).toBeGreaterThanOrEqual(3);
  expect(used).toBeLessThan(5);
  expect(await diskUsageMb(join(dir, "missing"), null)).toBeNull();
  expect(await freeMb(dir)).toBeGreaterThan(0);
  expect(await freeMb(join(dir, "missing"))).toBeNull();
});

test("no worker starts while the volume is nearly full", async () => {
  const { pool: full, dataDir } = pool("full", { minFreeMb: Number.MAX_SAFE_INTEGER });
  await Bun.write(join(dataDir, "app.db"), "");
  try {
    const refused = full.socketFor(A);
    expect(refused).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(refused).rejects.toThrow("out of disk space");
    await refused.catch(() => {});
    expect(full.isRunning(A)).toBe(false);
  } finally {
    await full.stopAll();
  }
}, 30_000);

test("a worker whose folder is over its budget is stopped, and starts again once it is under", async () => {
  const { pool: budgeted, dataDir } = pool("disk", { maxDiskMb: 20 });
  try {
    await budgeted.socketFor(A);
    await budgeted.sweepIdle();
    expect(budgeted.isRunning(A)).toBe(true);

    const big = join(userDirs(dataDir, A).repos, "big.bin");
    await writeFile(big, new Uint8Array(30 * 1024 * 1024));
    await budgeted.sweepIdle();
    expect(budgeted.isRunning(A)).toBe(false);
    const refused = budgeted.socketFor(A);
    expect(refused).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(refused).rejects.toThrow("over its 20 MB");
    await refused.catch(() => {});

    await rm(big);
    await budgeted.socketFor(A);
    expect(budgeted.isRunning(A)).toBe(true);
  } finally {
    await budgeted.stopAll();
  }
}, 60_000);

// A process's memory is read from /proc, which only Linux has.
test.skipIf(process.platform !== "linux")("a worker holding more memory than its budget is stopped, and starts again when asked", async () => {
  expect(await residentMb(process.pid)).toBeGreaterThan(1);
  const { pool: budgeted } = pool("memory", { maxMemoryMb: 1 });
  try {
    await budgeted.socketFor(A);
    await budgeted.sweepIdle();
    expect(budgeted.isRunning(A)).toBe(false);
    await budgeted.socketFor(A);
    expect(budgeted.isRunning(A)).toBe(true);
  } finally {
    await budgeted.stopAll();
  }
}, 60_000);

test("where there is no /proc entry, a process's memory is not known", async () => {
  expect(await residentMb(2 ** 30)).toBeNull();
});

// specs/app/hosted-app.feature.md "The gateway never writes inside a
// person's folder": a command run as a worker's uid is a process that
// worker can inspect, environment included.
test("a command the gateway runs for a worker carries none of the gateway's environment", async () => {
  const saved = process.env.SPECDRIVEN_MASTER_KEY;
  process.env.SPECDRIVEN_MASTER_KEY = "must-not-leak";
  try {
    const res = await runAs(null, ["env"], 10_000);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("PATH=");
    expect(res.stdout).not.toContain("must-not-leak");
    expect(res.stdout.trim().split("\n").every((line) => line.startsWith("PATH=") || line.startsWith("__CF"))).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.SPECDRIVEN_MASTER_KEY;
    else process.env.SPECDRIVEN_MASTER_KEY = saved;
  }
});

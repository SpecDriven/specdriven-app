// Each hosted user's recent data repos (src/gateway/repos.ts): read from the
// worker's settings file into app.db — which the datastore mirrors — and
// written back into a worker that starts without one, so a sign-in after a
// redeploy that lost the volume opens the repo the user had open instead of
// asking for its url again.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSettings } from "../src/server/settingsFormat";
import { readSettings } from "./helpers/settingsFile";
import { openDatabase } from "../src/gateway/db";
import { proxyToWorker } from "../src/gateway/proxy";
import { cleanRepos, readWorkerRepos, RecentRepos, seedWorkerRepos } from "../src/gateway/repos";
import { userDirs, WorkerPool } from "../src/gateway/workers";
import { SETTINGS_VERSION } from "../src/server/state";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPECS = "https://github.com/o/specs";
const OLDER = "https://github.com/o/older";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdr-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function addUser(db: ReturnType<typeof openDatabase>, id: string) {
  db.query("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(id, `${id}@example.com`, 1);
}

async function freshRoot(name: string): Promise<string> {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  return root;
}

async function writeSettings(root: string, state: unknown): Promise<void> {
  await mkdir(join(root, ".specdriven"), { recursive: true });
  await writeFile(join(root, ".specdriven", "settings.yaml"), serializeSettings(state as object));
}

test("only GitHub repos are kept, in canonical form, once each, at most ten", () => {
  expect(
    cleanRepos(["github.com/o/specs.git", SPECS, "/data/users/x/repos/specs", "", 7, "git@github.com:o/older.git"]),
  ).toEqual([SPECS, OLDER]);
  expect(cleanRepos(Array.from({ length: 12 }, (_, i) => `https://github.com/o/r${i}`))).toHaveLength(10);
  expect(cleanRepos("not a list")).toEqual([]);
});

test("the list is stored per user, reports a change, and goes with the account", () => {
  const db = openDatabase(":memory:");
  addUser(db, A);
  const repos = new RecentRepos(db, () => 5);
  expect(repos.get(A)).toEqual([]);
  expect(repos.set(A, [SPECS, OLDER])).toBe(true);
  expect(repos.set(A, [SPECS, OLDER])).toBe(false);
  expect(repos.get(A)).toEqual([SPECS, OLDER]);
  expect(repos.set(A, [])).toBe(true);
  expect(repos.get(A)).toEqual([]);

  repos.set(A, [SPECS]);
  db.query("DELETE FROM users WHERE id = ?").run(A);
  expect(db.query("SELECT COUNT(*) AS n FROM user_repos").get()).toEqual({ n: 0 });
});

test("a worker's settings give the open repo first, then its recent ones; no file says nothing", async () => {
  const root = await freshRoot("read");
  expect(await readWorkerRepos(root)).toBeNull();
  await writeSettings(root, {
    dataRepo: OLDER,
    recentFolders: [
      { path: OLDER, kind: "spec" },
      { path: "/code/app", kind: "code" },
      { path: SPECS, kind: "spec" },
      { path: "./local", kind: "spec" },
    ],
    other: true,
  });
  expect(await readWorkerRepos(root)).toEqual([OLDER, SPECS]);
  // A file the worker's app has not rewritten since the one folder list.
  await writeSettings(root, { dataRepo: OLDER, recentDataRepos: [OLDER, SPECS, "./local"] });
  expect(await readWorkerRepos(root)).toEqual([OLDER, SPECS]);
  await writeSettings(root, {});
  expect(await readWorkerRepos(root)).toEqual([]);
});

test("a settings file that is a symlink is not followed", async () => {
  const root = await freshRoot("link");
  const elsewhere = join(dir, "elsewhere.json");
  await writeFile(elsewhere, JSON.stringify({ dataRepo: SPECS }));
  await mkdir(join(root, ".specdriven"));
  await symlink(elsewhere, join(root, ".specdriven", "settings.yaml"));
  expect(await readWorkerRepos(root)).toBeNull();
  expect(await seedWorkerRepos(root, [OLDER], null)).toBe(false);
  expect(JSON.parse(await readFile(elsewhere, "utf8"))).toEqual({ dataRepo: SPECS });
});

test("a worker with no settings gets the remembered repos; one with settings keeps its own", async () => {
  const root = await freshRoot("seed");
  expect(await seedWorkerRepos(root, [], null)).toBe(false);
  expect(await seedWorkerRepos(root, [SPECS, OLDER], null)).toBe(true);
  const seeded = await readSettings(join(root, ".specdriven", "settings.yaml"));
  expect(seeded).toEqual({
    settingsVersion: SETTINGS_VERSION,
    dataRepo: SPECS,
    recentFolders: [
      { path: SPECS, kind: "spec" },
      { path: OLDER, kind: "spec" },
    ],
    plugins: { repos: {} },
  });

  expect(await seedWorkerRepos(root, [OLDER], null)).toBe(false);
  expect(await readWorkerRepos(root)).toEqual([SPECS, OLDER]);
});

test("after the volume is lost, the user's next worker opens the repo they had open", async () => {
  const dataDir = join(dir, "pool");
  const db = openDatabase(":memory:");
  addUser(db, A);
  const repos = new RecentRepos(db);
  const pool = new WorkerPool({
    dataDir,
    entry: join(import.meta.dir, "..", "src", "index.ts"),
    idleMs: 60_000,
    secrets: async () => ({ github: null, agentKeys: {} }),
    repos,
    stdio: "ignore",
  });
  try {
    // The user picks a repo; the gateway notes it as the worker stops.
    await pool.socketFor(A);
    await writeSettings(userDirs(dataDir, A).root, { dataRepo: SPECS, recentFolders: [{ path: SPECS, kind: "spec" }, { path: OLDER, kind: "spec" }] });
    await pool.stop(A);
    expect(repos.get(A)).toEqual([SPECS, OLDER]);

    // A redeploy without the volume: the user's folder is gone.
    await rm(dataDir, { recursive: true, force: true });
    const socket = await pool.socketFor(A);
    const res = await proxyToWorker(new Request("http://localhost/api/state"), socket, { secure: false });
    const state = (await res.json()) as Record<string, unknown>;
    expect(state.needsDataRepo).toBe(false);
    expect(state.dataRepo).toBe(SPECS);
    expect(state.recentDataRepos).toEqual([SPECS, OLDER]);

    // A running worker's change is noted by the sweep.
    await writeSettings(userDirs(dataDir, A).root, { dataRepo: OLDER, recentFolders: [{ path: OLDER, kind: "spec" }, { path: SPECS, kind: "spec" }] });
    await pool.sweepIdle();
    expect(repos.get(A)).toEqual([OLDER, SPECS]);
  } finally {
    await pool.stopAll();
  }
}, 60_000);

// specs/ui/app-start.feature.md "Settings file": a worker whose app has not
// converted its settings.json to settings.yaml yet still has its repos read,
// and its file is the user's — never seeded over.
test("a worker's settings.json from before YAML is read, and not seeded over", async () => {
  const root = await freshRoot("json");
  await mkdir(join(root, ".specdriven"));
  const json = join(root, ".specdriven", "settings.json");
  await writeFile(json, JSON.stringify({ dataRepo: SPECS, recentDataRepos: [SPECS, OLDER] }));
  expect(await readWorkerRepos(root)).toEqual([SPECS, OLDER]);
  expect(await seedWorkerRepos(root, [OLDER], null)).toBe(false);
  expect(await readdir(join(root, ".specdriven"))).toEqual(["settings.json"]);

  // Once the worker's app has converted it, settings.yaml is the one read.
  await writeSettings(root, { dataRepo: OLDER });
  expect(await readWorkerRepos(root)).toEqual([OLDER]);
});

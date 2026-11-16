// specs/app/hosted-app.feature.md "The part that answers the internet is
// not root": the spawner (src/gateway/spawner.ts) is the one part of the
// hosted gateway that stays root, and the gateway asks it over a unix
// socket (src/gateway/spawnerSocket.ts). What asks may be a gateway someone
// has taken over, so these are about what the spawner refuses — and, in the
// hosted image, about the two processes as they really start.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/gateway/config";
import { openDatabase } from "../src/gateway/db";
import { GATEWAY_UID, OS_UID_BASE } from "../src/gateway/limits";
import { proxyToWorker } from "../src/gateway/proxy";
import type { UserSecrets } from "../src/gateway/secrets";
import {
  checkReport,
  checkStart,
  checkStop,
  Spawner,
  workerIsolation,
  type SpawnerApi,
  type StartRequest,
  type WorkerExit,
} from "../src/gateway/spawner";
import { connectSpawner, MAX_LINE, serveSpawner, SPAWNER_KEY_ENV, SPAWNER_SOCKET_ENV } from "../src/gateway/spawnerSocket";
import { prepareVolume, stateDirOf } from "../src/gateway/volume";
import { WorkerPool } from "../src/gateway/workers";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const KEY = "the-key-only-the-gateway-was-given";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sdsp-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const start = (over: Record<string, unknown> = {}) => ({
  userId: A,
  uid: OS_UID_BASE + 7,
  instance: "abc123",
  env: { PATH: "/usr/bin", SPECDRIVEN_HOSTED: "1" },
  limits: { processes: 512, openFiles: 4096 },
  egressPort: 4100,
  ...over,
});

test("the spawner starts a worker only for a user id that is one and a uid that is a worker's", () => {
  expect(checkStart(start(), { requireUid: true })).toEqual(start() as StartRequest);
  for (const userId of ["../../etc", "", "aaaaaaaa", `${A}/..`, 7, null]) {
    expect(() => checkStart(start({ userId }))).toThrow("Not a user id");
  }
  // Never root, the gateway's own uid, an ordinary account or a fraction.
  for (const uid of [0, 1, 1000, GATEWAY_UID, OS_UID_BASE - 1, OS_UID_BASE + 0.5, -1, 2 ** 32, "200001"]) {
    expect(() => checkStart(start({ uid }), { requireUid: true })).toThrow("uid");
    expect(() => checkStop({ userId: A, uid }, { requireUid: true })).toThrow("uid");
    expect(() => checkReport({ userId: A, uid }, { requireUid: true })).toThrow("uid");
  }
  // As root it never runs a worker as itself; one process for everything (development) may.
  expect(() => checkStart(start({ uid: null }), { requireUid: true })).toThrow("uid is required");
  expect(checkStart(start({ uid: null })).uid).toBeNull();
});

test("the spawner takes an environment of plain names and text, and caps and a port that are numbers in range", () => {
  for (const env of [{ "A=B": "x" }, { "": "x" }, { "A B": "x" }, { A: 1 }, { A: "a\0b" }, ["PATH=/bin"], null, "PATH=/bin"]) {
    expect(() => checkStart(start({ env }))).toThrow();
  }
  expect(() => checkStart(start({ env: { BIG: "x".repeat(600 * 1024) } }))).toThrow("too large");
  for (const limits of [{ processes: 0, openFiles: 4096 }, { processes: 512 }, { processes: "512", openFiles: 4096 }, null]) {
    expect(() => checkStart(start({ limits }))).toThrow();
  }
  for (const egressPort of [0, 70_000, "4100", 1.5]) expect(() => checkStart(start({ egressPort }))).toThrow("port");
  expect(checkStart(start({ egressPort: null })).egressPort).toBeNull();
  for (const instance of ["", "a b", "x".repeat(65), 7]) expect(() => checkStart(start({ instance }))).toThrow("instance");
  // Nothing in a request names a program or a path: what is not known is dropped.
  const extra = checkStart(start({ entry: "/tmp/evil.ts", cwd: "/etc", argv: ["sh"] })) as unknown as Record<string, unknown>;
  expect(Object.keys(extra).sort()).toEqual(["egressPort", "env", "instance", "limits", "uid", "userId"]);
  expect(checkReport({ userId: A, uid: null, settings: "yes", disk: true })).toEqual({ userId: A, uid: null, settings: false, disk: true });
});

/** A spawner that only writes down what it was asked. */
function recording() {
  const asked: [string, unknown][] = [];
  const listeners: ((exit: WorkerExit) => void)[] = [];
  const api: SpawnerApi = {
    start: async (req) => void asked.push(["start", req]),
    stop: async (req) => void asked.push(["stop", req]),
    report: async (req) => {
      asked.push(["report", req]);
      return { running: true, residentMb: 12, settings: { file: "settings.yaml", text: "dataRepo: x\n" } };
    },
    onExit: (listener) => void listeners.push(listener),
  };
  return { api, asked, exit: (exit: WorkerExit) => listeners.forEach((l) => l(exit)) };
}

/** Send raw bytes to a socket and collect what comes back until it closes or goes quiet. */
function raw(path: string, bytes: string): Promise<{ answer: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    let answer = "";
    let closed = false;
    socket.on("data", (chunk) => (answer += chunk));
    socket.on("close", () => {
      closed = true;
      resolve({ answer, closed });
    });
    socket.on("error", () => {});
    socket.on("connect", () => socket.write(bytes));
    setTimeout(() => {
      socket.destroy();
      resolve({ answer, closed });
    }, 300);
  });
}

test("the spawner's socket answers only a connection that says the key, and only messages of its own kind", async () => {
  const path = join(dir, "proto", "spawner.sock");
  const { api, asked } = recording();
  const server = await serveSpawner(api, { path, key: KEY });
  try {
    // The socket is for its owner alone until a group is named.
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    // What a worker could make the gateway send here by linking its own
    // socket to this one: an HTTP request, however its body reads.
    const http = await raw(path, `POST /api/x HTTP/1.1\r\nHost: localhost\r\n\r\n{"hello":"${KEY}"}\n{"id":1,"op":"stop","req":{"userId":"${A}","uid":null}}\n`);
    expect(http).toEqual({ answer: "", closed: true });
    expect((await raw(path, `{"hello":"wrong"}\n`)).closed).toBe(true);
    // No key, no request.
    expect(await raw(path, `{"id":1,"op":"stop","req":{"userId":"${A}","uid":null}}\n`)).toEqual({ answer: "", closed: true });
    // After the key, a line that is no message ends it too.
    const garbled = await raw(path, `{"hello":"${KEY}"}\nnot json\n`);
    expect(garbled).toEqual({ answer: '{"hello":"ok"}\n', closed: true });
    expect(asked).toEqual([]);

    const gateway = await connectSpawner(path, KEY);
    await gateway.stop({ userId: A, uid: null });
    expect(asked).toEqual([["stop", { userId: A, uid: null }]]);
    // A request the spawner will not act on comes back as its reason, and the connection lives on.
    expect(gateway.start(start({ userId: "../../etc" }) as StartRequest)).rejects.toThrow("Not a user id");
    await gateway.start(start({ userId: "../../etc" }) as StartRequest).catch(() => {});
    expect((await gateway.report({ userId: A, uid: null, settings: true })).settings?.text).toBe("dataRepo: x\n");
    gateway.close();
  } finally {
    await server.close();
  }
});

// A worker fills its own settings file, which the spawner reads and sends
// on: whatever it holds must not cost the gateway its connection to the
// spawner, without which the whole service stops.
test("a settings file filled to break the spawner's connection fails that one answer and nothing else", async () => {
  const path = join(dir, "long", "spawner.sock");
  const { api } = recording();
  // A megabyte of control characters: six times as long once written as JSON.
  let text = "\u0001".repeat(1024 * 1024);
  api.report = async () => ({ running: true, residentMb: 1, settings: { file: "settings.yaml", text } });
  const server = await serveSpawner(api, { path, key: KEY });
  const gateway = await connectSpawner(path, KEY);
  try {
    const worst = await gateway.report({ userId: A, uid: null, settings: true });
    expect(worst.settings?.text.length).toBe(1024 * 1024);
    // Longer than any settings file the spawner reads: refused as an answer, and the connection lives.
    text = "\u0001".repeat(Math.ceil(MAX_LINE / 6) + 1);
    expect(gateway.report({ userId: A, uid: null, settings: true })).rejects.toThrow("too long");
    await gateway.report({ userId: A, uid: null, settings: true }).catch(() => {});
    text = "dataRepo: x\n";
    expect((await gateway.report({ userId: A, uid: null, settings: true })).settings?.text).toBe("dataRepo: x\n");
  } finally {
    gateway.close();
    await server.close();
  }
});

test("a wrong key is refused, a worker's end reaches the gateway, and a lost spawner is noticed", async () => {
  const path = join(dir, "events", "spawner.sock");
  const { api, exit } = recording();
  const server = await serveSpawner(api, { path, key: KEY });
  expect(connectSpawner(path, "not-the-key")).rejects.toThrow("spawner is gone");
  await connectSpawner(path, "not-the-key").catch(() => {});

  const gateway = await connectSpawner(path, KEY);
  const ended: WorkerExit[] = [];
  gateway.onExit((e) => ended.push(e));
  exit({ userId: A, instance: "abc123", code: 3 });
  await Bun.sleep(50);
  expect(ended).toEqual([{ userId: A, instance: "abc123", code: 3 }]);

  await server.close();
  await gateway.closed;
  expect(gateway.stop({ userId: A, uid: null })).rejects.toThrow("spawner is gone");
});

test("a worker started through the spawner's socket serves its person, and stops when asked", async () => {
  const dataDir = join(dir, "through-socket");
  const path = join(dir, "real", "spawner.sock");
  const spawner = new Spawner({ dataDir, entry: ENTRY, stdio: "ignore" });
  const server = await serveSpawner(spawner, { path, key: KEY });
  const gateway = await connectSpawner(path, KEY);
  const pool = new WorkerPool({
    dataDir,
    entry: ENTRY,
    idleMs: 60_000,
    secrets: async (): Promise<UserSecrets> => ({ github: null, agentKeys: {} }),
    spawner: gateway,
    stdio: "ignore",
  });
  try {
    const worker = await pool.workerFor(A);
    const res = await proxyToWorker(new Request("http://localhost/api/state"), worker, { secure: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hosted: boolean }).hosted).toBe(true);
    expect((await gateway.report({ userId: A, uid: null })).running).toBe(true);
    await pool.stop(A);
    expect(pool.isRunning(A)).toBe(false);
    expect((await gateway.report({ userId: A, uid: null })).running).toBe(false);
  } finally {
    await pool.stopAll();
    gateway.close();
    await spawner.stopAll();
    await server.close();
  }
}, 60_000);

test("the gateway's folder on the volume takes in the database and datastore an older volume kept beside it", async () => {
  const dataDir = join(dir, "volume");
  await mkdir(join(dataDir, "datastore", ".git"), { recursive: true });
  await writeFile(join(dataDir, "app.db"), "the accounts");
  await writeFile(join(dataDir, "app.db-wal"), "and what was not yet written into them");
  expect(readConfig({ SPECDRIVEN_DATA_DIR: dataDir }).stateDir).toBe(stateDirOf(dataDir));

  const state = await prepareVolume(dataDir, null);
  expect(state).toBe(join(dataDir, "gateway"));
  expect(await readFile(join(state, "app.db"), "utf8")).toBe("the accounts");
  expect(await readFile(join(state, "app.db-wal"), "utf8")).toBe("and what was not yet written into them");
  expect((await stat(join(state, "datastore", ".git"))).isDirectory()).toBe(true);
  expect(await Bun.file(join(dataDir, "app.db")).exists()).toBe(false);
  expect((await stat(state)).mode & 0o777).toBe(0o700);

  // A second start changes nothing, and never puts an older file over a newer one.
  await writeFile(join(dataDir, "app.db"), "a stray older copy");
  await prepareVolume(dataDir, null);
  expect(await readFile(join(state, "app.db"), "utf8")).toBe("the accounts");
});

// From here on: the two processes as the hosted image starts them, which
// takes root and setpriv. Skipped on a developer's machine.
const isolated = workerIsolation();

test.skipIf(!isolated)("root hands the gateway's folder to the gateway's uid once, and stays out of it afterwards", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sdv-"));
  try {
    await writeFile(join(dataDir, "app.db"), "the accounts");
    const state = await prepareVolume(dataDir, GATEWAY_UID);
    for (const path of [state, join(state, "app.db")]) expect((await stat(path)).uid).toBe(GATEWAY_UID);
    expect((await stat(dataDir)).uid).toBe(0);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o711);
    // Handed over, it is the gateway's to arrange: root moves nothing more into it.
    await writeFile(join(dataDir, "app.db-wal"), "left behind");
    await prepareVolume(dataDir, GATEWAY_UID);
    expect(await Bun.file(join(state, "app.db-wal")).exists()).toBe(false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// The image's own entry point, start to stop: root's half (runSpawner in
// src/gateway/spawnerMain.ts) and the gateway it starts (runGateway in
// src/gateway/main.ts).
test.skipIf(!isolated)("started as root, the gateway that answers requests is not root, and a person's worker runs as their own uid", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sde-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  // An older volume: the database beside the users' folders, root's. One
  // address may sign up.
  const seeded = openDatabase(join(dataDir, "app.db"));
  seeded.query("INSERT INTO allowed_emails (email, created_at) VALUES ('ada@example.com', 0)").run();
  seeded.close();

  const gateway = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "gateway", "index.ts")], {
    env: {
      PATH: process.env.PATH,
      HOME: "/root",
      SPECDRIVEN_DATA_DIR: dataDir,
      [SPAWNER_SOCKET_ENV]: join(dataDir, "..", `spawner-${port}`, "spawner.sock"),
      SPECDRIVEN_LOG_FILE: "0",
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) output += new TextDecoder().decode(read.value);
  };
  void collect(gateway.stdout);
  void collect(gateway.stderr);
  const origin = `http://localhost:${port}`;
  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  try {
    for (let i = 0; i < 300 && !output.includes("SpecDriven gateway on"); i++) await Bun.sleep(100);
    expect(output).toContain("SpecDriven gateway on");
    // What the kernel holds a worker to was tried at start, and said.
    expect(output).toContain("workers: a uid each;");
    expect(output).not.toContain("BROKEN");

    // Two processes of this gateway: root's, and the one listening, which is not.
    const uidOf = async (pid: string) => Number((await readFile(`/proc/${pid}/status`, "utf8")).match(/^Uid:\s+(\d+)/m)![1]);
    const children = (await readFile(`/proc/${gateway.pid}/task/${gateway.pid}/children`, "utf8")).trim().split(/\s+/);
    expect(await uidOf(String(gateway.pid))).toBe(0);
    expect(await Promise.all(children.map(uidOf))).toEqual([GATEWAY_UID]);
    const listening = await readFile(`/proc/${children[0]}/cmdline`, "utf8");
    expect(listening).toContain("gateway/index.ts");

    // The database moved into the gateway's own folder and is the gateway's.
    const state = stateDirOf(dataDir);
    expect((await stat(join(state, "app.db"))).uid).toBe(GATEWAY_UID);
    expect((await stat(state)).mode & 0o777).toBe(0o700);
    expect(await Bun.file(join(dataDir, "app.db")).exists()).toBe(false);
    // The spawner's key reached the gateway in its environment, never on a
    // command line, which any process on the machine can read.
    for (const name of [SPAWNER_KEY_ENV, SPAWNER_SOCKET_ENV]) expect(listening).not.toContain(name);

    // Sign up, choose a password, and use the app: the worker is the person's own uid.
    expect((await post("/auth/signup", { email: "ada@example.com" })).status).toBe(200);
    let token: string | undefined;
    for (let i = 0; i < 100 && !token; i++) {
      token = output.match(/set-password#token=([A-Za-z0-9_-]+)/)?.[1];
      if (!token) await Bun.sleep(100);
    }
    expect(token).toBeDefined();
    const signedIn = await post("/auth/set-password", { token, password: "correct horse battery" });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const state1 = await fetch(`${origin}/api/state`, { headers: { cookie } });
    expect(state1.status).toBe(200);
    expect(((await state1.json()) as { hosted: boolean }).hosted).toBe(true);

    const workers: number[] = [];
    for (const pid of (await readFile(`/proc/${gateway.pid}/task/${gateway.pid}/children`, "utf8")).trim().split(/\s+/)) {
      const uid = await uidOf(pid);
      if (uid !== GATEWAY_UID) workers.push(uid);
    }
    expect(workers).toEqual([OS_UID_BASE]);
    // Its socket's folder lets in the worker and the gateway's group, no one else.
    const users = join(dataDir, "users");
    const [userId] = await (await import("node:fs/promises")).readdir(users);
    const run = await stat(join(users, userId!, "run"));
    expect([run.uid, run.gid, run.mode & 0o777]).toEqual([OS_UID_BASE, GATEWAY_UID, 0o750]);

    // A stop from the platform reaches root, which passes it on and ends the worker too.
    gateway.kill("SIGTERM");
    expect(await gateway.exited).toBe(0);
    let left = 0;
    for (const entry of await (await import("node:fs/promises")).readdir("/proc")) {
      if (/^\d+$/.test(entry) && (await stat(`/proc/${entry}`).catch(() => null))?.uid === OS_UID_BASE) left++;
    }
    expect(left).toBe(0);
  } finally {
    gateway.kill("SIGKILL");
    await rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);

// The Cloudflare sync server (cloudflare/sync-server): one sync server per
// data repository, open only to people GitHub says can push to that
// repository. Everything but the Cloudflare glue runs here — the routes, the
// passes, the access check, the storage on SQLite, and a room talking to the
// app's own sync client over a real WebSocket.

import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { checkWriteAccess } from "../cloudflare/sync-server/src/access";
import { createRoom, type Room } from "../cloudflare/sync-server/src/room";
import { handle, repoKey, type RouteDeps } from "../cloudflare/sync-server/src/routes";
import { ROW_BYTES, SqlStorageAdapter, type SqlStore } from "../cloudflare/sync-server/src/storage";
import { signTicket, verifyTicket } from "../cloudflare/sync-server/src/tickets";
import type { RoomSocket } from "../cloudflare/sync-server/src/network";
import * as A from "@automerge/automerge";
import { documentIdForDoc, startNetSyncClient, type NetSync } from "../src/server/automerge/netsync";
import { importFeatureDoc } from "../src/server/automerge/reconcile";
import { createFeatureDoc, loadFeatureDoc } from "../src/server/automerge/store";
import { projectFeature } from "../src/server/automerge/project";
import { parseFeature } from "../src/server/parser";
import { readFeature, saveFeature } from "../src/server/features";
import { writeTextFile } from "../src/server/fsx";

// ---- passes ------------------------------------------------------------------

const SECRET = "a-secret-only-the-server-holds";
const REPO = "github.com/acme/specs";

test("a pass opens the repository it was signed for until it runs out, and nothing else", async () => {
  const pass = await signTicket(SECRET, { repo: REPO, exp: 2000 });
  expect(await verifyTicket(SECRET, pass, REPO, 1999)).toEqual({ repo: REPO, exp: 2000 });
  // Run out, another repository's, another server's.
  expect(await verifyTicket(SECRET, pass, REPO, 2000)).toBeNull();
  expect(await verifyTicket(SECRET, pass, "github.com/acme/other", 1999)).toBeNull();
  expect(await verifyTicket("another-secret", pass, REPO, 1999)).toBeNull();
});

test("a pass that was altered or made up is refused", async () => {
  const pass = await signTicket(SECRET, { repo: REPO, exp: 2000 });
  const [payload, signature] = pass.split(".") as [string, string];
  // The same signature over a later expiry.
  const later = btoa(JSON.stringify({ repo: REPO, exp: 9000 })).replace(/=+$/, "");
  expect(await verifyTicket(SECRET, `${later}.${signature}`, REPO, 1999)).toBeNull();
  expect(await verifyTicket(SECRET, payload, REPO, 1999)).toBeNull();
  expect(await verifyTicket(SECRET, `${payload}.`, REPO, 1999)).toBeNull();
  expect(await verifyTicket(SECRET, `${payload}.${signature}.extra`, REPO, 1999)).toBeNull();
  expect(await verifyTicket(SECRET, "not a pass", REPO, 1999)).toBeNull();
  expect(await verifyTicket(SECRET, "", REPO, 1999)).toBeNull();
});

// ---- who may write -----------------------------------------------------------

/** A GitHub that answers the repository request the way `reply` says. */
function fakeGitHub(reply: () => Response | Promise<Response>) {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return reply();
  }) as typeof fetch;
  return { calls, fetchFn };
}

const repoAnswer = (permissions: unknown, status = 200) =>
  new Response(JSON.stringify({ full_name: "acme/specs", permissions }), { status });

test("only a token GitHub says can push to the repository is let in", async () => {
  const repo = { owner: "acme", name: "specs" };
  const writer = fakeGitHub(() => repoAnswer({ admin: false, push: true, pull: true }));
  expect(await checkWriteAccess("https://api.github.test/", repo, "tok-writer", writer.fetchFn)).toEqual({ ok: true });
  // Asked of GitHub itself, about that repository, with the peer's own token.
  expect(writer.calls).toEqual([
    { url: "https://api.github.test/repos/acme/specs", authorization: "Bearer tok-writer" },
  ]);

  // Reading is not enough.
  const reader = fakeGitHub(() => repoAnswer({ admin: false, push: false, pull: true }));
  expect(await checkWriteAccess("https://api.github.test", repo, "tok-reader", reader.fetchFn)).toMatchObject({
    ok: false,
    status: 403,
  });
  // Nor is an answer that does not say.
  const silent = fakeGitHub(() => repoAnswer(undefined));
  expect(await checkWriteAccess("https://api.github.test", repo, "tok", silent.fetchFn)).toMatchObject({
    ok: false,
    status: 403,
  });
});

test("a token GitHub rejects, a repository it cannot see and a GitHub that is down are all refused", async () => {
  const repo = { owner: "acme", name: "specs" };
  const api = "https://api.github.test";
  const unknown = fakeGitHub(() => new Response("{}", { status: 401 }));
  expect(await checkWriteAccess(api, repo, "tok", unknown.fetchFn)).toMatchObject({ ok: false, status: 401 });
  const hidden = fakeGitHub(() => new Response("{}", { status: 404 }));
  expect(await checkWriteAccess(api, repo, "tok", hidden.fetchFn)).toMatchObject({ ok: false, status: 403 });
  const broken = fakeGitHub(() => new Response("oops", { status: 500 }));
  expect(await checkWriteAccess(api, repo, "tok", broken.fetchFn)).toMatchObject({ ok: false, status: 502 });
  const down = fakeGitHub(() => Promise.reject(new Error("no route")));
  expect(await checkWriteAccess(api, repo, "tok", down.fetchFn)).toMatchObject({ ok: false, status: 502 });
  const garbled = fakeGitHub(() => new Response("<html>", { status: 200 }));
  expect(await checkWriteAccess(api, repo, "tok", garbled.fetchFn)).toMatchObject({ ok: false, status: 502 });
});

// ---- the routes --------------------------------------------------------------

function routes(over: Partial<RouteDeps> = {}) {
  const connected: { key: string; expiresAt: number }[] = [];
  const github = fakeGitHub(() => repoAnswer({ push: true }));
  const deps: RouteDeps = {
    secret: SECRET,
    githubHost: "github.com",
    githubApi: "https://api.github.test",
    ticketSeconds: 3600,
    now: () => 1_000_000,
    fetch: github.fetchFn,
    connect: async (key, _request, expiresAt) => {
      connected.push({ key, expiresAt });
      return new Response("connected");
    },
    ...over,
  };
  const ask = (path: string, init?: RequestInit) => handle(new Request(`https://sync.test${path}`, init), deps);
  return { ask, connected, github };
}

const upgrade = { headers: { upgrade: "websocket" } };

test("a writer gets a pass, and the pass opens that repository's own sync server", async () => {
  const { ask, connected, github } = routes();
  const res = await ask("/Acme/Specs/ticket", { method: "POST", headers: { authorization: "Bearer tok-writer" } });
  expect(res.status).toBe(200);
  const { ticket, expiresAt } = (await res.json()) as { ticket: string; expiresAt: number };
  expect(expiresAt).toBe(1000 + 3600);
  // The token went to GitHub's API and nowhere else.
  expect(github.calls).toEqual([
    { url: "https://api.github.test/repos/Acme/Specs", authorization: "Bearer tok-writer" },
  ]);

  const opened = await ask(`/acme/specs?ticket=${encodeURIComponent(ticket)}`, upgrade);
  expect(await opened.text()).toBe("connected");
  // One server per repository, whatever case its name was typed in.
  expect(connected).toEqual([{ key: "github.com/acme/specs", expiresAt: 4600 }]);
  expect(repoKey("github.com", { owner: "Acme", name: "Specs" })).toBe("github.com/acme/specs");
});

test("a pass for one repository does not open another's sync server", async () => {
  const { ask, connected } = routes();
  const res = await ask("/acme/specs/ticket", { method: "POST", headers: { authorization: "Bearer tok" } });
  const { ticket } = (await res.json()) as { ticket: string };
  const other = await ask(`/acme/payroll?ticket=${encodeURIComponent(ticket)}`, upgrade);
  expect(other.status).toBe(401);
  expect(connected).toEqual([]);
});

test("no pass, no connection", async () => {
  const { ask, connected } = routes();
  expect((await ask("/acme/specs", upgrade)).status).toBe(401);
  expect((await ask("/acme/specs?ticket=made-up", upgrade)).status).toBe(401);
  const stale = await signTicket(SECRET, { repo: "github.com/acme/specs", exp: 999 });
  expect((await ask(`/acme/specs?ticket=${stale}`, upgrade)).status).toBe(401);
  expect(connected).toEqual([]);
});

test("someone who can only read the repository gets no pass", async () => {
  const reader = fakeGitHub(() => repoAnswer({ push: false, pull: true }));
  const { ask } = routes({ fetch: reader.fetchFn });
  const res = await ask("/acme/specs/ticket", { method: "POST", headers: { authorization: "Bearer tok-reader" } });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "Write access to the repository is required" });
  // And without a token GitHub is not even asked.
  const none = await ask("/acme/specs/ticket", { method: "POST" });
  expect(none.status).toBe(401);
  expect(reader.calls.length).toBe(1);
});

test("the server says which GitHub it checks against, so a peer can tell before sending a token", async () => {
  const { ask, github } = routes();
  const res = await ask("/.well-known/specdriven-sync");
  expect(await res.json()).toEqual({ githubHost: "github.com", ticketSeconds: 3600 });
  expect(github.calls).toEqual([]);
});

test("a server with no signing secret, a plain request and a name that is no repository are turned away", async () => {
  const unset = routes({ secret: undefined });
  expect((await unset.ask("/acme/specs/ticket", { method: "POST" })).status).toBe(500);
  const { ask, github } = routes();
  expect((await ask("/acme/specs")).status).toBe(426);
  expect((await ask("/acme/..%2Fother/ticket", { method: "POST", headers: { authorization: "Bearer t" } })).status).toBe(404);
  expect((await ask("/.git/config/ticket", { method: "POST", headers: { authorization: "Bearer t" } })).status).toBe(404);
  expect((await ask("/acme/specs/extra/ticket", { method: "POST" })).status).toBe(404);
  expect(github.calls).toEqual([]);
});

// ---- storage -----------------------------------------------------------------

/** A Durable Object's SQL storage, played by bun:sqlite. */
function sqliteStore(db: Database): SqlStore {
  return {
    exec(query, ...bindings) {
      const statement = db.query(query);
      const rows = /^\s*select/i.test(query)
        ? (statement.all(...(bindings as never[])) as Record<string, unknown>[])
        : (statement.run(...(bindings as never[])), []);
      return { toArray: () => rows };
    },
    transactionSync: (work) => db.transaction(work)(),
  };
}

const bytes = (...values: number[]) => new Uint8Array(values);

test("what the sync server stores is read back whole, however large", async () => {
  const storage = new SqlStorageAdapter(sqliteStore(new Database(":memory:")));
  expect(await storage.load(["doc", "snapshot", "a"])).toBeUndefined();
  await storage.save(["doc", "snapshot", "a"], bytes(1, 2, 3));
  expect(await storage.load(["doc", "snapshot", "a"])).toEqual(bytes(1, 2, 3));
  // Saved again: replaced, not added to.
  await storage.save(["doc", "snapshot", "a"], bytes(9));
  expect(await storage.load(["doc", "snapshot", "a"])).toEqual(bytes(9));
  await storage.save(["doc", "empty"], bytes());
  expect(await storage.load(["doc", "empty"])).toEqual(bytes());

  // Larger than one row holds: cut up on the way in, whole on the way out.
  const large = new Uint8Array(ROW_BYTES * 2 + 17).map((_, i) => i % 251);
  await storage.save(["doc", "snapshot", "large"], large);
  expect(await storage.load(["doc", "snapshot", "large"])).toEqual(large);
  // A smaller value saved over it leaves none of the old rows behind.
  await storage.save(["doc", "snapshot", "large"], bytes(7));
  expect(await storage.load(["doc", "snapshot", "large"])).toEqual(bytes(7));
});

test("a range is the keys under a prefix, and no key that merely starts the same", async () => {
  const storage = new SqlStorageAdapter(sqliteStore(new Database(":memory:")));
  await storage.save(["doc", "incremental", "1"], bytes(1));
  await storage.save(["doc", "incremental", "2"], bytes(2));
  await storage.save(["doc", "snapshot", "x"], bytes(3));
  await storage.save(["doc2", "snapshot", "y"], bytes(4));
  await storage.save(["a/b", "c"], bytes(5)); // a part holding the separator

  const keys = async (prefix: string[]) => (await storage.loadRange(prefix)).map((chunk) => chunk.key.join("|")).sort();
  expect(await keys(["doc", "incremental"])).toEqual(["doc|incremental|1", "doc|incremental|2"]);
  expect(await keys(["doc"])).toEqual(["doc|incremental|1", "doc|incremental|2", "doc|snapshot|x"]);
  expect(await keys(["a"])).toEqual([]);
  expect(await keys(["a/b"])).toEqual(["a/b|c"]);
  expect((await storage.loadRange(["doc", "snapshot"]))[0]!.data).toEqual(bytes(3));

  await storage.removeRange(["doc"]);
  expect(await keys([])).toEqual(["a/b|c", "doc2|snapshot|y"]);
  await storage.remove(["doc2", "snapshot", "y"]);
  expect(await keys([])).toEqual(["a/b|c"]);
});

// ---- a room, with the app's own sync client ----------------------------------

let root: string | null = null;
let wss: WebSocketServer | null = null;
let room: Room | null = null;
let bridges: NetSync[] = [];

afterEach(async () => {
  for (const bridge of bridges) await bridge.stop();
  bridges = [];
  await stopRoom();
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

async function stopRoom(): Promise<void> {
  await room?.repo.shutdown();
  room = null;
  wss?.close();
  wss = null;
}

/** A repository's sync server on a loopback WebSocket, over the given database. */
async function startRoom(db: Database): Promise<string> {
  room = createRoom({ name: "github.com/acme/specs", store: sqliteStore(db) });
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss!.once("listening", () => resolve(null)));
  wss.on("connection", (socket) => {
    socket.binaryType = "arraybuffer";
    room!.network.accept(socket as unknown as RoomSocket);
  });
  const address = wss.address();
  return `ws://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
}

const SEED = "# Seed\n\n## Story @v1 [proposed]\n\n- line one\n- line two\n";
const FILE = "specs/seed.feature.md";

/** Clones of one data repository: the same document lineage in each folder. */
async function clones(...names: string[]): Promise<string[]> {
  root = await mkdtemp(join(tmpdir(), "specdriven-syncserver-"));
  const first = join(root, names[0]!);
  const doc = importFeatureDoc(parseFeature(SEED));
  await createFeatureDoc(first, FILE, doc);
  await writeTextFile(join(first, FILE), projectFeature(doc));
  const dirs = [first];
  for (const name of names.slice(1)) {
    await cp(first, join(root, name), { recursive: true });
    dirs.push(join(root, name));
  }
  return dirs;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 8000) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

test("an edit on one peer reaches another through the repository's sync server", async () => {
  const [a, b] = (await clones("a", "b")) as [string, string];
  const url = await startRoom(new Database(":memory:"));
  bridges.push(await startNetSyncClient(a, url));
  bridges.push(await startNetSyncClient(b, url));

  await saveFeature(a, FILE, SEED.replace("- line one", "- line one, edited on A"));
  await until(async () => (await readFeature(b, FILE))?.includes("edited on A") ?? false, "the edit to reach B");
  expect(room!.network.peerCount).toBe(2);
});

test("the sync server still has a repository's edits after it slept, for a peer that was away", async () => {
  const [a, c] = (await clones("a", "c")) as [string, string];
  const db = new Database(":memory:");
  const url = await startRoom(db);
  const peerA = await startNetSyncClient(a, url);
  await saveFeature(a, FILE, SEED.replace("- line two", "- line two, while C was away"));
  await peerA.idle();
  // The server has it once its own copy of the document holds A's edit.
  const local = (await loadFeatureDoc(a, FILE))!;
  const held = await room!.repo.find<unknown>(documentIdForDoc(local.docId));
  await until(async () => A.getHeads(held.doc() as A.Doc<unknown>).join() === local.heads.join(), "the server to hold the edit");
  // Everyone leaves and the server goes away; only its storage is left.
  await peerA.stop();
  await stopRoom();

  const again = await startRoom(db);
  bridges.push(await startNetSyncClient(c, again));
  await until(async () => (await readFeature(c, FILE))?.includes("while C was away") ?? false, "C to catch up");
});

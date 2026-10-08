// Optional websocket sync (src/server/automerge/netsync.ts): two peers
// bridged through a loopback sync server — the same wiring as
// wss://sync.automerge.org — exchange document operations with no git
// transport at all, and a later git delivery of the same operations is a
// no-op, because merging the same CRDT ops twice changes nothing.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { cp, mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Repo } from "@automerge/automerge-repo";
import {
  WebSocketClientAdapter,
  WebSocketServerAdapter,
} from "@automerge/automerge-repo-network-websocket";
import { WebSocketServer } from "ws";
import { documentIdForDoc, repoTransport, startNetSync } from "../../src/server/automerge/netsync";
import type { NetSync, SyncTransport } from "../../src/server/automerge/netsync";
import { importDrift } from "../../src/server/automerge/driftSync";
import { importFeatureDoc } from "../../src/server/automerge/reconcile";
import { createFeatureDoc, docDir, loadFeatureDoc } from "../../src/server/automerge/store";
import { projectFeature } from "../../src/server/automerge/project";
import { parseFeature } from "../../src/server/parser";
import { readFeature, saveFeature } from "../../src/server/features";
import { writeTextFile } from "../../src/server/fsx";
import { FakeSyncServer } from "../helpers/fakeSyncServer";

let root: string;
let wss: WebSocketServer | null = null;
let serverRepo: Repo | null = null;
let bridges: NetSync[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-netsync-"));
});

afterEach(async () => {
  for (const bridge of bridges) await bridge.stop();
  bridges = [];
  await serverRepo?.shutdown();
  serverRepo = null;
  wss?.close();
  wss = null;
  await rm(root, { recursive: true, force: true });
});

/** An in-process sync server — the role sync.automerge.org plays. */
async function startServer(): Promise<string> {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss!.once("listening", () => resolve(null)));
  const addr = wss.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  serverRepo = new Repo({ network: [new WebSocketServerAdapter(wss)] });
  return `ws://127.0.0.1:${port}`;
}

/** A bridge to the loopback websocket server, or to a fake one. */
async function bridge(dataDir: string, to: string | FakeSyncServer): Promise<NetSync> {
  const transport =
    typeof to === "string" ? repoTransport([new WebSocketClientAdapter(to)]) : to.transport(basename(dataDir));
  const started = await startNetSync(dataDir, transport);
  bridges.push(started);
  return started;
}

const SEED = "# Seed\n\n## Story @v1 [proposed]\n\n- line one\n- line two\n";
const FILE = "specs/seed.feature.md";

/**
 * Two data directories holding the same document lineage — what two git
 * clones of the data repo look like — with no git involved from here on.
 */
async function twoDirs(): Promise<{ a: string; b: string }> {
  const a = join(root, "a");
  const doc = importFeatureDoc(parseFeature(SEED));
  await createFeatureDoc(a, FILE, doc);
  await writeTextFile(join(a, FILE), projectFeature(doc));
  const b = join(root, "b");
  await cp(a, b, { recursive: true });
  return { a, b };
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 8000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("document ids derive deterministically from the docid uuid", () => {
  const uuid = "a3bb189e-8bf9-3888-9912-ace4e6543002";
  expect(documentIdForDoc(uuid)).toBe(documentIdForDoc(uuid));
  expect(documentIdForDoc("a3bb189e-8bf9-3888-9912-ace4e6543003")).not.toBe(
    documentIdForDoc(uuid),
  );
  expect(() => documentIdForDoc("not-a-uuid")).toThrow("Not a document uuid");
});

test("a local save reaches the other peer over websocket alone", async () => {
  const { a, b } = await twoDirs();
  const url = await startServer();
  await bridge(a, url);
  await bridge(b, url);

  // A local auto-save on peer A — no commit, no push, no pull anywhere.
  await saveFeature(a, FILE, SEED.replace("- line one", "- line one, edited on A"));

  await until(
    async () => (await readFeature(b, FILE))?.includes("edited on A") ?? false,
    "the edit to arrive at peer B",
  );

  // Both peers converge to the same document and the same projection.
  const docA = await loadFeatureDoc(a, FILE);
  const docB = await loadFeatureDoc(b, FILE);
  expect(docB!.heads).toEqual(docA!.heads);
  expect(await readFeature(b, FILE)).toBe(await readFeature(a, FILE));

  // Git later delivers the very same operations (chunk files are
  // content-addressed, so a pull is just these copies): a no-op.
  for (const chunk of await readdir(docDir(a, FILE))) {
    await copyFile(join(docDir(a, FILE), chunk), join(docDir(b, FILE), chunk));
  }
  const docB2 = await loadFeatureDoc(b, FILE);
  expect(docB2!.heads).toEqual(docB!.heads);
  expect(projectFeature(docB2!.doc)).toBe(projectFeature(docB!.doc));
});

// The merge is under test here, not the websocket (the test above covers
// that), so this runs on the fake server: settle() replaces polling against
// a deadline, which timed out under a loaded full-suite run. The edits are
// made concurrent by construction — each peer edits before it is connected,
// so neither can have seen the other's — rather than by hoping the real
// server's throttle holds one back until the other is written.
test("concurrent edits on both peers merge through the sync server", async () => {
  const { a, b } = await twoDirs();
  const server = new FakeSyncServer();

  await saveFeature(a, FILE, SEED.replace("- line one", "- line one, from A"));
  await saveFeature(b, FILE, SEED.replace("- line two", "- line two, from B"));
  const peerA = await bridge(a, server);
  const peerB = await bridge(b, server);
  await server.settle(peerA, peerB);

  for (const dir of [a, b]) {
    const text = await readFeature(dir, FILE);
    expect(text).toContain("from A");
    expect(text).toContain("from B");
  }
  expect(await readFeature(a, FILE)).toBe(await readFeature(b, FILE));
  const docA = await loadFeatureDoc(a, FILE);
  const docB = await loadFeatureDoc(b, FILE);
  expect(docB!.heads).toEqual(docA!.heads);
});

test("a remote absorb keeps a local disk edit the sync tick has not absorbed", async () => {
  // A fake sync server: delivery is awaited with settle(), not polled for
  // against a deadline, so the outcome can't depend on timing.
  const { a, b } = await twoDirs();
  const server = new FakeSyncServer();
  const peerA = await bridge(a, server);
  const peerB = await bridge(b, server);

  // A hand (or agent) edit on B, before the next importDrift tick.
  await writeTextFile(
    join(b, FILE),
    SEED + "\n## Disk only @v1 [proposed]\n\n- **Given** from disk\n",
  );

  await saveFeature(a, FILE, SEED.replace("- line one", "- line one, edited on A"));
  await server.settle(peerA, peerB);

  const md = (await readFeature(b, FILE))!;
  expect(md).toContain("edited on A");
  expect(md).toContain("## Disk only @v1 [proposed]");
  expect(projectFeature((await loadFeatureDoc(b, FILE))!.doc)).toBe(md);
  // The disk edit is in the document now — the next tick must not see leftover drift,
  // and must not be the only thing that could have recovered it.
  expect(await importDrift(b)).toBe("");
  // B handed the absorbed disk edit to the network, and it reached A that
  // way, not only through git.
  const fromB = server.pushes.filter((p) => p.peer === "b");
  expect(fromB.some((p) => projectFeature(p.doc).includes("## Disk only"))).toBe(true);
  expect(await readFeature(a, FILE)).toBe(md);
});

test("a peer that starts after the edit still catches up", async () => {
  const { a, b } = await twoDirs();
  const server = new FakeSyncServer();
  const peerA = await bridge(a, server);

  // Peer A edits while B is offline (its bridge not yet started).
  await saveFeature(a, FILE, SEED.replace("- line two", "- line two, while B slept"));
  await server.settle(peerA);

  const peerB = await bridge(b, server);
  await server.settle(peerA, peerB);
  expect(await readFeature(b, FILE)).toContain("while B slept");
  expect(await readFeature(b, FILE)).toBe(await readFeature(a, FILE));
});

test("stopping waits for an absorb in flight, and absorbs nothing after", async () => {
  const { a, b } = await twoDirs();
  // A transport whose deliveries the test makes by hand, so an absorb can be
  // started and stop() called while it is still writing.
  let deliver: Parameters<SyncTransport["share"]>[2] | null = null;
  const transport: SyncTransport = {
    share: (_docId, _doc, onChange) => {
      deliver = onChange;
      return { push: () => {} };
    },
    shutdown: async () => {},
  };
  const peerB = await startNetSync(b, transport);

  // A's edit, as the network would hand it to B.
  await saveFeature(a, FILE, SEED.replace("- line one", "- line one, edited on A"));
  const absorbing = deliver!((await loadFeatureDoc(a, FILE))!.doc);
  await peerB.stop();

  // stop() resolved after the absorb wrote, not before.
  const atStop = await readFeature(b, FILE);
  expect(atStop).toContain("edited on A");
  await absorbing;
  expect(await readFeature(b, FILE)).toBe(atStop);

  // A delivery after stop() is not absorbed.
  await saveFeature(a, FILE, SEED.replace("- line two", "- line two, after B stopped"));
  await deliver!((await loadFeatureDoc(a, FILE))!.doc);
  expect(await readFeature(b, FILE)).toBe(atStop);
});

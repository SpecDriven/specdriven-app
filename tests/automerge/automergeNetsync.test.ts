// Optional websocket sync (src/server/automerge/netsync.ts): two peers
// bridged through a loopback sync server — the same wiring as
// wss://sync.automerge.org — exchange document operations with no git
// transport at all, and a later git delivery of the same operations is a
// no-op, because merging the same CRDT ops twice changes nothing.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { cp, mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "@automerge/automerge-repo";
import {
  WebSocketClientAdapter,
  WebSocketServerAdapter,
} from "@automerge/automerge-repo-network-websocket";
import { WebSocketServer } from "ws";
import { documentIdForDoc, startNetSync } from "../../src/server/automerge/netsync";
import type { NetSync } from "../../src/server/automerge/netsync";
import { importFeatureDoc } from "../../src/server/automerge/reconcile";
import { createFeatureDoc, docDir, loadFeatureDoc } from "../../src/server/automerge/store";
import { projectFeature } from "../../src/server/automerge/project";
import { parseFeature } from "../../src/server/parser";
import { readFeature, saveFeature } from "../../src/server/features";
import { writeTextFile } from "../../src/server/fsx";

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

async function bridge(dataDir: string, url: string): Promise<NetSync> {
  const started = await startNetSync(dataDir, [new WebSocketClientAdapter(url)]);
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

test("concurrent edits on both peers merge through the sync server", async () => {
  const { a, b } = await twoDirs();
  const url = await startServer();
  await bridge(a, url);
  await bridge(b, url);

  await saveFeature(a, FILE, SEED.replace("- line one", "- line one, from A"));
  await saveFeature(b, FILE, SEED.replace("- line two", "- line two, from B"));

  const merged = async (dir: string) => {
    const text = await readFeature(dir, FILE);
    return (text?.includes("from A") && text.includes("from B")) ?? false;
  };
  await until(() => merged(a), "B's edit to arrive at A");
  await until(() => merged(b), "A's edit to arrive at B");

  expect(await readFeature(a, FILE)).toBe(await readFeature(b, FILE));
  const docA = await loadFeatureDoc(a, FILE);
  const docB = await loadFeatureDoc(b, FILE);
  expect(docB!.heads).toEqual(docA!.heads);
});

test("a peer that starts after the edit still catches up", async () => {
  const { a, b } = await twoDirs();
  const url = await startServer();
  await bridge(a, url);

  // Peer A edits while B is offline (its bridge not yet started).
  await saveFeature(a, FILE, SEED.replace("- line two", "- line two, while B slept"));

  await bridge(b, url);
  await until(
    async () => (await readFeature(b, FILE))?.includes("while B slept") ?? false,
    "the earlier edit to reach the late-starting peer",
  );
  expect(await readFeature(b, FILE)).toBe(await readFeature(a, FILE));
});

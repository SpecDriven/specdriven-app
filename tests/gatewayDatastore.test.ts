// The hosted gateway's datastore (src/gateway/datastore.ts): accounts,
// invites, sealed secrets and sessions mirrored as JSON into a git repo, read
// back into an empty database after a redeploy, pushed only when something
// worth keeping changed, and never pushed over the repo before it was read.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMasterKey, loadKeyring } from "../src/gateway/crypto";
import {
  Datastore,
  datastoreGit,
  DEFAULT_DATASTORE_REPO,
  exportSnapshot,
  importSnapshot,
  readDatastoreConfig,
} from "../src/gateway/datastore";
import { openDatabase } from "../src/gateway/db";
import { SecretStore } from "../src/gateway/secrets";
import { SESSION_IDLE_MS, Sessions } from "../src/gateway/sessions";
import { tokenContext, type GitRun } from "../src/server/git/cli";
import { git, seededOrigin } from "./helpers/fixtures";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = 1_800_000_000_000;

let root: string;
let origin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sdds-"));
  origin = await seededOrigin(root, "origin.git", { "README.md": "# Datastore for the hosted app\n" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function addUser(db: ReturnType<typeof openDatabase>, id: string, email: string) {
  db.query("INSERT INTO users (id, email, password_hash, created_at, os_uid) VALUES (?, ?, ?, ?, ?)").run(
    id,
    email,
    `$argon2id$hash-of-${email}`,
    NOW - 1000,
    id === A ? 200000 : 200001,
  );
}

function store(dataDir: string, db: ReturnType<typeof openDatabase>, run: GitRun = datastoreGit("unused")) {
  return new Datastore({ db, dataDir: join(root, dataDir), repo: origin, git: run, now: () => NOW });
}

async function originFile(file: string): Promise<string | null> {
  const res = await $`git --git-dir ${origin} show main:${file}`.quiet().nothrow();
  return res.exitCode === 0 ? res.stdout.toString() : null;
}

async function originCommits(): Promise<number> {
  return Number((await $`git --git-dir ${origin} rev-list --count main`.quiet()).stdout.toString().trim());
}

test("the token and repo come from the environment; no token means no datastore", () => {
  expect(readDatastoreConfig({})).toBeNull();
  expect(readDatastoreConfig({ SPECDRIVEN_DATASTORE_TOKEN: "ghp_x" })).toEqual({
    token: "ghp_x",
    repo: DEFAULT_DATASTORE_REPO,
  });
  expect(
    readDatastoreConfig({ SPECDRIVEN_DATASTORE_TOKEN: " ghp_x ", SPECDRIVEN_DATASTORE_REPO: "https://github.com/o/r" }),
  ).toEqual({ token: "ghp_x", repo: "https://github.com/o/r" });
});

test("the token reaches git through the credential helper's environment, not argv", () => {
  const context = tokenContext("ghp_secret", "SpecDriven gateway", "gateway@specdriven.invalid");
  expect(context.env).toEqual({ SPECDRIVEN_GIT_TOKEN: "ghp_secret" });
  expect(context.config.join(" ")).not.toContain("ghp_secret");
  expect(context.config).toContain("user.name=SpecDriven gateway");
  expect(context.config.some((c) => c.includes("password=$SPECDRIVEN_GIT_TOKEN"))).toBe(true);
});

test("a snapshot read into a fresh database gives back accounts, invites, secrets that still open, and live sessions", async () => {
  const keyring = await loadKeyring({ SPECDRIVEN_MASTER_KEY: generateMasterKey() });
  const db = openDatabase(":memory:");
  addUser(db, A, "a@example.com");
  db.query("INSERT INTO invites (email, invited_by, created_at) VALUES (?, ?, ?)").run("c@example.com", A, NOW);
  await new SecretStore(db, keyring, () => NOW).put(A, "anthropic", "agent_key", "sk-a");
  const sessions = new Sessions(db, () => NOW);
  const live = sessions.create(A, { ip: "203.0.113.9", userAgent: "Browser" });
  const old = sessions.create(A);
  const files = exportSnapshot(db);
  expect(files["sessions.json"]).not.toContain("203.0.113.9");
  expect(files["sessions.json"]).not.toContain("Browser");
  expect(files["secrets.json"]).not.toContain("sk-a");

  const later = NOW + SESSION_IDLE_MS / 2;
  const copy = openDatabase(":memory:");
  // One session expires before the copy is read.
  const parsed = JSON.parse(files["sessions.json"]!) as { expires_at: number }[];
  parsed[0]!.expires_at = later - 1;
  importSnapshot(copy, { ...files, "sessions.json": JSON.stringify(parsed) }, later);

  expect(copy.query("SELECT email, password_hash, os_uid FROM users").all()).toEqual([
    { email: "a@example.com", password_hash: "$argon2id$hash-of-a@example.com", os_uid: 200000 },
  ]);
  expect(copy.query("SELECT email, invited_by FROM invites").all()).toEqual([{ email: "c@example.com", invited_by: A }]);
  expect((await new SecretStore(copy, keyring).values(A)).agentKeys).toEqual({ anthropic: "sk-a" });
  const restored = new Sessions(copy, () => later);
  const survivors = [live, old].filter((token) => restored.lookup(token));
  expect(survivors).toHaveLength(1);
});

test("an empty database is filled from what another gateway pushed; one with accounts keeps its own", async () => {
  const first = openDatabase(":memory:");
  addUser(first, A, "a@example.com");
  const before = store("first", first);
  expect(await before.restore()).toEqual({ imported: 0 });
  expect(await before.save()).toBe(true);
  expect(await originFile("users.json")).toContain("a@example.com");

  // A redeploy without the volume.
  const fresh = openDatabase(":memory:");
  expect(await store("fresh", fresh).restore()).toEqual({ imported: 1 });
  expect(fresh.query("SELECT email FROM users").all()).toEqual([{ email: "a@example.com" }]);

  // A volume that survived is newer than the repo and wins on its next save.
  const survived = openDatabase(":memory:");
  addUser(survived, B, "b@example.com");
  const kept = store("kept", survived);
  expect(await kept.restore()).toEqual({ imported: 0 });
  expect(survived.query("SELECT email FROM users").all()).toEqual([{ email: "b@example.com" }]);
  expect(await kept.save()).toBe(true);
  expect(await originFile("users.json")).not.toContain("a@example.com");
});

test("a sliding session expiry alone is not pushed until a forced save; a new session is", async () => {
  const db = openDatabase(":memory:");
  addUser(db, A, "a@example.com");
  const ds = store("gw", db);
  await ds.restore();
  expect(await ds.save()).toBe(true);
  expect(await ds.save()).toBe(false);
  const commits = await originCommits();

  let now = NOW;
  const sessions = new Sessions(db, () => now);
  const token = sessions.create(A);
  expect(await ds.save()).toBe(true);
  expect(await originCommits()).toBe(commits + 1);

  now += 2 * 60_000;
  expect(sessions.lookup(token)).not.toBeNull(); // slides expires_at
  expect(await ds.save()).toBe(false);
  expect(await originCommits()).toBe(commits + 1);
  expect(await ds.save({ force: true })).toBe(true);
  expect(await originCommits()).toBe(commits + 2);
  // Nothing new at all: even a forced save makes no empty commit.
  expect(await ds.save({ force: true })).toBe(false);
});

test("a repo that cannot be read stops the restore, and nothing is ever pushed over it", async () => {
  const db = openDatabase(":memory:");
  addUser(db, A, "a@example.com");
  const ds = new Datastore({ db, dataDir: join(root, "gw"), repo: join(root, "missing.git"), git: datastoreGit("x") });
  await expect(ds.restore()).rejects.toThrow(/clone failed/);
  await expect(ds.save({ force: true })).rejects.toThrow(/never restored/);
  expect(await originFile("users.json")).toBeNull();
});

test("a push that loses a race to another writer is redone on top of it", async () => {
  const db = openDatabase(":memory:");
  addUser(db, A, "a@example.com");
  const other = join(root, "other");
  await $`git clone ${origin} ${other}`.quiet();
  let raced = false;
  const base = datastoreGit("x");
  const racing: GitRun = async (dir, ...args) => {
    if (args[0] === "push" && !raced) {
      raced = true;
      await Bun.write(join(other, "NOTE.md"), "moved on\n");
      await git(other, "add", "NOTE.md");
      await git(other, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", "elsewhere");
      await git(other, "push", "origin", "HEAD:main");
    }
    return base(dir, ...args);
  };
  const ds = store("gw", db, racing);
  await ds.restore();
  expect(await ds.save()).toBe(true);
  expect(raced).toBe(true);
  expect(await originFile("NOTE.md")).toBe("moved on\n");
  expect(await originFile("users.json")).toContain("a@example.com");
});

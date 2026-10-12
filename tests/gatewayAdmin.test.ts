// Roles in the hosted gateway (src/gateway/admin.ts): the allowed emails the
// admins keep, and the first admin, made once on a database without one.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Admin, ensureOriginalAdmin, normalizeAllowedEntry, ORIGINAL_ADMIN } from "../src/gateway/admin";
import { MIGRATIONS, openDatabase } from "../src/gateway/db";
import type { Mail } from "../src/gateway/mail";
import { Sessions } from "../src/gateway/sessions";

const NOW = 1_700_000_000_000;

let db: ReturnType<typeof openDatabase>;
let sent: Mail[];
let admin: Admin;
let dir: string | null = null;

beforeEach(() => {
  db = openDatabase(":memory:");
  sent = [];
  const mailer = { send: async (m: Mail) => void sent.push(m) };
  admin = new Admin(db, mailer, { baseUrl: () => "https://specs.example.com", now: () => NOW });
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

function addUser(email: string, role = "user", passwordHash: string | null = "$argon2id$old"): string {
  const id = crypto.randomUUID();
  db.query("INSERT INTO users (id, email, password_hash, created_at, role) VALUES (?, ?, ?, ?, ?)").run(
    id,
    email,
    passwordHash,
    NOW,
    role,
  );
  return id;
}

const roleOf = (email: string) =>
  (db.query("SELECT role FROM users WHERE email = ?").get(email) as { role: string } | null)?.role;

test("an allowed entry is an address or @ and a domain, trimmed and lowercased", () => {
  expect(normalizeAllowedEntry(" A@Example.COM ")).toBe("a@example.com");
  expect(normalizeAllowedEntry("@Team.Example")).toBe("@team.example");
  expect(normalizeAllowedEntry("@nodot")).toBeNull();
  expect(normalizeAllowedEntry("@")).toBeNull();
  expect(normalizeAllowedEntry("team.example")).toBeNull();
  expect(normalizeAllowedEntry(7)).toBeNull();
});

test("accounts start as users", () => {
  addUser("a@example.com");
  expect(roleOf("a@example.com")).toBe("user");
});

test("a database from before the roles keeps its accounts as users and its invites as allowed emails", async () => {
  dir = await mkdtemp(join(tmpdir(), "gwdb-"));
  const path = join(dir, "app.db");
  const old = new Database(path, { create: true, strict: true });
  old.exec(MIGRATIONS[0]!);
  old.exec("PRAGMA user_version = 1");
  old.query("INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@example.com', 1)").run();
  old.query("INSERT INTO invites (email, invited_by, created_at) VALUES ('c@example.com', 'u1', 2)").run();
  old.close();

  const migrated = openDatabase(path);
  expect(migrated.query("SELECT email, role FROM users").all()).toEqual([{ email: "a@example.com", role: "user" }]);
  expect(migrated.query("SELECT email, added_by FROM allowed_emails").all()).toEqual([
    { email: "c@example.com", added_by: "u1" },
  ]);
  migrated.close();
});

test("a database without an admin makes the original admin one, with the chosen password", async () => {
  expect(ensureOriginalAdmin(db, NOW)).toBe(true);
  const row = db
    .query("SELECT role, password_hash AS hash, email_verified_at AS verified FROM users WHERE email = ?")
    .get(ORIGINAL_ADMIN) as { role: string; hash: string; verified: number };
  expect(row.role).toBe("admin");
  expect(row.hash).toStartWith("$argon2id$");
  expect(row.verified).toBe(NOW);
  // Once there is an admin, starting again changes nothing.
  expect(ensureOriginalAdmin(db, NOW + 1)).toBe(false);
  expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
});

test("an existing original account becomes the admin with the chosen password, its old sign-ins ended", () => {
  const id = addUser(ORIGINAL_ADMIN);
  addUser("b@example.com");
  const token = new Sessions(db, () => NOW).create(id);
  expect(ensureOriginalAdmin(db, NOW)).toBe(true);
  expect(roleOf(ORIGINAL_ADMIN)).toBe("admin");
  expect(roleOf("b@example.com")).toBe("user");
  const { hash } = db.query("SELECT password_hash AS hash FROM users WHERE id = ?").get(id) as { hash: string };
  expect(hash).not.toBe("$argon2id$old");
  expect(new Sessions(db, () => NOW).lookup(token)).toBeNull();
});

test("a database that has an admin, whoever it is, keeps it", () => {
  addUser("boss@example.com", "admin");
  const id = addUser(ORIGINAL_ADMIN);
  expect(ensureOriginalAdmin(db, NOW)).toBe(false);
  expect(roleOf(ORIGINAL_ADMIN)).toBe("user");
  const { hash } = db.query("SELECT password_hash AS hash FROM users WHERE id = ?").get(id) as { hash: string };
  expect(hash).toBe("$argon2id$old");
});

test("an invite goes only to an address without an account", async () => {
  const bossId = addUser("boss@example.com", "admin");
  addUser("member@example.com");
  addUser("pending@example.com", "user", null);
  for (const email of ["new@example.com", "member@example.com", "pending@example.com"]) {
    admin.allow(bossId, email);
    await admin.invite(bossId, email);
  }
  expect(sent.map((m) => m.to)).toEqual(["new@example.com", "pending@example.com"]);
  expect(admin.allowed().map((a) => [a.email, a.addedBy])).toEqual([
    ["member@example.com", "boss@example.com"],
    ["new@example.com", "boss@example.com"],
    ["pending@example.com", "boss@example.com"],
  ]);
  expect(admin.users().find((u) => u.email === "pending@example.com")?.hasPassword).toBe(false);
});

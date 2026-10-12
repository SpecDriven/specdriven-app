// Accounts in the hosted gateway (src/gateway/accounts.ts,
// src/gateway/sessions.ts, src/gateway/rateLimit.ts): sign-up and password
// reset by single-use emailed link, argon2id passwords, sessions stored as
// hashes that slide and expire, and every session ended on a password change.

import { beforeEach, expect, test } from "bun:test";
import { Accounts, normalizeEmail, passwordProblem, RESET_TTL_MS } from "../src/gateway/accounts";
import { hashToken } from "../src/gateway/crypto";
import { openDatabase } from "../src/gateway/db";
import type { Mail, Mailer } from "../src/gateway/mail";
import { RateLimiter } from "../src/gateway/rateLimit";
import {
  cookiesWithout,
  readSessionToken,
  sessionCookie,
  Sessions,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
} from "../src/gateway/sessions";

let clock: number;
let db: ReturnType<typeof openDatabase>;
let sent: Mail[];
let sessions: Sessions;
let accounts: Accounts;

const PASSWORD = "correct horse battery";

beforeEach(() => {
  clock = 1_700_000_000_000;
  db = openDatabase(":memory:");
  sent = [];
  const mailer: Mailer = { send: async (m) => void sent.push(m) };
  sessions = new Sessions(db, () => clock);
  accounts = new Accounts(db, sessions, mailer, { baseUrl: () => "https://specs.example.com", now: () => clock });
  // The admins' list (src/gateway/admin.ts): one address and one domain.
  allow("a@example.com", "@team.example");
});

function allow(...entries: string[]) {
  for (const entry of entries) {
    db.query("INSERT INTO allowed_emails (email, created_at) VALUES (?, ?)").run(entry, clock);
  }
}

/** The token from the last email's link. */
function lastLinkToken(): string {
  const match = sent.at(-1)!.text.match(/set-password#token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`no link in: ${sent.at(-1)?.text}`);
  return match[1]!;
}

async function signUp(email = "a@example.com"): Promise<string> {
  await accounts.signup(email);
  const result = await accounts.setPassword(lastLinkToken(), PASSWORD);
  if ("error" in result) throw new Error(result.error);
  return result.userId;
}

test("sign-up emails a link to an allowed address or domain, and nothing to others", async () => {
  await accounts.signup("a@example.com");
  await accounts.signup("someone@team.example");
  await accounts.signup("stranger@example.com");
  expect(sent.map((m) => m.to)).toEqual(["a@example.com", "someone@team.example"]);
  expect(sent[0]!.subject).toMatch(/Finish setting up/);
  // The link carries the token in the fragment, which no server ever sees.
  expect(sent[0]!.text).toContain("https://specs.example.com/set-password#token=");
});

test("an address put on the list later can sign up, and is matched whatever its case", async () => {
  await accounts.signup("guest@else.example");
  expect(sent).toEqual([]);
  allow("Guest@Else.example");
  await accounts.signup("guest@else.example");
  expect(sent.at(-1)!.subject).toMatch(/Finish setting up/);
});

test("an address cannot sign in until its link sets a password", async () => {
  await accounts.signup("a@example.com");
  expect(await accounts.login("a@example.com", PASSWORD)).toBeNull();
  const result = await accounts.setPassword(lastLinkToken(), PASSWORD);
  expect("userId" in result).toBe(true);
  expect(await accounts.login("a@example.com", PASSWORD)).toBe((result as { userId: string }).userId);
  expect(await accounts.login("a@example.com", "wrong password here")).toBeNull();
  expect(await accounts.login("nobody@example.com", PASSWORD)).toBeNull();
});

test("passwords are stored as argon2id hashes", async () => {
  await signUp();
  const row = db.query("SELECT password_hash AS h FROM users").get() as { h: string };
  expect(row.h.startsWith("$argon2id$")).toBe(true);
  expect(row.h).not.toContain(PASSWORD);
});

test("a link works once, and a weak password does not use it up", async () => {
  await accounts.signup("a@example.com");
  const token = lastLinkToken();
  expect(await accounts.setPassword(token, "short")).toEqual({ error: "Use at least 12 characters" });
  expect("userId" in (await accounts.setPassword(token, PASSWORD))).toBe(true);
  expect("error" in (await accounts.setPassword(token, PASSWORD))).toBe(true);
});

test("only the newest link works, and links are stored hashed", async () => {
  await accounts.signup("a@example.com");
  const first = lastLinkToken();
  await accounts.signup("a@example.com");
  const second = lastLinkToken();
  const stored = (db.query("SELECT token_hash AS h FROM email_tokens").all() as { h: string }[]).map((r) => r.h);
  expect(stored).toContain(hashToken(second));
  expect(stored).not.toContain(second);
  expect("error" in (await accounts.setPassword(first, PASSWORD))).toBe(true);
  expect("userId" in (await accounts.setPassword(second, PASSWORD))).toBe(true);
});

test("a forgotten password gets a reset link that expires in 30 minutes", async () => {
  await signUp();
  sent = [];
  await accounts.forgot("a@example.com");
  expect(sent[0]!.subject).toMatch(/Reset your/);
  clock += RESET_TTL_MS + 1;
  expect(await accounts.setPassword(lastLinkToken(), "a brand new passphrase")).toEqual({
    error: "This link is invalid or has expired — ask for a new one",
  });
});

test("forgot sends nothing for an unknown address, and sign-up of a taken one sends a reset", async () => {
  await accounts.forgot("nobody@example.com");
  expect(sent).toEqual([]);
  await signUp();
  sent = [];
  await accounts.signup("a@example.com");
  expect(sent[0]!.subject).toMatch(/Reset your/);
});

test("a reset ends every session and sends a change notice", async () => {
  const userId = await signUp();
  const token = sessions.create(userId);
  expect(sessions.lookup(token)?.userId).toBe(userId);
  sent = [];
  await accounts.forgot("a@example.com");
  const result = await accounts.setPassword(lastLinkToken(), "a brand new passphrase");
  expect("userId" in result).toBe(true);
  expect(sessions.lookup(token)).toBeNull();
  await Bun.sleep(0);
  expect(sent.map((m) => m.subject)).toContain("Your SpecDriven password was changed");
  expect(await accounts.login("a@example.com", PASSWORD)).toBeNull();
  expect(await accounts.login("a@example.com", "a brand new passphrase")).toBe(userId);
});

test("changing the password needs the current one and ends every session", async () => {
  const userId = await signUp();
  const token = sessions.create(userId);
  expect(await accounts.changePassword(userId, "not it at all", "another passphrase")).toEqual({
    error: "The current password is wrong",
  });
  expect(sessions.lookup(token)).not.toBeNull();
  expect(await accounts.changePassword(userId, PASSWORD, "another passphrase")).toEqual({ ok: true });
  expect(sessions.lookup(token)).toBeNull();
});

test("password rules — length, common passwords, the email's name", () => {
  expect(passwordProblem("short")).toMatch(/at least 12/);
  expect(passwordProblem("x".repeat(257))).toMatch(/at most/);
  expect(passwordProblem("password1234")).toMatch(/common/);
  expect(passwordProblem("aaaaaaaaaaaaaaa")).toMatch(/common/);
  expect(passwordProblem("alice-is-great-2024", "alice@example.com")).toMatch(/email/);
  expect(passwordProblem(PASSWORD, "a@example.com")).toBeNull();
});

test("emails are trimmed and lowercased; non-emails are refused", () => {
  expect(normalizeEmail("  A@Example.COM ")).toBe("a@example.com");
  expect(normalizeEmail("nope")).toBeNull();
  expect(normalizeEmail(42)).toBeNull();
});

test("a session is stored as a hash, slides with use and ends at 30 days", async () => {
  const userId = await signUp();
  const token = sessions.create(userId);
  const row = db.query("SELECT id_hash AS h FROM sessions").get() as { h: string };
  expect(row.h).toBe(hashToken(token));

  // Used every 10 days, it lives past the 14-day idle limit…
  for (let day = 10; day < 30; day += 10) {
    clock += 10 * 24 * 60 * 60 * 1000;
    expect(sessions.lookup(token)?.userId).toBe(userId);
  }
  // …but never past 30 days from sign-in.
  clock += 10 * 24 * 60 * 60 * 1000;
  expect(sessions.lookup(token)).toBeNull();
});

test("an unused session expires after 14 days", async () => {
  const userId = await signUp();
  const token = sessions.create(userId);
  clock += SESSION_IDLE_MS + 1;
  expect(sessions.lookup(token)).toBeNull();
  expect(SESSION_MAX_MS).toBeGreaterThan(SESSION_IDLE_MS);
});

test("the session cookie is HttpOnly, SameSite=Lax, and __Host- Secure over https", () => {
  const secure = sessionCookie("tok", { secure: true });
  expect(secure).toStartWith("__Host-sd_session=tok; Path=/; HttpOnly; SameSite=Lax");
  expect(secure).toEndWith("Secure");
  expect(sessionCookie("tok", { secure: false })).not.toContain("Secure");
  const req = new Request("http://x/", { headers: { cookie: "theme=dark; __Host-sd_session=tok; other=1" } });
  expect(readSessionToken(req, { secure: true })).toBe("tok");
  expect(cookiesWithout(req.headers.get("cookie"), { secure: true })).toBe("theme=dark; other=1");
  expect(cookiesWithout("__Host-sd_session=tok", { secure: true })).toBeNull();
});

test("the rate limiter allows max attempts per window, then refuses until it passes", () => {
  const limiter = new RateLimiter(db, () => clock);
  const limit = { key: "login:email:a", max: 3, windowMs: 60_000 };
  expect([1, 2, 3].map(() => limiter.hit(limit))).toEqual([true, true, true]);
  expect(limiter.hit(limit)).toBe(false);
  expect(limiter.blocked(limit)).toBe(true);
  clock += 60_000;
  expect(limiter.hit(limit)).toBe(true);
  limiter.reset("login:email:a");
  expect(limiter.blocked(limit)).toBe(false);
});

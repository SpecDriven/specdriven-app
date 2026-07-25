import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { join } from "node:path";
import { getCurrentUser } from "../src/server/user";
import { createFileBackend, saveToken, setTokenBackend } from "../src/server/tokenStore";

// specs/user-info-settings.spec.md: the current user defaults to the OS
// user; the commit-author identity rides along for the User info dialog —
// the signed-in GitHub account, or the system git identity when signed out.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-user-"));
  setTokenBackend(createFileBackend(join(dir, "token.json")));
});

afterEach(async () => {
  setTokenBackend(createFileBackend());
  await rm(dir, { recursive: true, force: true });
});

describe("getCurrentUser", () => {
  test("username is the OS user", async () => {
    const user = await getCurrentUser();
    expect(user.username).toBe(userInfo().username);
    expect(user.username.length).toBeGreaterThan(0);
  });

  test("signed out: no login; identity fields are trimmed strings or null", async () => {
    const { login, name, email } = await getCurrentUser();
    expect(login).toBeNull();
    for (const value of [name, email]) {
      if (value !== null) {
        expect(typeof value).toBe("string");
        expect(value).toBe(value.trim());
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  test("signed in: the GitHub identity wins", async () => {
    await saveToken({
      token: "tok",
      login: "octo",
      name: "Octo Cat",
      email: "5+octo@users.noreply.github.com",
      id: 5,
    });
    const user = await getCurrentUser();
    expect(user.login).toBe("octo");
    expect(user.name).toBe("Octo Cat");
    expect(user.email).toBe("5+octo@users.noreply.github.com");
  });
});

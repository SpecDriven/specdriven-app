import { describe, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { getCurrentUser } from "../src/server/user";

// specs/user-info-settings.spec.md: the current user defaults to the OS
// user; the git identity (name/email) rides along for the User info dialog.

describe("getCurrentUser", () => {
  test("username is the OS user", async () => {
    const user = await getCurrentUser();
    expect(user.username).toBe(userInfo().username);
    expect(user.username.length).toBeGreaterThan(0);
  });

  test("git identity fields are trimmed strings or null", async () => {
    const { name, email } = await getCurrentUser();
    for (const value of [name, email]) {
      if (value !== null) {
        expect(typeof value).toBe("string");
        expect(value).toBe(value.trim());
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});

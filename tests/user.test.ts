import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setGitEngine } from "../src/server/git";
import { run } from "../src/server/run";
import { writeState } from "../src/server/state";
import { getCurrentUser } from "../src/server/user";
import { createFileBackend, saveToken, setTokenBackend } from "../src/server/tokenStore";

// specs/user-info-settings.feature.md: the current user defaults to the OS
// user; the commit-author identity rides along for the User info dialog —
// the signed-in GitHub account, or the system git identity when signed out.

let dir: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-user-"));
  setTokenBackend(createFileBackend(join(dir, "token.json")));
  // No data repo configured unless a test records one.
  process.env.SPECDRIVEN_ROOT = join(dir, "app");
  process.env.SPECDRIVEN_HOME = join(dir, "home");
});

afterEach(async () => {
  setTokenBackend(createFileBackend());
  setGitEngine(null);
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

  test("signed out, the identity is git's as resolved in the data repo, not the app's folder", async () => {
    // The desktop app runs from its user-data folder, where only the global
    // identity applies; the commits are made in the data repo, whose own
    // config (or an includeIf rule matching it) may name someone else.
    setGitEngine("cli");
    const app = join(dir, "app");
    const data = join(dir, "data");
    await run("git", ["init", "-q", data]);
    await run("git", ["config", "user.name", "Repo Author"], { cwd: data });
    await run("git", ["config", "user.email", "author@repo.example"], { cwd: data });
    await writeState({ dataRepo: data }, app);
    const user = await getCurrentUser();
    expect(user.name).toBe("Repo Author");
    expect(user.email).toBe("author@repo.example");
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

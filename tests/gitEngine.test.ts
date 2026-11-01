// Git engine selection (git-operations.md): the GitHub CLI is the
// default wherever gh is installed, Settings can force either engine, and an
// engine whose binary is missing is a clear error rather than a hang. The gh
// engine itself is exercised against a stub gh on PATH (helpers/binPath.ts),
// so nothing here talks to real GitHub.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  cliGitAvailable,
  clone,
  commitAndPush,
  currentEngine,
  ghAccount,
  ghAvailable,
  ghSignedIn,
  jsGitAvailable,
  normalizeGitEngine,
  pull,
  resolveConflict,
  setGitEngine,
  theirsVersion,
} from "../src/server/git";
import type { GitRun } from "../src/server/git/cli";
import { jsClone } from "../src/server/git/js";
import { FAKE_GH_ACCOUNT, installFakeGh } from "./helpers/binPath";
import type { FakeGh } from "./helpers/binPath";
import { git, seededOrigin, stopServers, twoClones } from "./helpers/fixtures";

let root: string;
let gh: FakeGh | null = null;
const realPath = process.env.PATH;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-engine-"));
});

afterEach(async () => {
  gh?.restore();
  gh = null;
  setGitEngine(null);
  process.env.PATH = realPath;
  await rm(root, { recursive: true, force: true });
});

/** Put a stub gh on PATH and let the engine layer notice it. */
function withGh(options?: Parameters<typeof installFakeGh>[0]): FakeGh {
  gh = installFakeGh(options);
  setGitEngine(null); // drops what gh reported before this one existed
  return gh;
}

test("normalizeGitEngine accepts the three engine names only", () => {
  expect(normalizeGitEngine("cli")).toBe("cli");
  expect(normalizeGitEngine("gh")).toBe("gh");
  expect(normalizeGitEngine("js")).toBe("js");
  expect(normalizeGitEngine("https")).toBeNull(); // older scheme values
  expect(normalizeGitEngine(undefined)).toBeNull();
});

// Scenario: the GitHub CLI is the default when it is installed.
test("the default engine follows what is installed; the setting overrides it", () => {
  expect(ghAvailable()).toBe(false); // the preloaded PATH hides the real gh
  expect(currentEngine()).toBe("cli");

  withGh();
  expect(ghAvailable()).toBe(true);
  expect(currentEngine()).toBe("gh");

  setGitEngine("cli");
  expect(currentEngine()).toBe("cli");
  setGitEngine("js");
  expect(currentEngine()).toBe("js");
  setGitEngine(null);
  expect(currentEngine()).toBe("gh");
});

// Scenario: the bundled engine is the default when no git is installed.
test("with no git binary the bundled engine takes over by default", () => {
  process.env.PATH = "/nonexistent";
  expect(cliGitAvailable()).toBe(false);
  expect(ghAvailable()).toBe(false);
  expect(jsGitAvailable()).toBe(true); // it ships with the app
  expect(currentEngine()).toBe("js");
});

test("gh reports its sign-in state and account", async () => {
  const stub = withGh();
  expect(await ghSignedIn()).toBe(true);
  // The account's email is private, so the noreply address stands in.
  expect(await ghAccount()).toEqual(FAKE_GH_ACCOUNT);
  expect(stub.calls()).toContain("api user");
});

test("gh installed but signed out has no account", async () => {
  withGh({ signedIn: false });
  expect(ghAvailable()).toBe(true);
  expect(await ghSignedIn()).toBe(false);
  expect(await ghAccount()).toBeNull();
});

// Scenario: clone a GitHub repo through the GitHub CLI.
test("the gh engine clones GitHub repos with `gh repo clone`", async () => {
  const origin = await seededOrigin(root);
  const stub = withGh({ origin });
  const dir = join(root, "clone");
  await clone("https://github.com/octo/data-insurance", dir);
  expect(await Bun.file(join(dir, "specs/seed.feature.md")).exists()).toBe(true);
  expect(stub.calls()).toContain("repo clone");
});

test("the gh engine leaves non-GitHub urls to plain git clone", async () => {
  const origin = join(root, "origin.git");
  await $`git init --bare -b main ${origin}`.quiet();
  const stub = withGh({ origin });
  await clone(origin, join(root, "clone"));
  expect(stub.calls()).not.toContain("repo clone");
});

test("a clone gh cannot do surfaces as a clone failure", async () => {
  withGh(); // no origin: the stub reports "Repository not found"
  expect(clone("https://github.com/octo/nope", join(root, "x"))).rejects.toThrow(
    "Could not clone",
  );
});

// git-operations.md: the gh account authors the data-repo commits.
test("commits on the gh engine are authored by the gh account", async () => {
  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "repo@example.com");
  await git(repo, "config", "user.name", "Repo Config");
  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");

  withGh();
  const res = await commitAndPush(repo, "specs/one.feature.md", "Add one");
  expect(res.pushed).toBe(false); // no upstream on a local-only repo
  const author = await git(repo, "log", "-1", "--format=%an <%ae>");
  expect(author.stdout.toString().trim()).toBe(
    `${FAKE_GH_ACCOUNT.name} <${FAKE_GH_ACCOUNT.email}>`,
  );
});

// Signed out of gh there is nothing for it to contribute, so the repo's own
// git identity keeps authoring — the machine's setup is not overridden.
test("with gh signed out the repo's own git identity still authors commits", async () => {
  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "repo@example.com");
  await git(repo, "config", "user.name", "Repo Config");
  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");

  withGh({ signedIn: false });
  await commitAndPush(repo, "specs/one.feature.md", "Add one");
  const author = await git(repo, "log", "-1", "--format=%an <%ae>");
  expect(author.stdout.toString().trim()).toBe("Repo Config <repo@example.com>");
});

// Domain outcomes are the same answer on either engine.
test("a plain directory and a repo without an upstream skip the pull", async () => {
  expect((await pull(root)).message).toContain("not a standalone git repository");

  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "T");
  expect((await pull(repo)).message).toContain("no upstream");
});

test("choosing the GitHub CLI engine without gh installed is a clear error", async () => {
  expect(ghAvailable()).toBe(false);
  setGitEngine("gh");
  expect(pull(root)).rejects.toThrow(
    "GitHub CLI selected but no gh found — switch Git engine in Settings",
  );
});

// An engine named in the settings file but no longer installed stays an
// error rather than silently becoming the bundled one.
test("choosing system git without a git binary is a clear error", async () => {
  expect(cliGitAvailable()).toBe(true); // sanity: the preloaded PATH has git
  process.env.PATH = "/nonexistent";
  expect(cliGitAvailable()).toBe(false);
  setGitEngine("cli");
  expect(pull(root)).rejects.toThrow(
    "System git selected but no git found — switch Git engine to Built-in in Settings",
  );
});

// Scenario: the bundled engine works without git installed. The fixture is
// built with the real binary, then PATH is emptied — everything after this
// point is the app's own git.
test("the bundled engine clones, commits and pushes with no git on PATH", async () => {
  const { a, originDir } = await twoClones(root);
  const noGit = join(root, "no-git-clone");
  process.env.PATH = "/nonexistent";
  expect(cliGitAvailable()).toBe(false);
  setGitEngine("js");

  await clone(originDir, noGit);
  expect(await Bun.file(join(noGit, "specs/seed.feature.md")).exists()).toBe(true);

  await Bun.write(join(noGit, "specs/added.feature.md"), "# Added\n");
  const res = await commitAndPush(noGit, "specs/added.feature.md", "Add one");
  expect(res).toEqual({ pushed: true, message: "committed and pushed" });

  // The other clone, and the real git binary, see what the engine pushed.
  process.env.PATH = realPath!;
  const log = await git(originDir, "log", "-1", "--pretty=%s");
  expect(log.stdout.toString().trim()).toBe("Add one");
  await git(a, "pull");
  expect(await Bun.file(join(a, "specs/added.feature.md")).exists()).toBe(true);
  stopServers();
});

// git-operations.md: the signed-in account authors the commits on
// the bundled engine too. Signed out, the repository's own git config does.
test("with no sign-in the bundled engine leaves the repo's git identity alone", async () => {
  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "repo@example.com");
  await git(repo, "config", "user.name", "Repo Config");
  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");

  setGitEngine("js");
  const res = await commitAndPush(repo, "specs/one.feature.md", "Add one");
  expect(res.pushed).toBe(false); // no upstream on a local-only repo
  const author = await git(repo, "log", "-1", "--format=%an <%ae>");
  expect(author.stdout.toString().trim()).toBe("Repo Config <repo@example.com>");
});

// Below the repository's own config comes the user's global one: choosing
// this engine must not stop honouring the identity the rest of the machine's
// git already uses.
test("the bundled engine falls back to the global git identity", async () => {
  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet(); // no user.* in this repo's config
  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");
  const globalConfig = join(root, "gitconfig");
  await Bun.write(
    globalConfig,
    "# a comment\n[core]\n\teditor = vi\n[user]\n\tname = Global Person\n\temail = global@example.com\n",
  );
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;

  setGitEngine("js");
  await commitAndPush(repo, "specs/one.feature.md", "Add one");
  process.env.GIT_CONFIG_GLOBAL = before;

  const author = await git(repo, "log", "-1", "--format=%an <%ae>");
  expect(author.stdout.toString().trim()).toBe("Global Person <global@example.com>");
});

// With no git config anywhere — the machine this engine exists for — a
// commit must still succeed rather than fail for want of an author.
test("the bundled engine still commits with no git identity configured at all", async () => {
  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet();
  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(root, "no-such-gitconfig");

  setGitEngine("js");
  await commitAndPush(repo, "specs/one.feature.md", "Add one");
  process.env.GIT_CONFIG_GLOBAL = before;

  const author = await git(repo, "log", "-1", "--format=%an");
  expect(author.stdout.toString().trim()).toBe(userInfo().username);
});

// The bundled engine reads and writes the same on-disk format, so the real
// binary and the app agree about a repository either of them touched.
test("a merge conflict raised by the bundled engine is a real git conflict", async () => {
  const { a, b } = await twoClones(root);
  setGitEngine("js");

  await Bun.write(join(b, "specs/seed.feature.md"), "# Seed\n\nfrom b\n");
  await git(b, "add", ".");
  await git(b, "commit", "-m", "b edit");
  await git(b, "push");

  await Bun.write(join(a, "specs/seed.feature.md"), "# Seed\n\nfrom a\n");
  await commitAndPush(a, "specs/seed.feature.md", "a edit");

  const res = await pull(a);
  expect(res.ok).toBe(false);
  expect(res.conflictedFiles).toEqual(["specs/seed.feature.md"]);
  // The real binary sees the same unmerged state the app reported.
  const status = await git(a, "status", "--porcelain");
  expect(status.stdout.toString()).toContain("UU specs/seed.feature.md");
  expect(await theirsVersion(a, "specs/seed.feature.md")).toBe("# Seed\n\nfrom b\n");

  const resolved = await resolveConflict(a, "specs/seed.feature.md", "# Seed\n\nmerged\n");
  expect(resolved.pushed).toBe(true);
  expect((await git(a, "status", "--porcelain")).stdout.toString().trim()).toBe("");
  stopServers();
});

// A Windows user on v0.1.204 could not clone at all on the bundled engine:
// just-git resolves the target directory against its working directory and
// recognises only POSIX absolute paths, so `C:\Users\…\repos\specs` was taken
// for a relative one and the clone failed with an ENOENT on
// `<unpacked release dir>\C:\Users\…\repos\specs`. The engine now clones from
// inside the target's parent, naming only the last segment, so just-git never
// has to recognise the absolute target at all.
test("the bundled engine never hands just-git the absolute clone target", async () => {
  const calls: Array<[string | null, string[]]> = [];
  const recording: GitRun = async (repoDir, ...args) => {
    calls.push([repoDir, args]);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const target = join(root, "not", "yet", "there", "specs");
  await jsClone(recording, "https://github.com/octo/specs", target);

  expect(calls).toEqual([[join(root, "not", "yet", "there"), ["clone", "https://github.com/octo/specs", "specs"]]]);
  // just-git creates the target itself but needs the directory it runs in.
  expect(await stat(join(root, "not", "yet", "there")).then((s) => s.isDirectory())).toBe(true);
});

test("a failed clone on the bundled engine reports the url and git's output", async () => {
  const failing: GitRun = async () => ({ exitCode: 128, stdout: "", stderr: "repository 'x' does not exist\n" });
  await expect(jsClone(failing, "https://github.com/octo/nope", join(root, "x"))).rejects.toThrow(
    "Could not clone https://github.com/octo/nope: repository 'x' does not exist",
  );
  const denied: GitRun = async () => ({ exitCode: 128, stdout: "", stderr: "HTTP 401 fetching refs\n" });
  await expect(jsClone(denied, "https://github.com/octo/private", join(root, "y"))).rejects.toThrow(
    /Could not clone https:\/\/github.com\/octo\/private: (?!HTTP 401)/,
  );
});

// The same through the engine, end to end: an absolute target whose parent
// does not exist yet lands exactly where the app asked, not under the
// process's working directory.
test("the bundled engine clones into an absolute target whose parent does not exist", async () => {
  const { originDir } = await twoClones(root);
  const target = join(root, "deep", "er", "clone");
  process.env.PATH = "/nonexistent";
  setGitEngine("js");

  await clone(originDir, target);
  expect(await Bun.file(join(target, "specs/seed.feature.md")).exists()).toBe(true);
  expect(await stat(join(target, ".git")).then((s) => s.isDirectory())).toBe(true);
  expect(await stat(join(process.cwd(), root.replace(/^\//, ""))).catch(() => null)).toBeNull();
  stopServers();
});

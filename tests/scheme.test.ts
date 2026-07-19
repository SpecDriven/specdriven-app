import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  GIT_SCHEMES,
  discoverScheme,
  gitSchemeFor,
  normalizeGitScheme,
  recordDiscoveredScheme,
  schemeArgs,
  setGitScheme,
} from "../src/server/scheme";
import { pull, commitAndPush } from "../src/server/git";

let root: string;

beforeEach(async () => {
  setGitScheme(null); // also forgets discoveries from earlier tests
  root = await mkdtemp(join(tmpdir(), "specdriven-scheme-"));
});

afterEach(async () => {
  setGitScheme(null);
  await rm(root, { recursive: true, force: true });
});

// specs/user-info-settings.spec.md "Git scheme": the logged-in user uses one
// of the 3 schemes, auto-discovered by probing in the order https, ssh, gh.
test("the three schemes, in probe order", () => {
  expect(GIT_SCHEMES).toEqual(["https", "ssh", "gh"]);
});

test("normalizeGitScheme accepts only the three schemes", () => {
  expect(normalizeGitScheme("https")).toBe("https");
  expect(normalizeGitScheme("ssh")).toBe("ssh");
  expect(normalizeGitScheme("gh")).toBe("gh");
  expect(normalizeGitScheme("auto")).toBeNull();
  expect(normalizeGitScheme(undefined)).toBeNull();
  expect(normalizeGitScheme(42)).toBeNull();
});

// specs/git-operations.spec.md: the scheme is applied per command, so every
// git command follows it no matter which url the clone was created with.
test("scheme config rewrites GitHub remotes to the scheme's transport", () => {
  expect(schemeArgs("https").join(" ")).toContain(
    "url.https://github.com/.insteadOf=git@github.com:",
  );
  expect(schemeArgs("ssh").join(" ")).toContain(
    "url.git@github.com:.insteadOf=https://github.com/",
  );
  const gh = schemeArgs("gh").join(" ");
  expect(gh).toContain("url.https://github.com/.insteadOf=git@github.com:");
  expect(gh).toContain("credential.helper=!gh auth git-credential");
  expect(schemeArgs(null)).toEqual([]);
});

test("a discovered scheme applies to that repo until settings change", async () => {
  recordDiscoveredScheme("/repo", "ssh");
  expect(gitSchemeFor("/repo")).toBe("ssh");
  expect(gitSchemeFor("/other")).toBeNull();
  expect(await discoverScheme("/repo")).toBe("ssh");
  // back to auto: discoveries are forgotten, so the next use re-probes
  setGitScheme(null);
  expect(gitSchemeFor("/repo")).toBeNull();
});

test("a chosen scheme wins over any discovery", async () => {
  recordDiscoveredScheme("/repo", "ssh");
  setGitScheme("gh");
  expect(gitSchemeFor("/repo")).toBe("gh");
  expect(await discoverScheme("/repo")).toBe("gh");
  // while a scheme is chosen, probes record nothing
  recordDiscoveredScheme("/other", "https");
  setGitScheme(null);
  expect(gitSchemeFor("/other")).toBeNull();
});

/** A local origin and a clone of it, standing in for a GitHub setup. */
async function seededClone(): Promise<string> {
  const origin = join(root, "origin.git");
  await $`git init --bare -b main ${origin}`.quiet();
  const clone = join(root, "clone");
  await $`git clone ${origin} ${clone}`.quiet().nothrow();
  await $`git -C ${clone} config user.email test@example.com`.quiet();
  await $`git -C ${clone} config user.name Test`.quiet();
  await $`git -C ${clone} checkout -B main`.quiet().nothrow();
  await Bun.write(join(clone, "seed.feature.md"), "# Seed\n");
  await $`git -C ${clone} add .`.quiet();
  await $`git -C ${clone} commit -m seed`.quiet();
  await $`git -C ${clone} push -u origin main`.quiet();
  return clone;
}

// specs/git-operations.spec.md: repos without a GitHub remote (the local
// starter setup, plain local dirs) have no scheme.
test("discovery finds no scheme without a GitHub origin", async () => {
  const clone = await seededClone();
  expect(await discoverScheme(clone)).toBeNull();
  expect(gitSchemeFor(clone)).toBeNull();

  const plain = join(root, "plain");
  await $`git init -b main ${plain}`.quiet();
  expect(await discoverScheme(plain)).toBeNull();
});

// specs/git-operations.spec.md: git commands run unchanged where no GitHub
// remote is involved — a chosen scheme must not break pull/commit/push
// against a local origin.
test("git operations work unchanged under a chosen scheme", async () => {
  const clone = await seededClone();
  for (const scheme of ["ssh", "gh"] as const) {
    setGitScheme(scheme);
    expect((await pull(clone)).ok).toBe(true);
    await Bun.write(join(clone, `note-${scheme}.feature.md`), "# Note\n");
    const res = await commitAndPush(clone, `note-${scheme}.feature.md`, `add ${scheme} note`);
    expect(res.pushed).toBe(true);
  }
});

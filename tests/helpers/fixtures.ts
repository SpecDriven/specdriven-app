// Shared git fixtures: a bare origin on a local path plus two clones a and b,
// so pushes and pulls exercise real git against a real remote. Setup and
// verification shell out to git directly.
//
// Speed is the reason this file looks the way it does. Building the layout
// costs ~13 sequential git commands (~300 ms), which a fixture used by 40-odd
// tests cannot afford, so the whole three-repo tree is built ONCE per test
// process and every fixture is a filesystem copy of it (~2 ms). An earlier
// version served the origin over loopback smart-HTTP, which cost a further
// ~400 ms per fixture and bought nothing: the app talks to a local path here
// either way, and all three engines support it.
//
// A copy inherits the template's *absolute* remote path, so each fixture
// repoints origin at its own copy. That rewrite is done as text, not via
// `git remote set-url`, to keep it off the subprocess path — and it has to be
// absolute: a relative `../origin.git` would survive the copy untouched, but
// the bundled (js) engine cannot resolve one.

import { $ } from "bun";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function git(dir: string, ...args: string[]) {
  const res = await $`git -C ${dir} ${args}`.quiet().nothrow();
  if (res.exitCode !== 0 && args[0] !== "pull") {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
  return res;
}

export interface TwoClones {
  a: string;
  b: string;
  originDir: string;
  /** The origin's location, as callers should hand it to clone(). */
  originUrl: string;
}

const DEFAULT_SEED = { "specs/seed.feature.md": "# Seed\n" };

/** Build the origin + both clones from scratch; the slow path, run once per seed. */
async function buildTemplate(seedFiles: Record<string, string>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "specdriven-tpl-"));
  const originDir = join(root, "origin.git");
  const a = join(root, "a");
  const b = join(root, "b");
  await $`git init --bare -b main ${originDir}`.quiet();
  await $`git clone ${originDir} ${a}`.quiet().nothrow();
  await git(a, "config", "user.email", "test@example.com");
  await git(a, "config", "user.name", "Test");
  // Pin the local branch name so `git push` maps onto origin/main
  // regardless of the machine's init.defaultBranch.
  await git(a, "checkout", "-B", "main");
  for (const [file, content] of Object.entries(seedFiles)) {
    await Bun.write(join(a, file), content); // creates parent folders
  }
  await git(a, "add", ".");
  await git(a, "commit", "-m", "seed");
  await git(a, "push", "origin", "HEAD:main");
  await git(a, "branch", "--set-upstream-to=origin/main");
  // Clone b only now, so it arrives with the seed already in place and needs
  // no pull of its own.
  await $`git clone ${originDir} ${b}`.quiet().nothrow();
  await git(b, "config", "user.email", "test@example.com");
  await git(b, "config", "user.name", "Test");
  await git(b, "branch", "--set-upstream-to=origin/main");
  return root;
}

// One template per distinct seed; the default seed is what nearly every
// caller wants, so it is built once and copied thereafter.
const templates = new Map<string, Promise<string>>();

function templateFor(seedFiles: Record<string, string>): Promise<string> {
  const key = JSON.stringify(Object.entries(seedFiles).sort());
  let template = templates.get(key);
  if (!template) {
    template = buildTemplate(seedFiles);
    templates.set(key, template);
  }
  return template;
}

/**
 * Point a clone's origin at this copy rather than the template it came from.
 * The template root is a unique mkdtemp path, so it appears in the config
 * only as the remote url and cannot collide with git's own keys or values.
 */
async function repointOrigin(cloneDir: string, from: string, to: string): Promise<void> {
  const config = join(cloneDir, ".git", "config");
  const text = await Bun.file(config).text();
  await Bun.write(config, text.replaceAll(from, to));
}

/**
 * A bare origin plus two clones a and b, both seeded and tracking origin/main,
 * as a copy of a template built once per process.
 */
export async function twoClones(
  root: string,
  seedFiles: Record<string, string> = DEFAULT_SEED,
): Promise<TwoClones> {
  const template = await templateFor(seedFiles);
  cpSync(template, root, { recursive: true });
  const a = join(root, "a");
  const b = join(root, "b");
  await Promise.all([repointOrigin(a, template, root), repointOrigin(b, template, root)]);
  const originDir = join(root, "origin.git");
  return { a, b, originDir, originUrl: originDir };
}

/**
 * A bare origin with one seeded commit and no working clone left behind —
 * for tests that only need something cloneable to point at. Copied from the
 * same template as twoClones, so it costs a copy rather than a build.
 *
 * `at` places it somewhere other than `<root>/origin.git`, for tests whose
 * url mapping depends on the path (e.g. `test/origin.git` standing in for
 * `github.com/test/origin`). A bare repo has no remote of its own, so unlike
 * twoClones the copy needs no rewriting.
 */
export async function seededOrigin(
  root: string,
  at = "origin.git",
  seedFiles: Record<string, string> = DEFAULT_SEED,
): Promise<string> {
  const template = await templateFor(seedFiles);
  const originDir = join(root, at);
  cpSync(join(template, "origin.git"), originDir, { recursive: true });
  return originDir;
}

/**
 * No-op, kept so the many afterEach hooks calling it need no change: the
 * fixtures no longer start a server. Safe to delete along with its callers.
 */
export function stopServers(): void {}

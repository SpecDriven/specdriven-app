// specs/app/hosted-app.feature.md "The gateway never writes inside a
// person's folder": what the gateway used to write there as root, the worker
// now sets up for itself as it starts (src/gateway/workerStart.ts) — the
// account as git's author, the remembered repos, and no symlink left in a
// clone from before hosted git stopped making them.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings } from "./helpers/settingsFile";
import { HOSTED_REPOS_ENV } from "../src/gateway/repos";
import { prepareHostedWorker, replaceSymlinks } from "../src/gateway/workerStart";

const SPECS = "https://github.com/acme/specs";
const OLDER = "https://github.com/acme/older";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sd-worker-start-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function folders(name: string) {
  const base = join(dir, name);
  const env = { HOME: join(base, "home"), SPECDRIVEN_ROOT: join(base, "root"), SPECDRIVEN_REPOS_DIR: join(base, "repos") };
  for (const path of Object.values(env)) await mkdir(path, { recursive: true });
  return env;
}

test("the worker names its account as git's author, in a file of its own", async () => {
  const env = await folders("author");
  await prepareHostedWorker({ ...env, SPECDRIVEN_ACCOUNT_EMAIL: "a@example.com" });
  const config = join(env.HOME, ".gitconfig");
  expect(await readFile(config, "utf8")).toBe("[user]\n\tname = a@example.com\n\temail = a@example.com\n");
  expect((await lstat(config)).mode & 0o777).toBe(0o600);
});

test("a link where the git author goes is replaced, and what it points at is untouched", async () => {
  const env = await folders("author-link");
  const elsewhere = join(dir, "elsewhere.txt");
  await writeFile(elsewhere, "someone else's");
  await symlink(elsewhere, join(env.HOME, ".gitconfig"));
  await prepareHostedWorker({ ...env, SPECDRIVEN_ACCOUNT_EMAIL: "a@example.com" });
  expect(await readFile(elsewhere, "utf8")).toBe("someone else's");
  expect((await lstat(join(env.HOME, ".gitconfig"))).isFile()).toBe(true);
});

test("the worker writes the remembered repos into a settings file that is missing, and keeps one that is there", async () => {
  const env = await folders("seed");
  await prepareHostedWorker({ ...env, [HOSTED_REPOS_ENV]: JSON.stringify([SPECS, "./local", OLDER]) });
  const file = join(env.SPECDRIVEN_ROOT, ".specdriven", "settings.yaml");
  const seeded = await readSettings(file);
  expect(seeded.dataRepo).toBe(SPECS);
  expect(seeded.recentFolders).toEqual([
    { path: SPECS, kind: "spec" },
    { path: OLDER, kind: "spec" },
  ]);

  await prepareHostedWorker({ ...env, [HOSTED_REPOS_ENV]: JSON.stringify([OLDER]) });
  expect((await readSettings(file)).dataRepo).toBe(SPECS);

  // No list, or one that is not a list, writes nothing.
  const none = await folders("seed-none");
  await prepareHostedWorker({ ...none, [HOSTED_REPOS_ENV]: "not json" });
  expect(await lstat(join(none.SPECDRIVEN_ROOT, ".specdriven")).catch(() => null)).toBeNull();
});

test("symlinks in the cloned repositories become plain files holding their target; .git is left alone", async () => {
  const env = await folders("links");
  const repo = join(env.SPECDRIVEN_REPOS_DIR, "specs");
  await mkdir(join(repo, "specs", "billing"), { recursive: true });
  await mkdir(join(repo, ".git"));
  await writeFile(join(repo, "README.md"), "hello\n");
  await symlink("../../.git", join(repo, "specs", "billing", "inside"));
  await symlink("/etc/passwd", join(repo, "specs", "leak.feature.md"));
  await symlink("nowhere", join(repo, ".git", "kept"));

  expect(await replaceSymlinks(env.SPECDRIVEN_REPOS_DIR)).toBe(2);
  for (const [path, target] of [
    [join(repo, "specs", "billing", "inside"), "../../.git"],
    [join(repo, "specs", "leak.feature.md"), "/etc/passwd"],
  ] as const) {
    expect((await lstat(path)).isFile()).toBe(true);
    expect(await readFile(path, "utf8")).toBe(target);
  }
  expect(await readlink(join(repo, ".git", "kept"))).toBe("nowhere");
  expect(await readFile(join(repo, "README.md"), "utf8")).toBe("hello\n");
  // Nothing left to replace the second time; a folder that is not there is no error.
  expect(await replaceSymlinks(env.SPECDRIVEN_REPOS_DIR)).toBe(0);
  expect(await replaceSymlinks(join(dir, "missing"))).toBe(0);
});

// Automates specs/app/data-format.feature.md against real git: a teammate on
// a newer app raises the folder's data format, and this app's sync tick,
// API and app start all stop short of touching it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version as appVersion } from "../package.json";
import { applyStartupState, handleApi, reloader, syncedOnStart } from "../src/server/api";
import {
  DATA_FORMAT,
  DATA_FORMAT_FILE,
  DATA_TOO_NEW_HEADER,
  checkDataFormat,
  incompatibility,
  readDataFormat,
  resetDataFormatFlags,
} from "../src/server/dataFormat";
import { setGitEngine } from "../src/server/git";
import { syncDataDir } from "../src/server/reload";
import { writeState } from "../src/server/state";
import { git, twoClones, type TwoClones } from "./helpers/fixtures";

let root: string;
let home: string;
let repos: TwoClones;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-format-guard-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-format-guard-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  setGitEngine("cli");
  repos = await twoClones(join(root, "repos"));
});

afterEach(async () => {
  await syncedOnStart();
  reloader.stop();
  resetDataFormatFlags();
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Clone b, on a newer app, raises the format and pushes it. */
async function teammateRaisesFormat(): Promise<string> {
  await Bun.write(
    join(repos.b, DATA_FORMAT_FILE),
    JSON.stringify({ format: DATA_FORMAT + 1, minAppVersion: "9.9.9" }),
  );
  await git(repos.b, "add", "-A");
  await git(repos.b, "commit", "-m", "raise the data format");
  await git(repos.b, "push", "origin", "HEAD:main");
  return originHead();
}

async function originHead(): Promise<string> {
  return (await git(repos.originDir, "rev-parse", "main")).stdout.toString().trim();
}

const LOCAL_EDIT = "specs/local.feature.md";

async function localHead(): Promise<string> {
  return (await git(repos.a, "rev-parse", "HEAD")).stdout.toString().trim();
}

test("a blocked app does not push", async () => {
  const raised = await teammateRaisesFormat();
  // Clone a holds a local edit its next tick would otherwise import into a
  // document, commit and push.
  await Bun.write(join(repos.a, LOCAL_EDIT), "# Local\n");

  const message = await syncDataDir(repos.a);

  expect(message).toContain("skipped sync");
  // The pull still landed — that is how the tick found out.
  expect((await readDataFormat(repos.a))?.format).toBe(DATA_FORMAT + 1);
  expect(await localHead()).toBe(raised);
  // Nothing was committed or pushed, and the edit is the only thing on disk
  // that git does not know: an unblocked tick would also have written the
  // features' documents, the format marker and AGENTS.md (see the test
  // below), and none of those appeared.
  expect(await originHead()).toBe(raised);
  const status = (await git(repos.a, "status", "--porcelain")).stdout.toString();
  expect(status).toBe(`?? ${LOCAL_EDIT}\n`);
});

test("later ticks keep pulling, so a rolled-back folder syncs again", async () => {
  await teammateRaisesFormat();
  await Bun.write(join(repos.a, LOCAL_EDIT), "# Local\n");
  expect(await syncDataDir(repos.a)).toContain("skipped sync");
  expect(incompatibility(repos.a)).not.toBeNull();

  // The teammate takes the raise back — a revert, as a team would do once
  // it found a colleague stuck on the update screen — and pushes.
  await git(repos.b, "revert", "--no-edit", "HEAD");
  await git(repos.b, "push", "origin", "HEAD:main");
  const reverted = await originHead();

  const message = await syncDataDir(repos.a);

  expect(message).not.toContain("skipped sync");
  expect(incompatibility(repos.a)).toBeNull();
  // The tick ran through: the edit it had left alone is committed and
  // pushed, so origin moved past the revert.
  expect(await originHead()).not.toBe(reverted);
  const status = (await git(repos.a, "status", "--porcelain")).stdout.toString();
  expect(status).toBe("");
  const pushed = (await git(repos.originDir, "ls-tree", "--name-only", "main", "specs/")).stdout.toString();
  expect(pushed).toContain(LOCAL_EDIT);
});

test("a compatible tick raises a first-format folder to this app's", async () => {
  const message = await syncDataDir(repos.a);
  expect(message).toContain("wrote the data format marker");
  const marker = { format: DATA_FORMAT, minAppVersion: appVersion };
  expect(await readDataFormat(repos.a)).toEqual(marker);
  // The tick pushed it, so the teammate pulls the marker with the rest.
  await git(repos.b, "pull");
  expect(await readDataFormat(repos.b)).toEqual(marker);
  // A second tick finds the folder in this format and leaves it alone.
  expect(await syncDataDir(repos.a)).not.toContain("data format marker");
});

test("the API refuses writes to a blocked folder and marks its reads", async () => {
  await writeState({ dataRepo: repos.a, reloadFrequencySeconds: 0 }, root);
  await teammateRaisesFormat();
  await git(repos.a, "pull");
  await checkDataFormat(repos.a);

  const put = await handleApi(
    new Request("http://localhost/api/readme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Overwritten\n" }),
    }),
  );
  expect(put!.status).toBe(409);
  expect(put!.headers.get(DATA_TOO_NEW_HEADER)).toBe("9.9.9");
  expect(await put!.json()).toMatchObject({ status: "app-outdated", minAppVersion: "9.9.9" });

  const read = await handleApi(new Request("http://localhost/api/features"));
  expect(read!.status).toBe(200);
  expect(read!.headers.get(DATA_TOO_NEW_HEADER)).toBe("9.9.9");

  // /api/state still answers, says so in its body, and carries no header —
  // a folder switch must not read as the old folder's verdict.
  const state = await handleApi(new Request("http://localhost/api/state"));
  expect(state!.headers.get(DATA_TOO_NEW_HEADER)).toBeNull();
  expect(((await state!.json()) as { dataFormat: unknown }).dataFormat).toEqual({
    ok: false,
    minAppVersion: "9.9.9",
    reason: expect.stringContaining("9.9.9"),
  });
});

test("switching folders, Sync, sign-in, the log and the data viewer still work", async () => {
  await writeState({ dataRepo: repos.a, reloadFrequencySeconds: 0 }, root);
  await teammateRaisesFormat();
  await git(repos.a, "pull");
  await checkDataFormat(repos.a);

  // None of these writes to the data repo, so none is refused and none
  // carries the header — the client must not mistake them for the verdict.
  const allowed = [
    new Request("http://localhost/api/reload", { method: "POST" }),
    new Request("http://localhost/api/logs"),
    new Request("http://localhost/api/data/tables"),
    new Request("http://localhost/api/auth/github/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
    new Request("http://localhost/api/choose-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  ];
  for (const req of allowed) {
    const res = await handleApi(req);
    expect(res!.status, req.url).not.toBe(409);
    expect(res!.headers.get(DATA_TOO_NEW_HEADER), req.url).toBeNull();
  }
  // Sync is the tick itself, which stops after its pull as usual.
  const sync = await handleApi(new Request("http://localhost/api/reload", { method: "POST" }));
  expect(((await sync!.json()) as { message: string }).message).toContain("skipped sync");
});

test("data saved by a newer app blocks this one at start", async () => {
  await teammateRaisesFormat();
  await writeState({ dataRepo: repos.a, reloadFrequencySeconds: 0 }, root);

  await applyStartupState();
  await syncedOnStart();

  const res = await handleApi(new Request("http://localhost/api/state"));
  const state = (await res!.json()) as { dataFormat: { ok: boolean; minAppVersion?: string } };
  expect(state.dataFormat).toMatchObject({ ok: false, minAppVersion: "9.9.9" });
});

test("a folder in this format opens as usual", async () => {
  await writeState({ dataRepo: repos.a, reloadFrequencySeconds: 0 }, root);
  await applyStartupState();
  await syncedOnStart();

  const res = await handleApi(new Request("http://localhost/api/state"));
  expect(((await res!.json()) as { dataFormat: unknown }).dataFormat).toEqual({ ok: true });
});

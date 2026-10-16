// Automates specs/app/data-format.feature.md against real git: a teammate on
// a newer app raises the folder's data format, and this app's sync tick,
// API and app start all stop short of touching it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStartupState, handleApi, reloader, syncedOnStart } from "../src/server/api";
import {
  DATA_FORMAT,
  DATA_FORMAT_FILE,
  DATA_TOO_NEW_HEADER,
  checkDataFormat,
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

test("a blocked app does not push", async () => {
  const raised = await teammateRaisesFormat();
  // Clone a holds a local edit its next tick would otherwise commit and push.
  await Bun.write(join(repos.a, "specs/local.feature.md"), "# Local\n");

  const message = await syncDataDir(repos.a);

  expect(message).toContain("skipped sync");
  expect(await originHead()).toBe(raised);
  // The pull still landed — that is how the tick found out — and the edit
  // is left as it was, uncommitted.
  expect((await readDataFormat(repos.a))?.format).toBe(DATA_FORMAT + 1);
  const status = (await git(repos.a, "status", "--porcelain")).stdout.toString();
  expect(status).toContain("specs/local.feature.md");
});

test("a compatible tick leaves a first-format folder as it was", async () => {
  const message = await syncDataDir(repos.a);
  expect(message).not.toContain("data format marker");
  expect(await readDataFormat(repos.a)).toBeNull();
  // Whatever else the tick pushed, the teammate pulls no marker.
  await git(repos.b, "pull");
  expect(await readDataFormat(repos.b)).toBeNull();
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

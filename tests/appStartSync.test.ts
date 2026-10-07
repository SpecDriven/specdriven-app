// Automates specs/app-start.spec.md "the data repo is pulled on start": the
// app opens on the latest data, and so does a data folder just picked in the
// UI — in both cases without the user pressing Sync.
//
// What is under test is the order — pull, then read — not git, so the data
// repo is a folder git is faked for (helpers/fakeGit.ts): its pull delivers
// a teammate's feature, which only a pull that ran in time can show.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStartupState, handleApi, reloader, syncedOnStart } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import { writeState } from "../src/server/state";
import { installFakeGit, type FakeGit } from "./helpers/fakeGit";

let root: string;
let home: string;
let fakeGit: FakeGit | null = null;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-start-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-start-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  setGitEngine("cli");
});

afterEach(async () => {
  // applyStartupState() fires the app-start sync without awaiting it. Let it
  // finish before teardown, or it runs on into the next test file — and into
  // whatever that file records (tests/telemetry.test.ts saw its git span).
  await syncedOnStart();
  reloader.stop();
  fakeGit?.restore();
  fakeGit = null;
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

/**
 * A clone (as far as the app can tell: it has a .git) whose next pull brings
 * in `file`, as if a teammate had pushed it. Pulls are recorded in order.
 */
async function cloneWithIncoming(file: string, content: string): Promise<string> {
  const dir = join(root, "data");
  await Bun.write(join(dir, "specs/seed.feature.md"), "# Seed\n");
  await mkdir(join(dir, ".git"));
  fakeGit = installFakeGit({
    async pull(repoDir) {
      // A pull takes a moment, as a real one does, so a read that did not
      // wait for it runs first and misses the file. A read that waits never
      // sees this delay as anything but a slower pull, so it cannot flake.
      await Bun.sleep(100);
      await Bun.write(join(repoDir, file), content);
      return { ok: true, conflictedFiles: [], message: `Fast-forward: ${file}` };
    },
  });
  return dir;
}

async function listFeatureFiles(): Promise<string[]> {
  const res = await handleApi(new Request("http://localhost/api/features"));
  expect(res!.status).toBe(200);
  const data = (await res!.json()) as { features: { fileName: string }[] };
  return data.features.map((f) => f.fileName);
}

test("the data repo is pulled on app start, before the first read", async () => {
  const data = await cloneWithIncoming("specs/quote.feature.md", "# Quote Policy\n");
  // The cron reload is off, so only the app-start pull can bring this in.
  await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);

  await applyStartupState();

  expect(await listFeatureFiles()).toContain("specs/quote.feature.md");
});

test("picking a data folder pulls it before the client reads it", async () => {
  await writeState({ reloadFrequencySeconds: 0 }, root);
  await applyStartupState();
  const data = await cloneWithIncoming("specs/claim.feature.md", "# Claim\n");

  const res = await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataRepo: data }),
    }),
  );
  expect(res!.status).toBe(200);

  // Pulled by the time the switch is confirmed — the client reads next.
  expect(await Bun.file(join(data, "specs/claim.feature.md")).exists()).toBe(true);
  expect(await listFeatureFiles()).toContain("specs/claim.feature.md");
});

test("a data folder that is not a git repo is still selectable", async () => {
  const data = join(root, "plain");
  await Bun.write(join(data, "specs/note.feature.md"), "# Note\n");
  await applyStartupState();

  const res = await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataRepo: data }),
    }),
  );
  expect(res!.status).toBe(200);
  expect(await listFeatureFiles()).toContain("specs/note.feature.md");
});

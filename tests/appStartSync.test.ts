// Automates specs/app-start.spec.md "the data repo is pulled on start": the
// app opens on the latest data, and so does a data folder just picked in the
// UI — in both cases without the user pressing Sync.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStartupState, handleApi, reloader, syncedOnStart } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import { writeState } from "../src/server/state";
import { git, stopServers, twoClones } from "./helpers/fixtures";

let root: string;
let home: string;
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
  stopServers();
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

/** Commit a new feature to clone `a` and push it to the shared origin. */
async function pushFeature(a: string, file: string, content: string) {
  await Bun.write(join(a, file), content);
  await git(a, "add", ".");
  await git(a, "commit", "-m", `add ${file}`);
  await git(a, "push", "origin", "HEAD:main");
}

async function listFeatureFiles(): Promise<string[]> {
  const res = await handleApi(new Request("http://localhost/api/features"));
  expect(res!.status).toBe(200);
  const data = (await res!.json()) as { features: { fileName: string }[] };
  return data.features.map((f) => f.fileName);
}

test("the data repo is pulled on app start, before the first read", async () => {
  const { a, b } = await twoClones(root);
  // The cron reload is off, so only the app-start pull can bring this in.
  await writeState({ dataRepo: b, reloadFrequencySeconds: 0 }, root);
  await pushFeature(a, "specs/quote.feature.md", "# Quote Policy\n");

  await applyStartupState();

  expect(await listFeatureFiles()).toContain("specs/quote.feature.md");
});

test("picking a data folder pulls it before the client reads it", async () => {
  const { a, b } = await twoClones(root);
  await writeState({ reloadFrequencySeconds: 0 }, root);
  await applyStartupState();
  await pushFeature(a, "specs/claim.feature.md", "# Claim\n");

  const res = await handleApi(
    new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataRepo: b }),
    }),
  );
  expect(res!.status).toBe(200);

  // Pulled by the time the switch is confirmed — the client reads next.
  expect(await Bun.file(join(b, "specs/claim.feature.md")).exists()).toBe(true);
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

// Automates git-operations.md "a push that fails is shown, and tried again".
//
// A tick commits what the editors saved and then pushes. When the push could
// not go through — signed out, offline — the commit stayed on this computer
// and two things went wrong: nothing on the page said so (the tick's result
// only reached the log), and no later tick tried again, because a committed
// edit leaves a clean working tree and a clean tree was "no saved changes".
// The commits waited for the next edit to carry them, however long that took.
//
// The remote is taken away and put back by renaming the bare origin — a push
// failure every engine reports, with no credentials involved.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { handleApi } from "../src/server/api";
import { setGitEngine } from "../src/server/git";
import { reloadData } from "../src/server/reload";
import { writeState } from "../src/server/state";
import { installFakeGh } from "./helpers/binPath";
import type { FakeGh } from "./helpers/binPath";
import { gitEngines } from "./helpers/engines";
import { twoClones } from "./helpers/fixtures";

let root: string;
let home: string;
let fakeGh: FakeGh | null = null;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-pushfail-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-pushfail-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  fakeGh?.restore();
  fakeGh = null;
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

/** What the page is told with the feature listing: why pushes fail, or null. */
async function reportedSyncProblem(): Promise<string | null> {
  const res = await handleApi(new Request("http://localhost/api/features"));
  expect(res!.status).toBe(200);
  return ((await res!.json()) as { syncProblem: string | null }).syncProblem;
}

/** The subjects of every commit the origin holds, newest first. */
async function originSubjects(originDir: string): Promise<string[]> {
  const log = await $`git -C ${originDir} log --format=%s main`.quiet();
  return log.stdout.toString().trim().split("\n");
}

for (const engine of gitEngines()) {
  describe(`git engine: ${engine}`, () => {
    beforeEach(() => {
      if (engine === "gh") fakeGh = installFakeGh();
      setGitEngine(engine);
    });

    test("a tick whose push fails keeps the commit and tells the page why", async () => {
      const { a: data, originDir } = await twoClones(root);
      await writeState({ dataRepo: "a" }, root);
      // One tick with the remote in reach, so what follows is not the data
      // folder's first-tick housekeeping.
      await reloadData(root);
      expect(await reportedSyncProblem()).toBeNull();

      await rename(originDir, `${originDir}.away`);
      await Bun.write(join(data, "roadmap/import.md"), "# Import\n\nfrom existing documents\n");
      const message = await reloadData(root);

      expect(message).toContain("saved scenarios committed; push failed: ");
      // Committed here: the edit is safe on this computer, just not pushed.
      const status = await $`git -C ${data} status --porcelain`.quiet();
      expect(status.stdout.toString().trim()).toBe("");
      const problem = await reportedSyncProblem();
      expect(problem).toBeString();
      expect(message).toContain(`push failed: ${problem}`);
    });

    test("commits a failed push left behind go up on the next tick that can push, with nothing new to save", async () => {
      const { a: data, originDir } = await twoClones(root);
      await writeState({ dataRepo: "a" }, root);
      await reloadData(root);

      await rename(originDir, `${originDir}.away`);
      await Bun.write(join(data, "roadmap/import.md"), "# Import\n\nfrom existing documents\n");
      await reloadData(root);
      // Still out of reach, and now the working tree is clean: the tick
      // tries the waiting commit again rather than calling it a day.
      const retried = await reloadData(root);
      expect(retried).toContain("earlier saved changes not pushed yet; push failed: ");
      expect(await reportedSyncProblem()).toBeString();

      await rename(`${originDir}.away`, originDir);
      const recovered = await reloadData(root);

      expect(recovered).toContain("earlier saved changes pushed");
      expect((await originSubjects(originDir))[0]).toBe("Add roadmap page: Import");
      expect(await reportedSyncProblem()).toBeNull();
      // Nothing is waiting any more, so nothing more is pushed.
      expect(await reloadData(root)).toContain("no saved changes");
    });
  });
}

// specs: git operations, "git operations on one folder run one at a time":
// saves that commit at the same moment on one folder all reach the remote,
// instead of racing each other for the index; folders do not wait on each
// other.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Deferred, Effect, Fiber } from "effect";
import { commitAndPush, setGitEngine } from "../../src/server/git";
import { RepoLocks } from "../../src/server/sync/RepoLocks";
import { twoClones } from "../helpers/fixtures";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-repolock-"));
  setGitEngine("cli");
});

afterEach(async () => {
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
});

test("saves committing at once on one folder all reach the remote", async () => {
  const { a, originDir } = await twoClones(root);
  const names = ["one", "two", "three", "four", "five", "six"];
  for (const name of names) await Bun.write(join(a, "specs", `${name}.feature.md`), `# ${name}\n`);

  const results = await Promise.all(
    names.map((name) => commitAndPush(a, `specs/${name}.feature.md`, `Add ${name}`)),
  );

  expect(results.map((r) => r.pushed)).toEqual(names.map(() => true));
  const status = await $`git -C ${a} status --porcelain`.quiet();
  expect(status.stdout.toString().trim()).toBe("");
  const subjects = (await $`git -C ${originDir} log --format=%s`.quiet()).stdout.toString();
  for (const name of names) expect(subjects).toContain(`Add ${name}`);
});

test("a folder's lock does not hold up another folder", async () => {
  const program = Effect.gen(function* () {
    const locks = yield* RepoLocks;
    const release = yield* Deferred.make<void>();
    // Folder a stays locked until the end of the test…
    const holder = yield* Effect.forkChild(locks.withRepo(join(root, "a"), Deferred.await(release)));
    yield* Effect.yieldNow;
    // …while folder b's operation runs straight through.
    const other = yield* locks.withRepo(join(root, "b"), Effect.succeed("b ran"));
    // The same folder, named another way, waits for the holder.
    const same = yield* Effect.forkChild(locks.withRepo(join(root, "x", "..", "a"), Effect.succeed("a ran")));
    yield* Effect.yieldNow;
    const waitedBefore = same.pollUnsafe() === undefined;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.await(holder);
    const after = yield* Fiber.await(same);
    return { other, waitedBefore, after };
  });
  const { other, waitedBefore, after } = await Effect.runPromise(Effect.provide(program, RepoLocks.layer));
  expect(other).toBe("b ran");
  expect(waitedBefore).toBe(true);
  expect(after._tag).toBe("Success");
});

test("ticks on one folder take turns; a save is not held up by a tick", async () => {
  const program = Effect.gen(function* () {
    const locks = yield* RepoLocks;
    const order: string[] = [];
    const release = yield* Deferred.make<void>();
    const dir = join(root, "a");
    const first = yield* Effect.forkChild(
      locks.withTick(dir, Effect.andThen(Effect.sync(() => order.push("tick 1 start")), Deferred.await(release))),
    );
    yield* Effect.yieldNow;
    const second = yield* Effect.forkChild(locks.withTick(dir, Effect.sync(() => order.push("tick 2"))));
    yield* Effect.yieldNow;
    // A save's git operation takes the repo lock, not the tick lock.
    yield* locks.withRepo(dir, Effect.sync(() => order.push("save")));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.await(first);
    yield* Fiber.await(second);
    return order;
  });
  const order = await Effect.runPromise(Effect.provide(program, RepoLocks.layer));
  expect(order).toEqual(["tick 1 start", "save", "tick 2"]);
});

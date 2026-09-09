// The page editor's save queue (src/frontend/App.tsx): autosave and the
// Done / Assigned PUTs must not last-write-wins each other, and a listing
// tick must notice when only the Done marker moved.

import { describe, expect, test } from "bun:test";
import { createPromiseQueue, pageListingMetaEqual } from "../src/frontend/App";
import type { PageListing } from "../src/server/pages";

const listing = (over: Partial<PageListing> = {}): PageListing => ({
  fileName: "tasks/ship.md",
  name: "Ship v2",
  ...over,
});

describe("pageListingMetaEqual", () => {
  test("agrees when only whitespace-equivalent fields match", () => {
    expect(pageListingMetaEqual(listing(), listing())).toBe(true);
    expect(pageListingMetaEqual(listing({ assigned: "Ada" }), listing({ assigned: "Ada" }))).toBe(
      true,
    );
    expect(pageListingMetaEqual(listing({ done: true }), listing({ done: true }))).toBe(true);
  });

  test("treats a missing Done marker as not done", () => {
    expect(pageListingMetaEqual(listing(), listing({ done: false }))).toBe(true);
    expect(pageListingMetaEqual(listing({ done: true }), listing())).toBe(false);
  });

  test("notices a heading or assignment change", () => {
    expect(pageListingMetaEqual(listing(), listing({ name: "Ship v3" }))).toBe(false);
    expect(pageListingMetaEqual(listing({ assigned: "Ada" }), listing())).toBe(false);
  });
});

describe("createPromiseQueue", () => {
  test("runs jobs in the order they were queued, never overlapping", async () => {
    const q = createPromiseQueue();
    const log: string[] = [];
    const hold = Promise.withResolvers<void>();
    const first = q.run(async () => {
      log.push("first-start");
      await hold.promise;
      log.push("first-end");
      return 1;
    });
    await Promise.resolve();
    expect(log).toEqual(["first-start"]);
    const second = q.run(async () => {
      log.push("second");
      return 2;
    });
    hold.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(log).toEqual(["first-start", "first-end", "second"]);
  });

  test("a failed job does not stall the jobs behind it", async () => {
    const q = createPromiseQueue();
    const failed = q.run(async () => {
      throw new Error("nope");
    });
    const next = q.run(async () => "ok");
    await expect(failed).rejects.toThrow("nope");
    expect(await next).toBe("ok");
  });

  test("a later meta-save makes an earlier snapshot skip rather than overwrite", async () => {
    // The Done-vs-autosave race: autosave queued a snapshot, then Done
    // queued a write with the marker. When the snapshot job starts it
    // sees the marker write in flight and skips, so the marker lands last.
    const q = createPromiseQueue();
    let metaSaving = 0;
    const disk: string[] = [];
    const hold = Promise.withResolvers<void>();

    const blocker = q.run(() => hold.promise);
    const autosave = q.run(async () => {
      if (metaSaving > 0) return;
      disk.push("stale-autosave");
    });
    metaSaving += 1;
    const done = q.run(async () => {
      disk.push("done");
      metaSaving -= 1;
    });

    hold.resolve();
    await Promise.all([blocker, autosave, done, q.idle()]);
    expect(disk).toEqual(["done"]);
  });
});

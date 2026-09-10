// The Event Model canvas's save queue (src/frontend/eventModel/ModelsPane.tsx):
// overlapping PUTs last-write-wins through reconcileModel, and an unmount
// flush after a data-repo switch would write the old model into the new
// folder. Jobs serialize; each job snapshots the file when it runs.

import { describe, expect, test } from "bun:test";
import { createPromiseQueue } from "../src/frontend/promiseQueue";

describe("createPromiseQueue", () => {
  test("a later model save waits for the earlier PUT and sends the latest file", async () => {
    const q = createPromiseQueue();
    let current = "A";
    const disk: string[] = [];
    const hold = Promise.withResolvers<void>();

    const first = q.run(async () => {
      const sent = current;
      await hold.promise;
      disk.push(sent);
    });
    await Promise.resolve();
    current = "B";
    const second = q.run(async () => {
      disk.push(current);
    });
    hold.resolve();
    await first;
    await second;
    expect(disk).toEqual(["A", "B"]);
  });

  test("flush waits until a save that started after it was called has landed", async () => {
    const q = createPromiseQueue();
    let current = "A";
    let disk = "";
    const hold = Promise.withResolvers<void>();

    void q.run(async () => {
      const sent = current;
      await hold.promise;
      disk = sent;
    });
    await Promise.resolve();
    current = "B";
    const flush = (async () => {
      await q.run(async () => {
        disk = current;
      });
      await q.idle();
    })();
    hold.resolve();
    await flush;
    expect(disk).toBe("B");
  });

  test("without a queue, a stale PUT can land after a later one", async () => {
    // The bug the queue prevents: two overlapping writes, the earlier
    // snapshot finishing last and wiping the later edit.
    const disk: string[] = [];
    const firstHold = Promise.withResolvers<void>();
    const secondHold = Promise.withResolvers<void>();

    const first = (async () => {
      await firstHold.promise;
      disk.push("A");
    })();
    const second = (async () => {
      await secondHold.promise;
      disk.push("B");
    })();
    secondHold.resolve();
    await second;
    firstHold.resolve();
    await first;
    expect(disk).toEqual(["B", "A"]);
  });
});

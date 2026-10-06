// Scenario Delete and Move to… used to fire while a scenario or description
// PUT was still away. Those PUTs send a full feature snapshot, so a late one
// writes a deleted scenario back — or, after Move to… has taken it out of
// the source, a stale destination snapshot drops it from both files.
//
// The client now drains `scenarioSaveQueue` and `descSaveQueue` first, the
// way feature delete already does (`removeFeature`). These tests lock in
// why that wait is required, and that waiting for only `autosaveInFlight`
// (captured while the editor was still open) is not enough once `<` / ESC
// has already closed it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPromiseQueue } from "../src/frontend/promiseQueue";
import {
  createFeature,
  deleteDraftScenario,
  moveScenario,
  readFeature,
  readFeatureView,
  saveFeature,
} from "../src/server/features";

let root: string;
const QUOTE = "specs/quote.feature.md";
const ORDER = "specs/order.feature.md";

const BOTH = "# Quote\n\n## Keep @v1\n\na\n\n## Gone @v1\n\nb\n";
const KEEP_ONLY = "# Quote\n\n## Keep @v1\n\na\n";
const WITH_DRAFT = "# Quote\n\n## Keep @v1\n\na\n\n## Idea @v1 [draft]\n\nwip\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-scenario-behind-tick-"));
  await createFeature(root, "Quote");
  await createFeature(root, "Order");
  await saveFeature(root, QUOTE, BOTH);
  await saveFeature(root, ORDER, "# Order\n\n## Checkout @v1\n\npay\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const names = async (file: string) =>
  (await readFeatureView(root, file))!.parsed.scenarios.map((s) => `${s.name} v${s.version}`);

describe("a stale full-feature PUT after Delete", () => {
  test("writes a removed proposed scenario back", async () => {
    await saveFeature(root, QUOTE, KEEP_ONLY);
    expect(await names(QUOTE)).toEqual(["Keep v1"]);
    await saveFeature(root, QUOTE, BOTH);
    expect(await names(QUOTE)).toEqual(["Gone v1", "Keep v1"]);
    expect(await readFeature(root, QUOTE)).toContain("## Gone @v1");
  });

  test("writes a deleted draft back when the snapshot still carries it", async () => {
    await saveFeature(root, QUOTE, WITH_DRAFT);
    expect(await names(QUOTE)).toEqual(["Idea v1", "Keep v1"]);
    await deleteDraftScenario(root, QUOTE, { name: "Idea", version: 1 });
    expect(await names(QUOTE)).toEqual(["Keep v1"]);
    await saveFeature(root, QUOTE, WITH_DRAFT);
    expect(await names(QUOTE)).toEqual(["Idea v1", "Keep v1"]);
  });
});

describe("a stale destination PUT after Move to…", () => {
  test("drops the scenario from both features", async () => {
    const destBefore = (await readFeature(root, ORDER))!;
    await moveScenario(root, QUOTE, { name: "Gone", version: 1 }, ORDER);
    expect(await names(QUOTE)).toEqual(["Keep v1"]);
    expect(await names(ORDER)).toEqual(["Checkout v1", "Gone v1"]);
    // The editor on the destination was closed with a parting save still
    // away: that snapshot does not include the scenario that just arrived.
    await saveFeature(root, ORDER, destBefore);
    expect(await names(ORDER)).toEqual(["Checkout v1"]);
    expect(await names(QUOTE)).toEqual(["Keep v1"]);
  });
});

/**
 * The client half: scenario PUTs share `scenarioSaveQueue`. Delete / Move
 * used to fetch immediately (or wait only for `autosaveInFlight` when the
 * pane was still open). `drain` is what App does now: `queue.idle()` before
 * the destructive request.
 */
async function withInFlightSave(opts: {
  drain: boolean;
  editing: boolean;
  save: () => Promise<void>;
  action: () => Promise<void>;
}): Promise<void> {
  const queue = createPromiseQueue();
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const inFlight = queue.run(async () => {
    await blocked;
    await opts.save();
  });
  if (opts.drain) {
    release();
    await queue.idle();
    await opts.action();
  } else if (opts.editing) {
    // Old tree path: await closeEditor() / await ahead, then delete.
    release();
    await inFlight;
    await opts.action();
  } else {
    // Old path after `<` / ESC: editing is already null, delete races.
    await opts.action();
    release();
    await inFlight;
  }
}

describe("draining the save queue before Delete", () => {
  test("without a wait, a closed editor's late PUT restores the scenario", async () => {
    await withInFlightSave({
      drain: false,
      editing: false,
      save: () => saveFeature(root, QUOTE, BOTH).then(() => undefined),
      action: () => saveFeature(root, QUOTE, KEEP_ONLY).then(() => undefined),
    });
    expect(await names(QUOTE)).toEqual(["Gone v1", "Keep v1"]);
  });

  test("idle() before Delete keeps the scenario gone", async () => {
    await withInFlightSave({
      drain: true,
      editing: false,
      save: () => saveFeature(root, QUOTE, BOTH).then(() => undefined),
      action: () => saveFeature(root, QUOTE, KEEP_ONLY).then(() => undefined),
    });
    expect(await names(QUOTE)).toEqual(["Keep v1"]);
  });
});

describe("draining the save queue before Move to…", () => {
  test("without a wait, a late destination PUT loses the scenario", async () => {
    const destBefore = (await readFeature(root, ORDER))!;
    await withInFlightSave({
      drain: false,
      editing: false,
      save: () => saveFeature(root, ORDER, destBefore).then(() => undefined),
      action: () =>
        moveScenario(root, QUOTE, { name: "Gone", version: 1 }, ORDER).then(() => undefined),
    });
    expect(await names(QUOTE)).toEqual(["Keep v1"]);
    expect(await names(ORDER)).toEqual(["Checkout v1"]);
  });

  test("idle() before Move to… keeps the scenario on the destination", async () => {
    const destBefore = (await readFeature(root, ORDER))!;
    await withInFlightSave({
      drain: true,
      editing: false,
      save: () => saveFeature(root, ORDER, destBefore).then(() => undefined),
      action: () =>
        moveScenario(root, QUOTE, { name: "Gone", version: 1 }, ORDER).then(() => undefined),
    });
    expect(await names(QUOTE)).toEqual(["Keep v1"]);
    expect(await names(ORDER)).toEqual(["Checkout v1", "Gone v1"]);
  });
});

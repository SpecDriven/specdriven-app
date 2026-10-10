// The dialog's Publish used to PUT from the render — `withScenario(feature,
// editing.index, draft)` — while an autosave tick was still away. Propose
// already waited for that tick and placed where it landed
// (tests/scenarioSaveBehindTick.test.ts). Publish now uses the same queue
// and `placeScenario`, so a new scenario is published once, under the id
// the tick gave it, and a rename does not overwrite its neighbour.
import { describe, expect, test } from "bun:test";
import { placeScenario, type Placement } from "../src/frontend/App";
import { createPromiseQueue } from "../src/frontend/promiseQueue";
import type { Feature, Scenario } from "../src/server/parser";

const sc = (name: string, version: number, extra: Partial<Scenario> = {}): Scenario => ({
  name,
  version,
  status: "proposed",
  body: "",
  tests: [],
  ...extra,
});

const names = (f: Feature) => f.scenarios.map((s) => `${s.name} v${s.version}`);

/**
 * The dialog Publish path in App.tsx: capture `ahead`, queue the work, wait
 * for the tick, place, then PUT without `save: true`.
 */
async function publishBehind(
  draft: Scenario,
  known: Placement,
  derived: boolean,
  ahead: Promise<Placement> | null,
  queue: ReturnType<typeof createPromiseQueue>,
  put: (next: Feature) => void,
): Promise<Feature> {
  return queue.run(async () => {
    const base = ahead ? await ahead : known;
    const { next } = placeScenario(draft, base, derived);
    put(next);
    return next;
  });
}

describe("a new scenario published behind a tick still away", () => {
  const before: Feature = { name: "Quote", description: "", scenarios: [sc("Alpha", 1, { id: "a" })] };
  const typed = sc("Beta", 1, { body: "Given more" });
  const saved: Feature = {
    ...before,
    scenarios: [sc("Alpha", 1, { id: "a" }), sc("Beta", 1, { id: "b" })],
  };

  test("placed from the render, Publish sends a second Beta and publishes that — the bug", () => {
    const optimistic = placeScenario(sc("Beta", 1), { feature: before, index: null }, true).next;
    const { next, s } = placeScenario(typed, { feature: optimistic, index: null }, true);
    expect(names(next)).toEqual(["Alpha v1", "Beta v1", "Beta v2"]);
    expect(s.id).toBeUndefined();
  });

  test("queued after the tick, it publishes the one scenario the tick placed", async () => {
    const queue = createPromiseQueue();
    const puts: Feature[] = [];
    // The tick is already on the queue, the way saveScenario queues first.
    const ahead = queue.run(async (): Promise<Placement> => {
      puts.push(saved);
      return { feature: saved, index: 1, id: "b" };
    });
    const next = await publishBehind(
      typed,
      { feature: before, index: null },
      true,
      ahead,
      queue,
      (placed) => puts.push(placed),
    );
    expect(names(next)).toEqual(["Alpha v1", "Beta v1"]);
    expect(next.scenarios[1]!.id).toBe("b");
    expect(next.scenarios[1]!.body).toBe("Given more");
    expect(puts).toHaveLength(2);
    expect(names(puts[0]!)).toEqual(["Alpha v1", "Beta v1"]);
    expect(names(puts[1]!)).toEqual(["Alpha v1", "Beta v1"]);
  });
});

describe("a renamed scenario published behind a tick still away", () => {
  const before: Feature = {
    name: "Quote",
    description: "",
    scenarios: [sc("Alpha", 1, { id: "a" }), sc("Gamma", 1, { id: "g" }), sc("Gamma", 2, { id: "g2" })],
  };
  const renamed = sc("Hotel", 1, { id: "a", body: "Given more" });
  const optimistic = placeScenario(sc("Hotel", 1, { id: "a" }), { feature: before, index: 0 }, false)
    .next;

  test("placed at the render's stale index, Publish writes over its neighbour — the bug", () => {
    const { next } = placeScenario(renamed, { feature: optimistic, index: 0 }, false);
    expect(names(next)).toEqual(["Gamma v2", "Hotel v1", "Hotel v1"]);
  });

  test("queued after the tick, it publishes its own entry and keeps every neighbour", async () => {
    const queue = createPromiseQueue();
    const landed: Placement = { feature: optimistic, index: 2, id: "a" };
    const ahead = queue.run(async (): Promise<Placement> => landed);
    const next = await publishBehind(
      renamed,
      { feature: optimistic, index: 0, id: "a" },
      false,
      ahead,
      queue,
      () => undefined,
    );
    expect(names(next)).toEqual(["Gamma v1", "Gamma v2", "Hotel v1"]);
    expect(next.scenarios[2]!.body).toBe("Given more");
    expect(next.scenarios[2]!.id).toBe("a");
  });
});

/**
 * What the queued publish does once the tick is back, in the shape of
 * `publishScenario` + `publish` in App.tsx: bail if the path was sealed
 * while it waited; otherwise PUT to the file it was pinned to, and act on
 * the answer only if that file is still the one on screen.
 */
type Outcome = { status: number; conflict?: boolean };
async function publishQueued(opts: {
  file: string;
  ahead: Promise<Placement> | null;
  known: Placement;
  draft: Scenario;
  queue: ReturnType<typeof createPromiseQueue>;
  selected: () => string | null;
  sealed: () => boolean;
  put: (file: string, next: Feature) => Promise<Outcome>;
}) {
  const log: string[] = [];
  await opts.queue.run(async () => {
    const base = opts.ahead ? await opts.ahead : opts.known;
    if (opts.sealed()) return;
    const { next } = placeScenario(opts.draft, base, false);
    const res = await opts.put(opts.file, next);
    const stillHere = opts.selected() === opts.file;
    if (res.conflict) log.push(stillHere ? "conflict-dialog" : "conflict-toast");
    else if (res.status === 200) log.push(stillHere ? `open:${opts.file}` : "reload-listing");
  });
  return log;
}

describe("a Publish whose tick comes back after the user moved on", () => {
  const feature: Feature = { name: "Quote", description: "", scenarios: [sc("Alpha", 1, { id: "a" })] };
  const draft = sc("Alpha", 1, { id: "a", body: "Given more" });
  const known: Placement = { feature, index: 0, id: "a" };

  /** A tick on the queue that resolves when `land` is called. */
  function tickAway(queue: ReturnType<typeof createPromiseQueue>) {
    let land!: () => void;
    const gate = new Promise<void>((r) => (land = r));
    const ahead = queue.run(async (): Promise<Placement> => {
      await gate;
      return known;
    });
    return { ahead, land };
  }

  test("still on its feature, it reopens that feature", async () => {
    const queue = createPromiseQueue();
    const { ahead, land } = tickAway(queue);
    const run = publishQueued({
      file: "quote.feature.md",
      ahead,
      known,
      draft,
      queue,
      selected: () => "quote.feature.md",
      sealed: () => false,
      put: async () => ({ status: 200 }),
    });
    land();
    expect(await run).toEqual(["open:quote.feature.md"]);
  });

  test("another feature opened meanwhile — it publishes, but refreshes the listing instead of pulling the user back", async () => {
    const queue = createPromiseQueue();
    const { ahead, land } = tickAway(queue);
    let selected = "quote.feature.md";
    const puts: string[] = [];
    const run = publishQueued({
      file: "quote.feature.md",
      ahead,
      known,
      draft,
      queue,
      selected: () => selected,
      sealed: () => false,
      put: async (file) => {
        puts.push(file);
        return { status: 200 };
      },
    });
    selected = "billing.feature.md";
    land();
    expect(await run).toEqual(["reload-listing"]);
    expect(puts).toEqual(["quote.feature.md"]);
  });

  test("a conflict for a feature no longer on screen is reported, not opened over the new page", async () => {
    const queue = createPromiseQueue();
    const { ahead, land } = tickAway(queue);
    let selected = "quote.feature.md";
    const run = publishQueued({
      file: "quote.feature.md",
      ahead,
      known,
      draft,
      queue,
      selected: () => selected,
      sealed: () => false,
      put: async () => ({ status: 409, conflict: true }),
    });
    selected = "billing.feature.md";
    land();
    expect(await run).toEqual(["conflict-toast"]);
  });

  test("the path sealed while it waited (move, rename-file, delete) — nothing goes out", async () => {
    const queue = createPromiseQueue();
    const { ahead, land } = tickAway(queue);
    let sealed = false;
    const puts: string[] = [];
    const run = publishQueued({
      file: "quote.feature.md",
      ahead,
      known,
      draft,
      queue,
      selected: () => "quote.feature.md",
      sealed: () => sealed,
      put: async (file) => {
        puts.push(file);
        return { status: 200 };
      },
    });
    sealed = true;
    land();
    expect(await run).toEqual([]);
    expect(puts).toEqual([]);
  });
});

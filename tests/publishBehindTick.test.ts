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

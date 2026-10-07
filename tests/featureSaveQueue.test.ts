// Feature description, Assigned, ticket-link and scenario saves each
// serialize the whole `.feature.md`. Separate in-flight PUTs last-write-wins
// the other field: a description tick that captured the feature before
// Assigned landed restores "nobody", and a scenario save that captured it
// before the description tick landed drops the paragraph. One queue, each
// write starting from what the write ahead of it left, is the page editor's
// rule (tests/pageSave.test.ts) applied to the feature file.

import { describe, expect, test } from "bun:test";
import { createPromiseQueue, featureForWrite, placeScenario, type Placement } from "../src/frontend/App";
import type { Feature, Scenario } from "../src/server/parser";

const sc = (name: string, version: number, extra: Partial<Scenario> = {}): Scenario => ({
  name,
  version,
  status: "proposed",
  body: "",
  tests: [],
  ...extra,
});

const FILE = "specs/quote-policy.feature.md";

const feature = (over: Partial<Feature> = {}): Feature => ({
  name: "Quote",
  description: "old",
  scenarios: [sc("Alpha", 1, { id: "a", body: "Given x" })],
  ...over,
});

describe("featureForWrite", () => {
  test("uses the in-memory feature while this file is still open", () => {
    const captured = feature();
    const latest = feature({ description: "typed", assigned: "Ada" });
    expect(featureForWrite(FILE, FILE, latest, captured)).toBe(latest);
  });

  test("keeps the captured snapshot after the user has moved on", () => {
    const captured = feature({ description: "typed" });
    const latest = feature({ name: "Other", description: "" });
    expect(featureForWrite(FILE, "specs/other.feature.md", latest, captured)).toBe(captured);
    expect(featureForWrite(FILE, null, latest, captured)).toBe(captured);
    expect(featureForWrite(FILE, FILE, null, captured)).toBe(captured);
  });
});

describe("a description tick overlapping an Assigned save", () => {
  test("separate queues: the late description PUT restores nobody — the bug", async () => {
    let disk = feature();
    const descQueue = createPromiseQueue();
    const assignedQueue = createPromiseQueue();
    const captured = disk;

    const desc = descQueue.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      disk = { ...captured, description: "typed" };
    });
    const assigned = assignedQueue.run(async () => {
      disk = { ...captured, assigned: "Ada" };
    });
    await Promise.all([desc, assigned]);

    expect(disk.description).toBe("typed");
    expect(disk.assigned).toBeUndefined();
  });

  test("one queue, each write reads the latest: both land", async () => {
    let disk = feature();
    let latest: Feature | null = disk;
    const queue = createPromiseQueue();
    const captured = disk;

    const desc = queue.run(async () => {
      const base = featureForWrite(FILE, FILE, latest, captured);
      disk = { ...base, description: "typed" };
      latest = disk;
    });
    const assigned = queue.run(async () => {
      const base = featureForWrite(FILE, FILE, latest, captured);
      disk = { ...base, assigned: "Ada" };
      latest = disk;
    });
    await Promise.all([desc, assigned]);

    expect(disk.description).toBe("typed");
    expect(disk.assigned).toBe("Ada");
  });
});

describe("a scenario save overlapping a description tick", () => {
  const draft = sc("Alpha", 1, { id: "a", body: "Given y" });
  const known: Placement = {
    feature: feature(),
    index: 0,
    id: "a",
  };

  test("placed from the captured snapshot, the scenario PUT drops the description — the bug", () => {
    const { next } = placeScenario(draft, known, false);
    expect(next.description).toBe("old");
    expect(next.scenarios[0]!.body).toBe("Given y");
  });

  test("placed onto what the description tick left, both land", async () => {
    let latest: Feature | null = feature();
    const queue = createPromiseQueue();
    const captured = latest;

    await queue.run(async () => {
      const base = featureForWrite(FILE, FILE, latest, captured);
      latest = { ...base, description: "typed" };
    });
    const placed = await queue.run(async () => {
      const base = featureForWrite(FILE, FILE, latest, known.feature);
      return placeScenario(draft, { ...known, feature: base }, false).next;
    });

    expect(placed.description).toBe("typed");
    expect(placed.scenarios[0]!.body).toBe("Given y");
  });
});

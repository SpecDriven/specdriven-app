// The stores the feature page and the editor read (src/frontend/specs/):
// what App.tsx kept as its own state, set under the same names, so the Specs
// tab can read it from its plugin.
import { afterEach, expect, test } from "bun:test";
import { resetListing, scenarioStatus, setFeatures } from "../src/frontend/specs/listing";
import {
  openFeatureState,
  openFeatureTitle,
  resetOpenFeature,
  setEditing,
  setFeature,
  setSelected,
  setSelectedScenario,
  subscribeOpenFeature,
} from "../src/frontend/specs/openFeature";
import { recentSpec } from "../src/frontend/specs/palette";
import type { EditState } from "../src/frontend/specs/scenarioEdit";
import { createStore } from "../src/frontend/specs/store";
import type { FeatureListing } from "../src/server/features";
import type { Feature, Scenario } from "../src/server/parser";

const FILE = "specs/quotes.feature.md";
const scenario = (name: string, version: number, status: string) => ({ name, version, status }) as unknown as Scenario;
const quotes = {
  name: "Quotes",
  description: "",
  scenarios: [scenario("Create a quote", 1, "published"), scenario("Send a quote", 2, "draft")],
} as unknown as Feature;
const listed = {
  fileName: FILE,
  name: "Quotes as listed",
  scenarios: [scenario("Create a quote", 1, "published")],
} as unknown as FeatureListing;

afterEach(() => {
  resetOpenFeature();
  resetListing();
});

test("a field's setter takes a value or a function of the current one, and leaves the other fields alone", () => {
  const store = createStore(() => ({ count: 1, name: "a" }));
  const setCount = store.field("count");
  setCount(2);
  setCount((n) => n + 1);
  expect(store.get()).toEqual({ count: 3, name: "a" });
});

test("a setter that changes nothing keeps the same state and tells no one", () => {
  const store = createStore(() => ({ count: 1 }));
  let told = 0;
  const stop = store.subscribe(() => told++);
  const before = store.get();
  store.field("count")(1);
  expect(store.get() === before).toBe(true);
  expect(told).toBe(0);
  store.field("count")(2);
  expect(told).toBe(1);
  stop();
  store.field("count")(3);
  expect(told).toBe(1);
});

test("a reset starts from a fresh initial state, not the one last handed out", () => {
  const store = createStore(() => ({ picks: new Set<string>() }));
  store.get().picks.add("left behind");
  store.reset();
  expect(store.get().picks.size).toBe(0);
});

test("the open feature starts with nothing open and goes back to it on a reset", () => {
  expect(openFeatureState().selected).toBeNull();
  let told = 0;
  const stop = subscribeOpenFeature(() => told++);
  setSelected(FILE);
  setFeature(quotes);
  setSelectedScenario(1);
  expect(told).toBe(3);
  expect(openFeatureState().feature === quotes).toBe(true);
  resetOpenFeature();
  stop();
  expect(openFeatureState()).toEqual({
    selected: null,
    feature: null,
    featureLoading: false,
    selectedScenario: null,
    dirty: false,
    editing: null,
    paneRequest: null,
    searchTerms: null,
  });
});

test("the window title names the open feature, and the scenario whose page is open", () => {
  expect(openFeatureTitle()).toBeNull();
  setSelected(FILE);
  // Read, but not yet shown: no title until the feature is in.
  expect(openFeatureTitle()).toBeNull();
  setFeature(quotes);
  expect(openFeatureTitle()).toBe("Quotes");
  setEditing({ index: 1 } as unknown as EditState);
  expect(openFeatureTitle()).toBe("Quotes · Send a quote v2");
  // A new scenario no save has placed yet has no page of its own.
  setEditing({ index: null } as unknown as EditState);
  expect(openFeatureTitle()).toBe("Quotes");
});

test("a feature with no name of its own is titled by its file", () => {
  setSelected(FILE);
  setFeature({ ...quotes, name: "" } as Feature);
  expect(openFeatureTitle()).toBe("Quotes");
});

test("a listed scenario's status is the listing's, and proposed for one it does not know", () => {
  setFeatures([listed]);
  expect(scenarioStatus(FILE, { name: "Create a quote", version: 1 })).toBe("published");
  expect(scenarioStatus(FILE, { name: "Create a quote", version: 2 })).toBe("proposed");
  expect(scenarioStatus("specs/gone.feature.md", { name: "Create a quote", version: 1 })).toBe("proposed");
});

test("Recent names a feature as the open one has it, else as listed, else by its file", () => {
  expect(recentSpec({ feature: FILE })?.label).toBe("Quotes");
  setFeatures([listed]);
  expect(recentSpec({ feature: FILE })?.label).toBe("Quotes as listed");
  setSelected(FILE);
  setFeature({ ...quotes, name: "Quotes, open" } as Feature);
  expect(recentSpec({ feature: FILE })?.label).toBe("Quotes, open");
});

test("Recent names a scenario under its feature, and drops one that is gone", () => {
  setFeatures([listed]);
  const hit = recentSpec({ feature: FILE, scenario: { slug: "create-a-quote", version: 1 } });
  expect(hit?.label).toBe("Create a quote");
  expect(hit?.sub).toBe("Quotes as listed");
  expect(hit?.altView).toEqual({ feature: FILE, scenario: { slug: "create-a-quote", version: 1 }, page: true });
  // The open feature knows a draft the listing has not caught up with.
  expect(recentSpec({ feature: FILE, scenario: { slug: "send-a-quote" } })).toBeNull();
  setSelected(FILE);
  setFeature(quotes);
  expect(recentSpec({ feature: FILE, scenario: { slug: "send-a-quote" } })?.label).toBe("Send a quote");
  expect(recentSpec({ feature: FILE, scenario: { slug: "no-such-scenario" } })).toBeNull();
});

// The spec listing's core store (src/frontend/specs/listing.ts): what App.tsx
// kept as five pieces of state, now one store the Specs tab can read too.
import { afterEach, expect, test } from "bun:test";
import {
  resetListing,
  setFeatureOrders,
  setFeatures,
  setListing,
  specsListing,
} from "../src/frontend/specs/listing";
import type { FeatureListing } from "../src/server/features";

const quotes = { fileName: "specs/quotes.feature.md", name: "Quotes", scenarios: [] } as unknown as FeatureListing;
const billing = { fileName: "specs/billing.feature.md", name: "Billing", scenarios: [] } as unknown as FeatureListing;

afterEach(() => resetListing());

test("a listing read from the server replaces what was there, field by field", () => {
  setListing({
    features: [quotes],
    folders: ["billing"],
    folderDescriptions: { billing: "Money" },
    folderOrders: { specs: ["billing"] },
    featureOrders: {},
  });
  expect(specsListing().features.map((f) => f.name)).toEqual(["Quotes"]);
  expect(specsListing().folderDescriptions).toEqual({ billing: "Money" });
});

test("a setter takes a value or a function of the current one, and leaves the other fields alone", () => {
  setListing({ features: [quotes], folders: ["billing"], folderDescriptions: {}, folderOrders: {}, featureOrders: {} });
  setFeatures((prev) => [...prev, billing]);
  setFeatureOrders({ specs: [billing.fileName, quotes.fileName] });
  expect(specsListing().features.map((f) => f.name)).toEqual(["Quotes", "Billing"]);
  expect(specsListing().featureOrders).toEqual({ specs: [billing.fileName, quotes.fileName] });
  expect(specsListing().folders).toEqual(["billing"]);
});

test("an update that changes nothing keeps the same listing, so nothing re-renders", () => {
  setListing({ features: [quotes], folders: [], folderDescriptions: {}, folderOrders: {}, featureOrders: {} });
  const before = specsListing();
  setFeatures((prev) => prev);
  expect(specsListing() === before).toBe(true);
});

test("a reset lists nothing, as a fresh App starts", () => {
  setFeatures([quotes]);
  resetListing();
  expect(specsListing().features).toEqual([]);
  expect(specsListing().folderOrders).toEqual({});
});

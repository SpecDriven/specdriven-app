// When operations already arrived, three-way fold of theirs must keep the
// merged document on overlapping text (a character merge would splice the
// same insertion twice) and still take fields the document left at the
// merge base — the mixed-origin hand edit H1 used to drop.

import { test, expect } from "bun:test";
import { threeWayFeature, threeWayPage } from "../../src/server/automerge/merge";
import { parseFeature, parsePage } from "../../src/server/parser";

const BASE = `# Seed

## Alpha @v1 [proposed]

- alpha one
- alpha two

## Beta @v1 [proposed]

- beta one
- beta two
`;

test("ours-overlap keeps the CRDT body and absorbs a hand edit on another scenario", () => {
  const base = parseFeature(BASE);
  const ours = parseFeature(
    BASE.replace("- alpha one", "- alpha one, from B's app").replace("- alpha two", "- alpha two, from A"),
  );
  const theirs = parseFeature(
    BASE.replace("- alpha one", "- alpha one, from B's app").replace("- beta one", "- beta one, hand-edited on B"),
  );

  const merged = threeWayFeature(base, ours, theirs, "ours");
  expect(merged.ok).toBe(true);
  if (!merged.ok) return;
  const alpha = merged.feature.scenarios.find((s) => s.name === "Alpha")!;
  const beta = merged.feature.scenarios.find((s) => s.name === "Beta")!;
  expect(alpha.body).toBe("- alpha one, from B's app\n- alpha two, from A");
  expect(beta.body).toBe("- beta one, hand-edited on B\n- beta two");
});

test("ours-overlap on a page keeps the CRDT body and takes a metadata-only hand edit", () => {
  const base = parsePage("# Once\n\n**Kind:** Observation\n\nline one\n");
  const ours = parsePage("# Once\n\n**Kind:** Observation\n\nline one, from A and B\n");
  const theirs = parsePage("# Once\n\n**Kind:** Decision\n\nline one, from B\n");

  const merged = threeWayPage(base, ours, theirs, "ours");
  expect(merged.body).toBe("line one, from A and B");
  expect(merged.kind).toBe("Decision");
});

// Automates specs/editor/feature-editor.feature.md "Edit feature descrition":
// the description editor that opens on a just-created feature saves through
// the ordinary feature save, so what it holds lands as the free markdown
// between the feature heading and the first scenario.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeature,
  readFeature,
  readFeatureForEditor,
  saveFeature,
} from "../src/server/features";
import { parseFeature, serializeFeature } from "../src/server/parser";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-feature-editor-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** What the description editor's autosave tick sends: the feature as read, with the description it holds. */
function withDescription(content: string, description: string): string {
  return serializeFeature({ ...parseFeature(content), description });
}

test("a new feature has an empty description for the editor to fill in", async () => {
  const fileName = await createFeature(root, "Quote Policy");
  const content = await readFeatureForEditor(root, fileName);
  expect(content).not.toBeNull();
  expect(parseFeature(content!)).toEqual({ name: "Quote Policy", description: "", scenarios: [] });
});

test("the description typed on a new feature is saved under its heading", async () => {
  const fileName = await createFeature(root, "Quote Policy");
  const before = (await readFeatureForEditor(root, fileName))!;
  const result = await saveFeature(root, fileName, withDescription(before, "Quotes for **new** customers."));
  expect(result.status).toBe("saved");
  expect(result.parsed.description).toBe("Quotes for **new** customers.");
  expect(await readFeature(root, fileName)).toBe("# Quote Policy\n\nQuotes for **new** customers.\n");
});

test("editing the description keeps the scenarios and their status", async () => {
  const fileName = await createFeature(root, "Quote Policy");
  await saveFeature(
    root,
    fileName,
    "# Quote Policy\n\nFirst draft.\n\n## Basic Quote @v1 [proposed]\n\n- Given a customer\n",
  );
  const before = (await readFeatureForEditor(root, fileName))!;
  const result = await saveFeature(root, fileName, withDescription(before, "Second draft."));
  expect(result.parsed.description).toBe("Second draft.");
  expect(result.parsed.scenarios.map((s) => [s.name, s.version, s.status, s.body])).toEqual([
    ["Basic Quote", 1, "proposed", "- Given a customer"],
  ]);
  expect(await readFeature(root, fileName)).toBe(
    "# Quote Policy\n\nSecond draft.\n\n## S1: Basic Quote @v1 [proposed]\n\n- Given a customer\n",
  );
});

test("clearing the description leaves just the heading", async () => {
  const fileName = await createFeature(root, "Quote Policy");
  await saveFeature(root, fileName, "# Quote Policy\n\nSoon gone.\n");
  const before = (await readFeatureForEditor(root, fileName))!;
  await saveFeature(root, fileName, withDescription(before, ""));
  expect(await readFeature(root, fileName)).toBe("# Quote Policy\n");
});

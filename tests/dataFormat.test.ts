// Automates specs/app/data-format.feature.md: the data repo's format marker,
// and the Automerge store refusing a document newer than this app.

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as A from "@automerge/automerge";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version as appVersion } from "../package.json";
import {
  DATA_FORMAT,
  DATA_FORMAT_FILE,
  DATA_TOO_NEW_HEADER,
  DataTooNewError,
  checkDataFormat,
  incompatibility,
  readDataFormat,
  resetDataFormatFlags,
  stampDataFormat,
} from "../src/server/dataFormat";
import { DATA_TOO_NEW_HEADER as CLIENT_HEADER } from "../src/frontend/AppOutdated";
import {
  PAGE_SCHEMA_VERSION,
  SCHEMA_VERSION,
  TESTING_SCHEMA_VERSION,
  type FeatureDoc,
} from "../src/server/automerge/schema";
import { createFeatureDoc, loadFeatureDoc, newFeatureDoc } from "../src/server/automerge/store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-format-"));
});

afterEach(async () => {
  resetDataFormatFlags();
  await rm(dir, { recursive: true, force: true });
});

async function writeMarker(content: string): Promise<void> {
  await Bun.write(join(dir, DATA_FORMAT_FILE), content);
}

// The rule at the top of src/server/dataFormat.ts: a schema bump an older
// release would misread raises the data format with it. When this fails,
// decide whether the change needs DATA_FORMAT bumped, then update the pins.
test("the data format is pinned to the schema versions", () => {
  expect({
    DATA_FORMAT,
    SCHEMA_VERSION,
    PAGE_SCHEMA_VERSION,
    TESTING_SCHEMA_VERSION,
  }).toEqual({
    DATA_FORMAT: 2,
    SCHEMA_VERSION: 3,
    PAGE_SCHEMA_VERSION: 1,
    TESTING_SCHEMA_VERSION: 1,
  });
});

test("server and client agree on the blocked-folder header", () => {
  expect(CLIENT_HEADER).toBe(DATA_TOO_NEW_HEADER);
});

test("a folder with no marker is in the first format", async () => {
  expect(await readDataFormat(dir)).toBeNull();
  expect(await checkDataFormat(dir)).toBeNull();
  expect(incompatibility(dir)).toBeNull();
});

test("a folder in the first format is raised to this app's", async () => {
  // Format 2 numbers the scenario headings (parser.ts), which a format-1 app
  // would read as part of the name: the marker is written on the first tick.
  expect(DATA_FORMAT).toBe(2);
  expect(await stampDataFormat(dir)).toBe(true);
  expect(await readDataFormat(dir)).toEqual({ format: 2, minAppVersion: appVersion });
  // Once there, it is left alone.
  expect(await stampDataFormat(dir)).toBe(false);
});

test("the format marker is written on first sync", async () => {
  // As the release that raises the format to 2 will do.
  expect(await stampDataFormat(dir, 2)).toBe(true);
  expect(await readDataFormat(dir)).toEqual({ format: 2, minAppVersion: appVersion });
  // Once there, it is left alone.
  expect(await stampDataFormat(dir, 2)).toBe(false);
});

test("an older marker is raised; a newer one is never lowered", async () => {
  await writeMarker(JSON.stringify({ format: 1, minAppVersion: "0.0.1" }));
  expect(await stampDataFormat(dir, 2)).toBe(true);
  expect((await readDataFormat(dir))?.format).toBe(2);

  await writeMarker(JSON.stringify({ format: 99, minAppVersion: "9.9.9" }));
  expect(await stampDataFormat(dir, 2)).toBe(false);
  expect((await readDataFormat(dir))?.format).toBe(99);
});

test("data saved by a newer app blocks this one", async () => {
  await writeMarker(JSON.stringify({ format: DATA_FORMAT + 1, minAppVersion: "9.9.9" }));
  const found = await checkDataFormat(dir);
  expect(found).toMatchObject({ minAppVersion: "9.9.9", appVersion, source: "marker" });
  expect(found?.reason).toContain("9.9.9");
  expect(incompatibility(dir)).toEqual(found);
});

test("a folder rolled back to this format is unblocked", async () => {
  await writeMarker(JSON.stringify({ format: 99, minAppVersion: "9.9.9" }));
  expect(await checkDataFormat(dir)).not.toBeNull();
  await writeMarker(JSON.stringify({ format: DATA_FORMAT, minAppVersion: appVersion }));
  expect(await checkDataFormat(dir)).toBeNull();
  expect(incompatibility(dir)).toBeNull();
});

test("a marker git left conflict markers in reads as its highest format", async () => {
  await writeMarker(
    [
      "{",
      "<<<<<<< HEAD",
      '  "format": 1,',
      '  "minAppVersion": "0.1.151"',
      "=======",
      '  "format": 2,',
      '  "minAppVersion": "0.1.170"',
      ">>>>>>> origin/main",
      "}",
    ].join("\n"),
  );
  expect(await readDataFormat(dir)).toEqual({ format: 2, minAppVersion: "0.1.170" });
});

test("an unreadable marker is ignored", async () => {
  await writeMarker("not json at all");
  expect(await readDataFormat(dir)).toBeNull();
  expect(await checkDataFormat(dir)).toBeNull();
});

test("a newer Automerge document is refused", async () => {
  const fileName = "specs/later.feature.md";
  const later = A.from({
    schemaVersion: SCHEMA_VERSION + 1,
    id: randomUUID(),
    name: "Later",
    description: "",
    specs: [],
  }) as unknown as A.Doc<FeatureDoc>;
  await createFeatureDoc(dir, fileName, later);

  const error = await loadFeatureDoc(dir, fileName).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DataTooNewError);
  expect(incompatibility(dir)?.source).toBe("document");
  // The marker saying nothing does not make the document readable.
  expect(await checkDataFormat(dir)).not.toBeNull();
});

test("a document in this app's schema loads", async () => {
  const fileName = "specs/now.feature.md";
  await createFeatureDoc(dir, fileName, newFeatureDoc({ name: "Now", description: "", specs: [] }));
  expect((await loadFeatureDoc(dir, fileName))?.doc.schemaVersion).toBe(SCHEMA_VERSION);
  expect(incompatibility(dir)).toBeNull();
});

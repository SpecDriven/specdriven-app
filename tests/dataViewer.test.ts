// The data viewer's server half (src/server/dataViewer.ts, specs/app/
// data-viewer.feature.md [proposed]): the store flattened into tables,
// filtered, sorted and paged; a document read whole with its chunks; its
// history newest first; the document at a change with what the change did;
// and the routes, which refuse to leave the store and keep answering while
// the data is newer than the app.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as A from "@automerge/automerge";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeatureDoc,
  createFileDoc,
  createPageDoc,
  createTestingDoc,
  newFeatureDoc,
  newPageDoc,
  newTestingDoc,
  saveFeatureDoc,
} from "../src/server/automerge/store";
import type { FeatureDoc } from "../src/server/automerge/schema";
import { createCase, createPlan } from "../src/server/testing";
import {
  buildTable,
  listTables,
  queryRows,
  readDoc,
  readDocAt,
  readHistory,
  readTable,
  resetDataViewer,
  scanStore,
  type TableRow,
} from "../src/server/dataViewer";
import { handleApi, reloader, syncedOnStart } from "../src/server/api";
import { DATA_TOO_NEW_HEADER, markIncompatible, resetDataFormatFlags } from "../src/server/dataFormat";
import { writeState } from "../src/server/state";

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

const FEATURE = "specs/billing/collect-premium.feature.md";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-dataviewer-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-dataviewer-home-"));
  data = join(root, "data");
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  resetDataViewer();
  resetDataFormatFlags();
});

afterEach(async () => {
  await syncedOnStart();
  reloader.stop();
  resetDataViewer();
  resetDataFormatFlags();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A store with one of everything: a feature edited once, a page, an event model, the testing document. */
async function seed() {
  const created = await createFeatureDoc(
    data,
    FEATURE,
    newFeatureDoc({
      name: "Collect Premium",
      description: "Money in.",
      createdBy: "ana",
      specs: [
        {
          id: "s-1",
          type: "Scenario",
          name: "Pay on time",
          version: 1,
          status: "published",
          rank: 1,
          body: "- **Given** a policy\n- **Then** paid",
          publishedBody: new A.ImmutableString("- **Given** a policy\n- **Then** paid"),
          tests: ["https://github.com/acme/repo/blob/main/pay.test.ts#L3"],
        },
        {
          id: "s-2",
          type: "Scenario",
          name: "Late payment",
          version: 1,
          status: "draft",
          rank: 2,
          body: "- **Given** a policy\n- **Then** a reminder",
          tests: [],
        },
      ],
    } as unknown as Omit<FeatureDoc, "schemaVersion" | "id">),
  );
  const edited = A.change(A.clone(created.doc), { message: "Reminder after ten days", time: 1_700_000_000 }, (d) => {
    A.updateText(d, ["specs", 1, "body"], "- **Given** a policy\n- **Then** a reminder after ten days");
  });
  await saveFeatureDoc(data, FEATURE, edited, created.heads);
  await createPageDoc(data, "tasks/ship.md", newPageDoc({ name: "Ship", body: "- release", assigned: "bo" }));
  await createFileDoc(data, "models/claims/water.model.json", A.from({ id: "m-1", name: "Water damage", slices: [{ id: "a" }, { id: "b" }] }));
  await createTestingDoc(data, newTestingDoc());
  const tc = await createCase(data, { title: "Pay on time works", body: "steps", priority: "high", refs: [{ fileName: FEATURE }] });
  await createPlan(data, { name: "Smoke", description: "", caseIds: [tc.id] });
  return { created, edited };
}

describe("tables", () => {
  test("every table lists its rows, from documents loaded as they are on disk", async () => {
    await seed();
    const tables = await listTables(data);
    expect(tables.documents).toBe(4);
    expect(Object.fromEntries(tables.tables.map((t) => [t.name, t.rows]))).toEqual({
      documents: 4,
      features: 1,
      specs: 2,
      pages: 1,
      test_cases: 1,
      test_plans: 1,
      test_executions: 0,
      event_models: 1,
    });
    expect(tables.scannedAt).toMatch(/^\d{4}-/);
  });

  test("specs are flattened with their feature, publishedBody read as text, nested values wrapped", async () => {
    await seed();
    const { docs } = await scanStore(data);
    const { columns, rows } = buildTable("specs", docs);
    expect(columns.slice(0, 7).map((c) => c.name)).toEqual(["feature", "list", "id", "type", "name", "version", "status"]);
    expect(columns.find((c) => c.name === "rank")?.type).toBe("number");
    expect(columns.find((c) => c.name === "tests")?.type).toBe("json");
    const first = rows.find((r) => r.cells.id === "s-1")!;
    expect(first.doc).toBe(FEATURE);
    expect(first.cells.feature).toBe(FEATURE);
    expect(first.cells.list).toBe("specs");
    expect(first.cells.publishedBody).toBe("- **Given** a policy\n- **Then** paid");
    expect(first.cells.tests).toEqual({ json: ["https://github.com/acme/repo/blob/main/pay.test.ts#L3"] });
    expect(rows.find((r) => r.cells.id === "s-2")!.cells.publishedBody).toBeNull();
  });

  test("the documents table carries identity, heads, chunks and sizes", async () => {
    await seed();
    const { docs } = await scanStore(data);
    const { rows } = buildTable("documents", docs);
    const feature = rows.find((r) => r.cells.dirRel === FEATURE)!;
    expect(feature.cells.kind).toBe("feature");
    expect(feature.cells.path).toBe(FEATURE);
    expect(feature.cells.schemaVersion).toBe(3);
    expect(feature.cells.chunkFiles).toBe(2);
    expect(feature.cells.changes).toBe(2);
    expect(typeof feature.cells.snapshotBytes === "number" && feature.cells.snapshotBytes > 0).toBe(true);
    expect(rows.find((r) => r.cells.dirRel === "test-management/project")!.cells.kind).toBe("testing");
    expect(rows.find((r) => r.cells.dirRel === "event-models/claims/water.model.json")!.cells.path).toBe("models/claims/water.model.json");
  });

  test("the testing document's maps and a plugin's document become rows", async () => {
    await seed();
    const { docs } = await scanStore(data);
    const cases = buildTable("test_cases", docs).rows;
    expect(cases.length).toBe(1);
    expect(cases[0]!.cells.title).toBe("Pay on time works");
    expect(cases[0]!.cells.refs).toEqual({ json: [{ fileName: FEATURE }] });
    const plans = buildTable("test_plans", docs).rows;
    expect(plans[0]!.cells.caseIds).toEqual({ json: [cases[0]!.cells.id] });
    const models = buildTable("event_models", docs);
    expect(models.columns.map((c) => c.name)).toEqual(["path", "id", "name", "slices"]);
    expect(models.rows[0]!.cells.slices).toEqual({ json: [{ id: "a" }, { id: "b" }] });
  });

  test("queryRows filters over scalar and nested cells, sorts, and pages", () => {
    const row = (key: string, cells: TableRow["cells"]): TableRow => ({ key, doc: "d", cells });
    const rows = [
      row("a", { name: "Zed", rank: 3, tags: { json: ["slow"] } }),
      row("b", { name: "amy", rank: 10, tags: { json: ["fast"] } }),
      row("c", { name: "Bob", rank: null, tags: null }),
    ];
    expect(queryRows(rows, { q: "SLOW", offset: 0, limit: 10 }).rows.map((r) => r.key)).toEqual(["a"]);
    expect(queryRows(rows, { q: "b", offset: 0, limit: 10 }).rows.map((r) => r.key)).toEqual(["c"]);
    expect(queryRows(rows, { sort: "name", offset: 0, limit: 10 }).rows.map((r) => r.key)).toEqual(["b", "c", "a"]);
    // Numbers sort as numbers (10 after 3), nulls last either way.
    expect(queryRows(rows, { sort: "rank", offset: 0, limit: 10 }).rows.map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(queryRows(rows, { sort: "rank", dir: "desc", offset: 0, limit: 10 }).rows.map((r) => r.key)).toEqual(["b", "a", "c"]);
    const page = queryRows(rows, { sort: "name", offset: 1, limit: 1 });
    expect(page.filtered).toBe(3);
    expect(page.rows.map((r) => r.key)).toEqual(["c"]);
  });

  test("readTable serves a page and refuses a column it does not have", async () => {
    await seed();
    const page = await readTable(data, "specs", { q: "reminder", sort: "name", dir: "desc", offset: 0, limit: 1 });
    expect(page.total).toBe(2);
    expect(page.filtered).toBe(1);
    expect(page.rows[0]!.cells.name).toBe("Late payment");
    await expect(readTable(data, "specs", { sort: "nope", offset: 0, limit: 1 })).rejects.toThrow("unknown column");
  });
});

describe("documents", () => {
  test("readDoc returns what is on disk with its chunk files", async () => {
    await seed();
    const doc = (await readDoc(data, FEATURE))!;
    expect(doc.meta.kind).toBe("feature");
    expect(doc.meta.docId).toMatch(/[0-9a-f-]{36}/);
    expect(doc.meta.heads.length).toBe(1);
    expect(doc.meta.schemaVersion).toBe(3);
    expect(doc.meta.chunks.map((c) => c.kind)).toEqual(["snapshot", "changes"]);
    expect(doc.meta.stats.changes).toBe(2);
    const json = doc.json as { specs: { body: string; publishedBody?: string }[] };
    expect(json.specs[1]!.body).toContain("ten days");
    expect(typeof json.specs[0]!.publishedBody).toBe("string");
    expect(await readDoc(data, "specs/nope.feature.md")).toBeNull();
  });

  test("history lists the changes newest first, and a change shows the document then and its patches", async () => {
    await seed();
    const history = (await readHistory(data, FEATURE, 0, 10))!;
    expect(history.total).toBe(2);
    const [edit, genesis] = history.changes;
    expect(edit!.message).toBe("Reminder after ten days");
    expect(edit!.time).toBe(1_700_000_000);
    expect(edit!.deps).toEqual([genesis!.hash]);
    expect(edit!.ops).toBeGreaterThan(0);

    const before = (await readDocAt(data, FEATURE, [genesis!.hash]))!;
    expect((before.json as { specs: { body: string }[] }).specs[1]!.body).not.toContain("ten days");
    expect(before.parents).toEqual([]);
    expect(before.patches).toEqual([]);

    const after = (await readDocAt(data, FEATURE, [edit!.hash]))!;
    expect((after.json as { specs: { body: string }[] }).specs[1]!.body).toContain("ten days");
    expect(after.parents).toEqual([genesis!.hash]);
    expect(after.patches.length).toBeGreaterThan(0);
    expect(after.patches.every((p) => p.path.join("/").startsWith("specs/1/body"))).toBe(true);
    expect(after.change?.hash).toBe(edit!.hash);

    expect(await readDocAt(data, FEATURE, ["0".repeat(64)])).toBeNull();
  });

  test("a local save is seen by the next request", async () => {
    const { edited } = await seed();
    expect((await listTables(data)).tables.find((t) => t.name === "specs")!.rows).toBe(2);
    const more = A.change(A.clone(edited), (d) => {
      d.specs.push({ id: "s-3", type: "Scenario", name: "Refund", version: 1, status: "draft", body: "", tests: [] });
    });
    await saveFeatureDoc(data, FEATURE, more, A.getHeads(edited));
    expect((await listTables(data)).tables.find((t) => t.name === "specs")!.rows).toBe(3);
  });
});

describe("routes", () => {
  const get = (path: string) => handleApi(new Request(`http://localhost${path}`));

  test("serve tables, rows, a document, its history and a change", async () => {
    await seed();
    await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);

    const tables = await get("/api/data/tables");
    expect(tables!.status).toBe(200);
    expect(((await tables!.json()) as { documents: number }).documents).toBe(4);

    const rows = await get("/api/data/tables/specs?q=policy&sort=rank&dir=desc&offset=0&limit=1");
    expect(rows!.status).toBe(200);
    const page = (await rows!.json()) as { rows: TableRow[]; filtered: number; sort: string; dir: string };
    expect(page.filtered).toBe(2);
    expect(page.rows.map((r) => r.cells.name)).toEqual(["Late payment"]);
    expect([page.sort, page.dir]).toEqual(["rank", "desc"]);

    const doc = await get(`/api/data/doc?path=${encodeURIComponent(FEATURE)}`);
    expect(doc!.status).toBe(200);
    expect(((await doc!.json()) as { meta: { kind: string } }).meta.kind).toBe("feature");

    const history = await get(`/api/data/doc/history?path=${encodeURIComponent(FEATURE)}&limit=1`);
    const h = (await history!.json()) as { total: number; changes: { hash: string }[] };
    expect(h.total).toBe(2);
    expect(h.changes.length).toBe(1);

    const at = await get(`/api/data/doc/at?path=${encodeURIComponent(FEATURE)}&heads=${h.changes[0]!.hash}`);
    expect(at!.status).toBe(200);
    expect(((await at!.json()) as { patches: unknown[] }).patches.length).toBeGreaterThan(0);
  });

  test("refuse what is not a table, a column, a store path or a change hash", async () => {
    await seed();
    await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);
    const status = async (path: string) => (await get(path))!.status;
    expect(await status("/api/data/tables/nope")).toBe(400);
    expect(await status("/api/data/tables/specs?sort=nope")).toBe(400);
    expect(await status("/api/data/tables/specs?limit=0")).toBe(400);
    expect(await status("/api/data/tables/specs?dir=sideways")).toBe(400);
    expect(await status("/api/data/doc")).toBe(400);
    expect(await status("/api/data/doc?path=../../etc/passwd")).toBe(400);
    expect(await status("/api/data/doc?path=.git")).toBe(400);
    expect(await status("/api/data/doc?path=specs/nope.feature.md")).toBe(404);
    expect(await status(`/api/data/doc/at?path=${encodeURIComponent(FEATURE)}`)).toBe(400);
    expect(await status(`/api/data/doc/at?path=${encodeURIComponent(FEATURE)}&heads=xyz`)).toBe(400);
    expect(await status(`/api/data/doc/at?path=${encodeURIComponent(FEATURE)}&heads=${"0".repeat(64)}`)).toBe(404);
  });

  test("keep answering while the data is newer than the app", async () => {
    await seed();
    await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);
    markIncompatible(data, { minAppVersion: "99.0.0", appVersion: "0.0.1", reason: "newer", source: "marker" });
    // A GET still answers then, but flagged; the viewer's answers are not.
    const blocked = await get("/api/features");
    expect(blocked!.headers.get(DATA_TOO_NEW_HEADER)).toBe("99.0.0");
    const tables = await get("/api/data/tables");
    expect(tables!.status).toBe(200);
    expect(tables!.headers.get(DATA_TOO_NEW_HEADER)).toBeNull();
  });
});

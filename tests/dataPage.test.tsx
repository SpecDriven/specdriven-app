// The Data page (src/frontend/DataPage.tsx, specs/app/data-viewer.feature.md
// [proposed]): the helpers its cells and requests are built from, the JSON
// tree as static markup, and the page driven in a borrowed DOM against a
// fake /api/data — the tables with their counts, a sort and a filter
// reaching the server, a row opening as a tree, its document, and the
// history where a change shows the document as it stood.
//
// The DOM is borrowed the way tests/observabilityPage.test.tsx borrows it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/data" });
  const w = happyWindow as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (w[key] ?? w.window);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { DataPage } from "../src/frontend/DataPage";
import { JsonTree } from "../src/frontend/JsonTree";
import {
  DEFAULT_QUERY,
  atUrl,
  cellText,
  changeTime,
  docUrl,
  formatCount,
  historyUrl,
  patchLine,
  tableUrl,
  type DocAtResponse,
  type DocResponse,
  type HistoryPage,
  type TablePage,
  type TablesResponse,
} from "../src/frontend/dataViewer";

const FEATURE = "specs/billing/collect-premium.feature.md";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const tables: TablesResponse = {
  tables: [
    { name: "documents", label: "Documents", rows: 3 },
    { name: "features", label: "Features", rows: 1 },
    { name: "specs", label: "Specs", rows: 2 },
    { name: "pages", label: "Pages", rows: 0 },
    { name: "test_cases", label: "Test cases", rows: 0 },
    { name: "test_plans", label: "Test plans", rows: 0 },
    { name: "test_executions", label: "Test executions", rows: 0 },
    { name: "event_models", label: "Event models", rows: 0 },
  ],
  documents: 3,
  scannedAt: "2026-10-28T10:00:00.000Z",
};

const specsPage = (q: string | null, sort: string | null, dir: string | null): TablePage => {
  const rows = [
    { key: `${FEATURE}#specs/s-1`, doc: FEATURE, cells: { feature: FEATURE, name: "Pay on time", rank: 1, tests: { json: ["t.ts#L3"] } } },
    { key: `${FEATURE}#specs/s-2`, doc: FEATURE, cells: { feature: FEATURE, name: "Late payment", rank: 2, tests: null } },
  ];
  const matched = q ? rows.filter((r) => String(r.cells.name).toLowerCase().includes(q.toLowerCase())) : rows;
  const sorted = sort === "rank" && dir === "desc" ? [...matched].reverse() : matched;
  return {
    table: "specs",
    columns: [
      { name: "feature", type: "string" },
      { name: "name", type: "string" },
      { name: "rank", type: "number" },
      { name: "tests", type: "json" },
    ],
    rows: sorted,
    total: 2,
    filtered: matched.length,
    offset: 0,
    limit: 100,
    sort,
    dir: dir === "desc" ? "desc" : "asc",
  };
};

const docResponse: DocResponse = {
  meta: {
    dirRel: FEATURE,
    path: FEATURE,
    kind: "feature",
    docId: "doc-1",
    heads: [HASH_B],
    schemaVersion: 3,
    chunks: [
      { file: "snapshot-1111.bin", kind: "snapshot", bytes: 2048, applied: true },
      { file: "changes-2222.bin", kind: "changes", bytes: 300, applied: true },
    ],
    skippedChunks: [],
    stats: { changes: 2, ops: 40, actors: 1 },
  },
  json: { schemaVersion: 3, name: "Collect Premium", specs: [{ name: "Pay on time", body: "- **Then** paid" }] },
};

const history: HistoryPage = {
  dirRel: FEATURE,
  changes: [
    { hash: HASH_B, actor: "actor-1", seq: 2, time: 1_700_000_000, message: "Edit the body", deps: [HASH_A], ops: 3 },
    { hash: HASH_A, actor: "actor-1", seq: 1, time: 0, message: null, deps: [], ops: 37 },
  ],
  total: 2,
  offset: 0,
  limit: 50,
};

const atB: DocAtResponse = {
  dirRel: FEATURE,
  heads: [HASH_B],
  parents: [HASH_A],
  json: { name: "Collect Premium", specs: [{ name: "Pay on time", body: "- **Then** paid" }] },
  patches: [{ action: "splice", path: ["specs", 0, "body"], value: "paid" }],
  change: history.changes[0]!,
};

describe("helpers", () => {
  test("urls leave defaults out", () => {
    expect(tableUrl("specs", DEFAULT_QUERY)).toBe("/api/data/tables/specs?limit=100");
    expect(tableUrl("specs", { q: " late ", sort: "rank", dir: "desc", offset: 100 })).toBe(
      "/api/data/tables/specs?q=late&sort=rank&dir=desc&offset=100&limit=100",
    );
    expect(tableUrl("specs", { q: "", sort: "rank", dir: "asc", offset: 0 })).toBe("/api/data/tables/specs?sort=rank&limit=100");
    expect(docUrl("specs/a b.feature.md")).toBe("/api/data/doc?path=specs%2Fa+b.feature.md");
    expect(historyUrl(FEATURE, 50)).toContain("offset=50&limit=50");
    expect(atUrl(FEATURE, HASH_A)).toContain(`heads=${HASH_A}`);
  });

  test("cells read as text, nested values as a summary", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(3)).toBe("3");
    expect(cellText(true)).toBe("true");
    expect(cellText("a\nb")).toBe("a b");
    expect(cellText({ json: [] })).toBe("[]");
    expect(cellText({ json: ["x", "y"] })).toBe('[2] ["x","y"]');
    expect(cellText({ json: { a: 1 } })).toBe('{1} {"a":1}');
    expect(cellText("x".repeat(100)).length).toBe(81);
  });

  test("changes and patches read as lines", () => {
    expect(changeTime(0)).toBe("—");
    expect(changeTime(1_700_000_000)).toMatch(/^2023-11-1[45] /);
    expect(patchLine({ action: "put", path: ["specs", 0, "name"], value: "Late" })).toBe('put /specs/0/name = "Late"');
    expect(patchLine({ action: "del", path: ["specs", 1], length: 2 })).toBe("del /specs/1 ×2");
    expect(patchLine({ action: "splice", path: ["body"], value: "abc" })).toBe('splice /body "abc"');
    expect(patchLine({ action: "inc", path: ["n"], value: 2 })).toBe("inc /n by 2");
  });
});

describe("JsonTree", () => {
  test("opens branches to the given depth and colours scalars", () => {
    const html = renderToStaticMarkup(<JsonTree value={{ name: "x", n: 2, ok: true, none: null, specs: [{ deep: { deeper: 1 } }] }} openDepth={2} />);
    expect(html).toContain('<span class="json-key">name</span>');
    expect(html).toContain('<span class="json-value json-string">&quot;x&quot;</span>');
    expect(html).toContain('<span class="json-value json-number">2</span>');
    expect(html).toContain('<span class="json-value json-boolean">true</span>');
    expect(html).toContain('<span class="json-value json-null">null</span>');
    // The root and `specs` are open; the object inside the array (depth 2) is closed.
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("1 key");
    expect(html).not.toContain("deeper");
    expect(renderToStaticMarkup(<JsonTree value={{ a: {} }} openDepth={1} />)).toContain("0 keys");
  });
});

/** The handlers React gave an element. */
function reactProps(el: Element): Record<string, (e: unknown) => void> {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[key]!;
}

function type(field: HTMLInputElement, value: string) {
  field.value = value;
  reactProps(field).onChange!({ target: field, currentTarget: field });
}

function click(el: Element) {
  reactProps(el).onClick!({ target: el, currentTarget: el, preventDefault() {} });
}

describe("the page", () => {
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

  test("lists the tables, sorts and filters through the server, opens a row, its document and its history", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      const u = new URL(url, "http://x");
      if (u.pathname === "/api/data/tables") return Response.json(tables);
      if (u.pathname === "/api/data/tables/documents") return Response.json({ ...specsPage(null, null, null), table: "documents" });
      if (u.pathname === "/api/data/tables/specs") return Response.json(specsPage(u.searchParams.get("q"), u.searchParams.get("sort"), u.searchParams.get("dir")));
      if (u.pathname === "/api/data/doc") return Response.json(docResponse);
      if (u.pathname === "/api/data/doc/history") return Response.json(history);
      if (u.pathname === "/api/data/doc/at") return Response.json(atB);
      return Response.json({ error: `unexpected ${url}` }, { status: 500 });
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<DataPage onClose={() => {}} fetcher={fetcher} />));
    await flush();

    // The tables with their counts, on the left; Documents opens first.
    const tabs = () => [...container.querySelectorAll('.app-page-tabs [role="tab"]')].map((t) => t.textContent);
    expect(tabs()).toEqual(["Documents · 3", "Features · 1", "Specs · 2", "Pages · 0", "Test cases · 0", "Test plans · 0", "Test executions · 0", "Event models · 0"]);
    expect(container.textContent).toContain("3 documents in the store");
    expect(calls).toContain("/api/data/tables/documents?limit=100");

    // Specs: a grid with the server's columns.
    await act(async () => click(container.querySelector("#specs-tab")!));
    await flush();
    const headers = () => [...container.querySelectorAll(".data-th")].map((th) => [th.textContent, th.getAttribute("aria-sort")]);
    expect(headers()).toEqual([
      ["feature", "none"],
      ["name", "none"],
      ["rank", "none"],
      ["tests", "none"],
    ]);
    const names = () => [...container.querySelectorAll(".data-row")].map((r) => r.querySelectorAll(".data-cell")[1]!.textContent);
    expect(names()).toEqual(["Pay on time", "Late payment"]);
    expect(container.querySelector(".data-cell-json")!.textContent).toBe('[1] ["t.ts#L3"]');
    expect(container.textContent).toContain("1–2 of 2");

    // Sorting asks the server; a second click flips the direction.
    const sortButtons = () => [...container.querySelectorAll(".data-sort")] as Element[];
    await act(async () => click(sortButtons()[2]!));
    await flush();
    expect(calls.at(-1)).toBe("/api/data/tables/specs?sort=rank&limit=100");
    await act(async () => click(sortButtons()[2]!));
    await flush();
    expect(calls.at(-1)).toBe("/api/data/tables/specs?sort=rank&dir=desc&limit=100");
    expect(headers()[2]).toEqual(["rank", "descending"]);
    expect(names()).toEqual(["Late payment", "Pay on time"]);

    // Typing settles, then the filter goes to the server.
    const filter = container.querySelector('input[aria-label="Filter rows"]') as unknown as HTMLInputElement;
    await act(async () => type(filter, "late"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
    await flush();
    expect(calls.at(-1)).toBe("/api/data/tables/specs?q=late&sort=rank&dir=desc&limit=100");
    expect(names()).toEqual(["Late payment"]);

    // A row opens as a tree in the drawer; Document and History wake up.
    expect(container.querySelector(".data-drawer")).toBeNull();
    const views = () => [...container.querySelectorAll(".data-view")].map((v) => [v.textContent, (v as HTMLButtonElement).disabled]);
    expect(views()).toEqual([
      ["Rows", false],
      ["Document", true],
      ["History", true],
    ]);
    await act(async () => click(container.querySelector(".data-row")!));
    const drawer = container.querySelector(".data-drawer")!;
    expect(drawer.querySelector(".data-drawer-title")!.textContent).toBe(`${FEATURE}#specs/s-2`);
    expect([...drawer.querySelectorAll(".json-key")].map((k) => k.textContent)).toEqual(["feature", "name", "rank", "tests"]);

    // Its document: what is on disk.
    await act(async () => click(drawer.querySelector(".data-open-doc")!));
    await flush();
    expect(calls.at(-1)).toBe(`/api/data/doc?path=${encodeURIComponent(FEATURE)}`);
    expect(views()).toEqual([
      ["Rows", false],
      ["Document", false],
      ["History", false],
    ]);
    const meta = container.querySelector(".data-meta")!.textContent!;
    expect(meta).toContain("doc-1");
    expect(meta).toContain("2 changes · 40 ops · 1 actors");
    expect(meta).toContain("snapshot-1111.bin");
    expect(meta).toContain("2.0 KB");
    expect(container.querySelector(".data-document .json-tree")!.textContent).toContain("Collect Premium");

    // Its history: newest first; a change shows the document then and its patches.
    await act(async () => click([...container.querySelectorAll(".data-view")][2]!));
    await flush();
    expect(calls.at(-1)).toBe(`/api/data/doc/history?path=${encodeURIComponent(FEATURE)}&limit=50`);
    const changes = [...container.querySelectorAll(".data-change")];
    expect(changes.map((c) => c.querySelector(".data-hash")!.textContent)).toEqual(["bbbbbbbb", "aaaaaaaa"]);
    expect(changes[0]!.textContent).toContain("Edit the body");
    expect(changes[1]!.textContent).toContain("no message");
    expect(container.textContent).toContain("Pick a change");
    await act(async () => click(changes[0]!.querySelector(".data-change-line")!));
    await flush();
    expect(calls.at(-1)).toBe(`/api/data/doc/at?path=${encodeURIComponent(FEATURE)}&heads=${HASH_B}`);
    expect(container.querySelector(".data-patches")!.textContent).toBe('splice /specs/0/body "paid"');
    expect(container.querySelector(".data-history-detail .json-tree")!.textContent).toContain("Collect Premium");

    await act(async () => root.unmount());
    container.remove();
  });

  test("counts carry thousands separators in the table list, the store and the toolbar", async () => {
    const big: TablesResponse = {
      ...tables,
      tables: tables.tables.map((t) => (t.name === "documents" ? { ...t, rows: 1431 } : t)),
      documents: 1431,
    };
    const first = specsPage(null, null, null);
    const page: TablePage = {
      ...first,
      table: "documents",
      rows: Array.from({ length: 100 }, (_, i) => ({ ...first.rows[0]!, key: `row-${i}` })),
      total: 1431,
      filtered: 1431,
    };
    const fetcher = async (url: string) => {
      const u = new URL(url, "http://x");
      if (u.pathname === "/api/data/tables") return Response.json(big);
      if (u.pathname === "/api/data/tables/documents") return Response.json(page);
      return Response.json({ error: `unexpected ${url}` }, { status: 500 });
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<DataPage onClose={() => {}} fetcher={fetcher} />));
    await flush();

    expect(container.querySelector("#documents-tab")!.textContent).toBe("Documents · 1,431");
    expect(container.textContent).toContain("1,431 documents in the store");
    expect(container.querySelector(".data-status")!.textContent).toBe("1–100 of 1,431");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234567)).toBe("1,234,567");

    await act(async () => root.unmount());
    container.remove();
  });
});

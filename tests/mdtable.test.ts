import { describe, expect, test } from "bun:test";
import {
  extractVars,
  findTable,
  replaceTable,
  serializeTable,
} from "../src/frontend/mdtable";

// specs/scenario-table.spec.md: the widget is a structured view over the
// markdown table stored in the scenario body.

describe("findTable", () => {
  test("returns null when the body has no table", () => {
    expect(findTable("- When: something\n- Then: something else")).toBeNull();
  });

  test("parses columns and rows", () => {
    const body = "- When: user enters {amount}\n\n| amount | result |\n| --- | --- |\n| 10 | ok |\n| -5 | error |";
    const t = findTable(body)!;
    expect(t.columns).toEqual(["amount", "result"]);
    expect(t.rows).toEqual([
      ["10", "ok"],
      ["-5", "error"],
    ]);
  });

  test("start/end offsets cover exactly the table block", () => {
    const body = "before\n\n| a |\n| --- |\n| 1 |\n\nafter";
    const t = findTable(body)!;
    expect(body.slice(t.start, t.end)).toBe("| a |\n| --- |\n| 1 |");
  });

  test("picks the last table when there are several", () => {
    const body = "| a |\n| --- |\n| 1 |\n\ntext\n\n| b |\n| --- |\n| 2 |";
    expect(findTable(body)!.columns).toEqual(["b"]);
  });

  test("ignores tables inside fenced code blocks", () => {
    const body = "```\n| a |\n| --- |\n| 1 |\n```";
    expect(findTable(body)).toBeNull();
  });

  test("normalizes ragged rows to the header width", () => {
    const body = "| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |";
    expect(findTable(body)!.rows).toEqual([
      ["1", ""],
      ["1", "2"],
    ]);
  });

  test("parses a header-only table", () => {
    const t = findTable("| a | b |\n| --- | --- |")!;
    expect(t.columns).toEqual(["a", "b"]);
    expect(t.rows).toEqual([]);
  });

  test("unescapes \\| inside cells", () => {
    const body = "| a |\n| --- |\n| x \\| y |";
    expect(findTable(body)!.rows).toEqual([["x | y"]]);
  });
});

describe("serializeTable", () => {
  test("pads cells for readable source", () => {
    expect(serializeTable({ columns: ["amount", "r"], rows: [["1", "ok"]] })).toBe(
      "| amount | r   |\n| ------ | --- |\n| 1      | ok  |",
    );
  });

  test("escapes pipes and round-trips", () => {
    const table = { columns: ["a"], rows: [["x | y"]] };
    const md = serializeTable(table);
    expect(md).toContain("x \\| y");
    const back = findTable(md)!;
    expect(back.rows).toEqual([["x | y"]]);
  });

  test("serializes a header-only table", () => {
    expect(serializeTable({ columns: ["a"], rows: [] })).toBe("| a   |\n| --- |");
  });
});

describe("replaceTable", () => {
  test("rewrites the existing block in place", () => {
    const body = "before\n\n| a |\n| --- |\n| 1 |\n\nafter";
    const next = replaceTable(body, { columns: ["a", "b"], rows: [["1", "2"]] });
    expect(next).toBe("before\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\nafter");
  });

  test("appends after a blank line when the body has no table", () => {
    const next = replaceTable("- When: x", { columns: ["a"], rows: [] });
    expect(next).toBe("- When: x\n\n| a   |\n| --- |");
  });

  test("becomes the whole body when the body is empty", () => {
    expect(replaceTable("", { columns: ["a"], rows: [] })).toBe("| a   |\n| --- |");
  });

  test("null removes the table block", () => {
    const body = "before\n\n| a |\n| --- |\n| 1 |\n\nafter";
    expect(replaceTable(body, null)).toBe("before\n\nafter");
  });

  test("null on a table-only body empties it", () => {
    expect(replaceTable("| a |\n| --- |", null)).toBe("");
  });
});

describe("extractVars", () => {
  test("finds {var} names in order, deduplicated", () => {
    expect(extractVars("enter {amount} in {currency}, check {amount}")).toEqual([
      "amount",
      "currency",
    ]);
  });

  test("allows letters, digits, _ and -", () => {
    expect(extractVars("{car-model_2}")).toEqual(["car-model_2"]);
    expect(extractVars("{not a var} {}")).toEqual([]);
  });

  test("ignores variables inside the table block", () => {
    const body = "uses {amount}\n\n| amount |\n| --- |\n| {other} |";
    expect(extractVars(body)).toEqual(["amount"]);
  });

  test("ignores variables inside code fences", () => {
    expect(extractVars("```\n{hidden}\n```\n{shown}")).toEqual(["shown"]);
  });
});

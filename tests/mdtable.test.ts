import { describe, expect, test } from "bun:test";
import {
  extractVars,
  findTables,
  insertTable,
  parseClip,
  pasteCells,
  replaceTableBlock,
  serializeTable,
  tableAt,
  withVarColumns,
} from "../src/frontend/mdtable";

// specs/editor/table-editor.feature.md: the table dialog is a structured
// view over the markdown tables stored in the text.

const last = (body: string) => findTables(body).at(-1) ?? null;

describe("findTables", () => {
  test("finds nothing when the body has no table", () => {
    expect(findTables("- When: something\n- Then: something else")).toEqual([]);
  });

  test("parses columns and rows", () => {
    const body = "- When: user enters {amount}\n\n| amount | result |\n| --- | --- |\n| 10 | ok |\n| -5 | error |";
    const t = last(body)!;
    expect(t.columns).toEqual(["amount", "result"]);
    expect(t.rows).toEqual([
      ["10", "ok"],
      ["-5", "error"],
    ]);
    expect(t.align).toEqual([null, null]);
  });

  test("reads the divider's alignment marks", () => {
    const t = last("| a | b | c | d |\n| :-- | :-: | --: | --- |")!;
    expect(t.align).toEqual(["left", "center", "right", null]);
  });

  test("start/end offsets cover exactly the table block", () => {
    const body = "before\n\n| a |\n| --- |\n| 1 |\n\nafter";
    const t = last(body)!;
    expect(body.slice(t.start, t.end)).toBe("| a |\n| --- |\n| 1 |");
  });

  test("finds every table, in order", () => {
    const body = "| a |\n| --- |\n| 1 |\n\ntext\n\n| b |\n| --- |\n| 2 |";
    expect(findTables(body).map((t) => t.columns)).toEqual([["a"], ["b"]]);
  });

  test("ignores tables inside fenced code blocks", () => {
    const body = "```\n| a |\n| --- |\n| 1 |\n```";
    expect(findTables(body)).toEqual([]);
  });

  test("normalizes ragged rows to the header width", () => {
    const body = "| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |";
    expect(last(body)!.rows).toEqual([
      ["1", ""],
      ["1", "2"],
    ]);
  });

  test("parses a header-only table", () => {
    const t = last("| a | b |\n| --- | --- |")!;
    expect(t.columns).toEqual(["a", "b"]);
    expect(t.rows).toEqual([]);
  });

  test("unescapes \\| inside cells", () => {
    const body = "| a |\n| --- |\n| x \\| y |";
    expect(last(body)!.rows).toEqual([["x | y"]]);
  });
});

describe("tableAt", () => {
  const body = "before\n\n| a |\n| --- |\n| 1 |\n\nafter";
  const t = last(body)!;

  test("is the table on any of its lines, from its first character to its last", () => {
    expect(tableAt(body, t.start)?.columns).toEqual(["a"]);
    expect(tableAt(body, t.start + 9)?.columns).toEqual(["a"]);
    expect(tableAt(body, t.end)?.columns).toEqual(["a"]);
  });

  test("is null in ordinary text", () => {
    expect(tableAt(body, 0)).toBeNull();
    expect(tableAt(body, body.length)).toBeNull();
  });

  test("picks the right one of several", () => {
    const two = "| a |\n| --- |\n| 1 |\n\n| b |\n| --- |\n| 2 |";
    expect(tableAt(two, 2)?.columns).toEqual(["a"]);
    expect(tableAt(two, two.length - 1)?.columns).toEqual(["b"]);
  });
});

describe("serializeTable", () => {
  test("pads cells for readable source", () => {
    expect(serializeTable({ columns: ["amount", "r"], rows: [["1", "ok"]] })).toBe(
      "| amount | r   |\n| ------ | --- |\n| 1      | ok  |",
    );
  });

  test("writes alignment into the divider", () => {
    expect(
      serializeTable({ columns: ["a", "b", "c"], align: ["left", "center", "right"], rows: [] }),
    ).toBe("| a   | b   | c   |\n| :-- | :-: | --: |");
  });

  test("escapes pipes and round-trips", () => {
    const table = { columns: ["a"], rows: [["x | y"]] };
    const md = serializeTable(table);
    expect(md).toContain("x \\| y");
    expect(last(md)!.rows).toEqual([["x | y"]]);
  });

  test("serializes a header-only table", () => {
    expect(serializeTable({ columns: ["a"], rows: [] })).toBe("| a   |\n| --- |");
  });
});

describe("replaceTableBlock", () => {
  test("rewrites the block in place, with the caret at its start", () => {
    const body = "before\n\n| a |\n| --- |\n| 1 |\n\nafter";
    const r = replaceTableBlock(body, last(body)!, { columns: ["a", "b"], rows: [["1", "2"]] });
    expect(r.text).toBe("before\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\nafter");
    expect(r.start).toBe(8);
    expect(r.end).toBe(8);
  });

  test("rewrites only the block it was given", () => {
    const body = "| a |\n| --- |\n| 1 |\n\n| b |\n| --- |\n| 2 |";
    const [first] = findTables(body);
    const r = replaceTableBlock(body, first!, { columns: ["x"], rows: [] });
    expect(r.text).toBe("| x   |\n| --- |\n\n| b |\n| --- |\n| 2 |");
  });

  test("null removes the table block, closing the gap", () => {
    const body = "before\n\n| a |\n| --- |\n| 1 |\n\nafter";
    const r = replaceTableBlock(body, last(body)!, null);
    expect(r.text).toBe("before\n\nafter");
    expect(r.start).toBe(8);
  });

  test("null on a table-only body empties it", () => {
    const body = "| a |\n| --- |";
    expect(replaceTableBlock(body, last(body)!, null).text).toBe("");
  });
});

describe("insertTable", () => {
  const table = { columns: ["a"], rows: [["1"]] };
  const md = "| a   |\n| --- |\n| 1   |";

  test("lands at the caret on a paragraph of its own, caret on the blank line after it", () => {
    const r = insertTable("one\ntwo", 3, 3, table);
    expect(r.text).toBe(`one\n\n${md}\n\ntwo`);
    expect(r.text.slice(r.start)).toBe("\ntwo");
  });

  test("uses the blank lines already around the caret", () => {
    expect(insertTable("one\n\n\n\ntwo", 5, 5, table).text).toBe(`one\n\n${md}\n\ntwo`);
  });

  test("becomes the whole text when it is empty, ending in a newline", () => {
    expect(insertTable("", 0, 0, table).text).toBe(`${md}\n`);
  });

  test("replaces the selection", () => {
    expect(insertTable("keep DROP keep", 5, 9, table).text).toBe(`keep \n\n${md}\n\n keep`);
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

  test("ignores variables inside any table", () => {
    const body = "| x |\n| --- |\n| {first} |\n\nuses {amount}\n\n| amount |\n| --- |\n| {other} |";
    expect(extractVars(body)).toEqual(["amount"]);
  });

  test("ignores variables inside code fences", () => {
    expect(extractVars("```\n{hidden}\n```\n{shown}")).toEqual(["shown"]);
  });
});

// "variable creates a column"
describe("withVarColumns", () => {
  test("a new table has a column per variable and one empty row", () => {
    expect(withVarColumns(null, ["amount", "result"])).toEqual({
      columns: ["amount", "result"],
      align: [null, null],
      rows: [["", ""]],
    });
  });

  test("a new table with no variables has one blank column", () => {
    expect(withVarColumns(null, [])).toEqual({ columns: [""], align: [null], rows: [[""]] });
  });

  test("adds the missing variable columns to an existing table", () => {
    const t = withVarColumns({ columns: ["amount"], rows: [["1"]] }, ["amount", "result"]);
    expect(t.columns).toEqual(["amount", "result"]);
    expect(t.rows).toEqual([["1", ""]]);
  });

  test("leaves a table that already has them alone", () => {
    const table = { columns: ["amount"], rows: [["1"]] };
    expect(withVarColumns(table, ["amount"])).toBe(table);
  });
});

describe("pasting a block", () => {
  test("a single value is not a block", () => {
    expect(parseClip("hello")).toBeNull();
    expect(parseClip("hello\n")).toBeNull();
  });

  test("tabs and newlines make cells and rows", () => {
    expect(parseClip("a\tb\r\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("fills the grid from the cell on, growing it as needed", () => {
    const t = pasteCells({ columns: ["x"], rows: [["1"]] }, 0, 0, [
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(t.columns).toEqual(["x", ""]);
    expect(t.rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("pasted into the header, the first row names the columns", () => {
    const t = pasteCells({ columns: ["x"], rows: [] }, -1, 0, [
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(t.columns).toEqual(["a", "b"]);
    expect(t.rows).toEqual([["1", "2"]]);
  });
});

// Automates specs/editor/table-editor.feature.md: a table button in the
// editor toolbar opens a modal dialog over the markdown table the caret is
// in, or a blank one to insert; the editable preview offers the same dialog
// on each table it renders.
//
// React needs a DOM to run the dialog; this file borrows one from happy-dom
// the way tests/commonEditor.test.tsx does.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorView } from "@codemirror/view";
import { MarkdownEditor } from "../src/frontend/MarkdownEditor";
import { renderMarkdown } from "../src/frontend/markdown";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const TABLE = "| amount | result |\n| --- | --- |\n| 10 | ok |";

describe("the toolbar's table button", () => {
  const write = (value: string) => html(<MarkdownEditor value={value} onChange={() => {}} />);

  test("inserts a table with the caret in ordinary text", () => {
    const markup = write("Given a policy\n");
    expect(markup).toContain('aria-label="Insert table"');
    expect(markup).not.toContain('aria-label="Edit table"');
  });

  test("edits the table the caret is in", () => {
    // The caret starts at 0: the first character of the table.
    const markup = write(`${TABLE}\n`);
    expect(markup).toContain('aria-label="Edit table"');
    expect(markup).not.toContain('aria-label="Insert table"');
  });

  test("is not offered on a read-only body", () => {
    const markup = html(<MarkdownEditor value={TABLE} onChange={() => {}} readOnly />);
    expect(markup).not.toContain("Insert table");
    expect(markup).not.toContain("Edit table");
  });
});

describe("a table in the preview", () => {
  const preview = (value: string, readOnly = false) =>
    html(<MarkdownEditor value={value} onChange={() => {}} readOnly={readOnly} initialTab="preview" />);

  test("carries an edit button in the editable preview", () => {
    const markup = preview(TABLE);
    expect(markup).toContain('aria-label="Edit table 1"');
    expect(markup).toContain('class="md-table"');
  });

  test("carries none on a published (read-only) body, and renders as before", () => {
    const markup = preview(TABLE, true);
    expect(markup).not.toContain("Edit table");
    expect(markup).toContain("<table>");
    expect(markup).not.toContain("md-table");
  });

  test("is numbered in text order", () => {
    expect(preview(`${TABLE}\n\n| b |\n| --- |\n| 2 |`)).toContain('aria-label="Edit table 2"');
  });

  test("is aligned as the divider says", () => {
    const markup = html(<>{renderMarkdown("| a | b |\n| :-: | --: |\n| 1 | 2 |")}</>);
    expect(markup).toContain('<th style="text-align:center">a</th>');
    expect(markup).toContain('<td style="text-align:right">2</td>');
  });
});

// ---- The dialog, in a DOM ----

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/" });
  const w = happyWindow as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (w[key] ?? w.window);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

describe("the table dialog", () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;
  let text = "";
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (async () => new Response("[]")) as unknown as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    globalThis.fetch = realFetch;
  });

  function Editor({ initial, variables = false }: { initial: string; variables?: boolean }) {
    const [value, setValue] = useState(initial);
    text = value;
    return (
      <MarkdownEditor value={value} onChange={setValue} initialTab="write" tableVariables={variables} />
    );
  }

  async function mount(initial: string, variables = false) {
    root = createRoot(host!);
    await act(async () => root!.render(<Editor initial={initial} variables={variables} />));
    return source();
  }

  /** The Write tab's CodeMirror editor. */
  const source = () => EditorView.findFromDOM(host!.querySelector<HTMLElement>(".cm-editor")!)!;

  const button = (label: string) =>
    host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const click = (label: string) => {
    const b = button(label);
    if (!b) throw new Error(`no button "${label}"`);
    act(() => b.click());
  };
  const dialog = () => host!.querySelector<HTMLElement>('[role="dialog"]');
  const cell = (r: number, c: number) =>
    host!.querySelector<HTMLInputElement>(`input[data-cell="${r},${c}"]`)!;
  /**
   * Type `value` into a controlled input, as React hears it here: the value
   * set under its tracker, then a key going up in the focused field.
   */
  const type = (input: HTMLInputElement, value: string) =>
    act(() => {
      input.focus();
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      set.call(input, value);
      input.dispatchEvent(
        new window.KeyboardEvent("keyup", { key: "a", bubbles: true }) as unknown as Event,
      );
    });
  const press = (el: Element, key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      el.dispatchEvent(
        new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }) as unknown as Event,
      );
    });
  /** Place the caret as a click would; the editor tells the toolbar where it landed. */
  const caretTo = (view: EditorView, at: number) =>
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: at } });
    });

  // "edit the table as a grid"
  test("opens on the table at the caret and saves the edited grid into it", async () => {
    const view = await mount(`before\n\n${TABLE}\n\nafter`);
    caretTo(view, 12);
    click("Edit table");
    expect(dialog()?.getAttribute("aria-label")).toBe("Edit table");
    expect(cell(-1, 0).value).toBe("amount");
    expect(cell(0, 1).value).toBe("ok");
    type(cell(0, 1), "fine");
    click("Add row");
    type(cell(1, 0), "20");
    const save = [...host!.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    act(() => save.click());
    expect(dialog()).toBeNull();
    expect(text).toBe(
      "before\n\n| amount | result |\n| ------ | ------ |\n| 10     | fine   |\n| 20     |        |\n\nafter",
    );
  });

  test("cancels without touching the text", async () => {
    await mount(TABLE);
    click("Edit table");
    type(cell(0, 0), "99");
    // Changed, so Cancel asks first; Discard confirms.
    const cancel = [...host!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => cancel.click());
    const discard = [...host!.querySelectorAll("button")].find((b) => b.textContent === "Discard")!;
    await act(async () => discard.click());
    expect(dialog()).toBeNull();
    expect(text).toBe(TABLE);
  });

  test("Escape with nothing changed closes it outright", async () => {
    await mount(TABLE);
    click("Edit table");
    press(cell(0, 0), "Escape");
    await act(async () => {});
    expect(dialog()).toBeNull();
    expect(text).toBe(TABLE);
  });

  test("an Escape with focus outside the dialog is still the dialog's", async () => {
    await mount(TABLE);
    click("Edit table");
    // Focus lands on the body when what had it goes away.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    press(document.body, "Escape");
    await act(async () => {});
    expect(dialog()).toBeNull();
    expect(host!.querySelector(".cm-editor")).not.toBeNull();
  });

  test("removing a column moves focus to the one before it", async () => {
    await mount("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
    click("Edit table");
    click("Remove column c");
    expect(document.activeElement).toBe(cell(-1, 1));
  });

  test("Save is disabled until something changes", async () => {
    await mount(TABLE);
    click("Edit table");
    const save = [...host!.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    expect(save.disabled).toBe(true);
    type(cell(0, 0), "11");
    expect(save.disabled).toBe(false);
  });

  test("removes and reorders columns, and aligns them", async () => {
    await mount("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
    click("Edit table");
    click("Remove column b");
    click("Move column c left");
    click("Alignment of column c: default");
    press(host!.querySelector(".table-dialog")!, "Enter", { metaKey: true });
    expect(text).toBe("| c   | a   |\n| :-- | --- |\n| 3   | 1   |");
  });

  test("the last column cannot be removed; Delete table takes the table out", async () => {
    await mount(`before\n\n| a |\n| --- |\n| 1 |\n\nafter`);
    caretTo(source(), 10);
    click("Edit table");
    expect(button("Remove column a")?.disabled).toBe(true);
    const del = [...host!.querySelectorAll("button")].find((b) => b.textContent === "Delete table")!;
    await act(async () => del.click());
    const confirm = [...host!.querySelectorAll("button")].find((b) => b.textContent === "Delete")!;
    await act(async () => confirm.click());
    expect(text).toBe("before\n\nafter");
  });

  // "insert a table at the caret"
  test("inserts a new table at the caret", async () => {
    const ta = await mount("one\ntwo");
    caretTo(ta, 3);
    click("Insert table");
    expect(dialog()?.getAttribute("aria-label")).toBe("Insert table");
    type(cell(-1, 0), "n");
    click("Add column");
    type(cell(-1, 1), "m");
    type(cell(0, 0), "1");
    type(cell(0, 1), "2");
    const insert = [...host!.querySelectorAll("button")].find((b) => b.textContent === "Insert")!;
    act(() => insert.click());
    expect(text).toBe("one\n\n| n   | m   |\n| --- | --- |\n| 1   | 2   |\n\ntwo");
  });

  test("Enter in the last row adds one below", async () => {
    await mount(TABLE);
    click("Edit table");
    press(cell(0, 0), "Enter");
    expect(cell(1, 0)).not.toBeNull();
    expect(host!.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  test("fills the grid from a pasted block", async () => {
    await mount(TABLE);
    click("Edit table");
    act(() => {
      const e = new window.Event("paste", { bubbles: true, cancelable: true }) as unknown as Event & {
        clipboardData: { getData: (t: string) => string };
      };
      e.clipboardData = { getData: () => "a\tb\tc\nd\te\tf" };
      cell(0, 0).dispatchEvent(e);
    });
    expect(cell(0, 2).value).toBe("c");
    expect(cell(1, 1).value).toBe("e");
    expect(cell(-1, 2).value).toBe("");
  });

  // "variable creates a column"
  describe("with variables", () => {
    test("a new table opens with a column per {var}, locked", async () => {
      const view = await mount("enter {amount} and see {result}\n", true);
      caretTo(view, view.state.doc.length);
      click("Insert table");
      expect(cell(-1, 0).value).toBe("amount");
      expect(cell(-1, 1).value).toBe("result");
      expect(cell(-1, 0).readOnly).toBe(true);
      expect(button("Remove column amount")?.disabled).toBe(true);
    });

    test("an existing table gains the missing column", async () => {
      await mount(`uses {amount} and {other}\n\n${TABLE}`, true);
      caretTo(source(), 30);
      click("Edit table");
      expect([...host!.querySelectorAll('thead input')].map((i) => (i as HTMLInputElement).value)).toEqual([
        "amount",
        "result",
        "other",
      ]);
      // Only the variables' columns are locked.
      expect(cell(-1, 1).readOnly).toBe(false);
    });

    test("outside the scenario body, variables mean nothing", async () => {
      await mount("enter {amount}\n");
      click("Insert table");
      expect(cell(-1, 0).value).toBe("");
      expect(cell(-1, 0).readOnly).toBe(false);
    });
  });
});

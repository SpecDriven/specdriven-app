// specs/editor/common-editor.feature.md "Spell check", in the desktop app:
// a right-click on a misspelt word offers the checker's suggestions and a
// way to teach it the word (src/electron/contextMenu.ts). Electron shows no
// menu on its own, so the same menu carries the edit verbs in any field and
// Copy over a selection; anywhere else there is nothing, and no menu.
import { describe, expect, test } from "bun:test";
import {
  MAX_SUGGESTIONS,
  contextMenuTemplate,
  type ContextMenuInput,
} from "../src/electron/contextMenu";

const noWord: ContextMenuInput = {
  misspelledWord: "",
  dictionarySuggestions: [],
  isEditable: false,
  selectionText: "",
};

function build(input: Partial<ContextMenuInput>) {
  const calls: string[] = [];
  const template = contextMenuTemplate(
    { ...noWord, ...input },
    {
      replaceMisspelling: (w) => calls.push(`replace:${w}`),
      addToDictionary: (w) => calls.push(`learn:${w}`),
    },
  );
  const labels = (template ?? []).map((i) => i.label ?? i.role ?? i.type);
  return { template, labels, calls };
}

describe("the right-click menu over a misspelt word", () => {
  test("leads with the suggestions, which replace the word when picked", () => {
    const { template, labels, calls } = build({
      misspelledWord: "polcy",
      dictionarySuggestions: ["policy", "poly"],
      isEditable: true,
    });
    expect(labels).toEqual([
      "policy",
      "poly",
      "separator",
      "Add “polcy” to Dictionary",
      "separator",
      "cut",
      "copy",
      "paste",
      "separator",
      "selectAll",
    ]);
    (template![0]!.click as () => void)();
    (template![3]!.click as () => void)();
    expect(calls).toEqual(["replace:policy", "learn:polcy"]);
  });

  test("says so when the checker has no guess, and still offers to learn the word", () => {
    const { template, labels } = build({ misspelledWord: "specdriven", isEditable: true });
    expect(labels.slice(0, 4)).toEqual([
      "No guesses found",
      "separator",
      "Add “specdriven” to Dictionary",
      "separator",
    ]);
    expect(template![0]!.enabled).toBe(false);
  });

  test("shows the checker's first few guesses only", () => {
    const many = Array.from({ length: MAX_SUGGESTIONS + 3 }, (_, i) => `guess${i}`);
    const { labels } = build({ misspelledWord: "x", dictionarySuggestions: many, isEditable: true });
    expect(labels.slice(0, MAX_SUGGESTIONS)).toEqual(many.slice(0, MAX_SUGGESTIONS));
    expect(labels[MAX_SUGGESTIONS]).toBe("separator");
  });
});

describe("the right-click menu elsewhere", () => {
  test("has the edit verbs in any editable field", () => {
    const { labels } = build({ isEditable: true });
    expect(labels).toEqual(["cut", "copy", "paste", "separator", "selectAll"]);
  });

  test("offers Copy over a selection in the text", () => {
    expect(build({ selectionText: "Given a policy" }).labels).toEqual(["copy"]);
  });

  test("is nothing over plain text, or a selection of only whitespace", () => {
    expect(build({}).template).toBeNull();
    expect(build({ selectionText: "  \n" }).template).toBeNull();
  });
});

// Automates specs/editor/data-model-integration-in-editor.feature.md on
// the editor's side: the `@…` run the caret ends is what gets completed,
// the list is searchable by what follows the `@`, and picking a choice
// replaces that run and leaves the caret after it.

import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownEditor } from "../src/frontend/MarkdownEditor";
import { atQuery, filterChoices, insertChoice } from "../src/frontend/entityFields";
import type { FieldChoice } from "../src/frontend/entityFields";

const choice = (label: string, entity: string, field: string): FieldChoice => ({
  label,
  insert: label,
  entity,
  field,
  file: "db/schema.cds",
});

const CHOICES = [
  choice("@amount", "Claim", "amount"),
  choice("@Claim.email", "Claim", "email"),
  choice("@firstName", "Customer", "firstName"),
  choice("@lastName", "Customer", "lastName"),
  choice("@User.email", "User", "email"),
];

describe("atQuery", () => {
  test("finds the @ run the caret ends, with what was typed after the @", () => {
    expect(atQuery("Given @Fi", 9)).toEqual({ start: 6, query: "Fi" });
    expect(atQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(atQuery("see @User.fi", 12)).toEqual({ start: 4, query: "User.fi" });
    expect(atQuery("line one\n@x", 11)).toEqual({ start: 9, query: "x" });
  });

  test("looks only before the caret", () => {
    expect(atQuery("@first tail", 6)).toEqual({ start: 0, query: "first" });
    expect(atQuery("@first tail", 3)).toEqual({ start: 0, query: "fi" });
  });

  test("is nothing for an email address, a doubled @, or a run the caret has left", () => {
    expect(atQuery("dana@acme", 9)).toBeNull();
    expect(atQuery("@@x", 3)).toBeNull();
    expect(atQuery("@Foo ", 5)).toBeNull();
    expect(atQuery("plain text", 10)).toBeNull();
    expect(atQuery("", 0)).toBeNull();
  });
});

describe("filterChoices", () => {
  test("offers everything, in order, when nothing was typed yet", () => {
    expect(filterChoices(CHOICES, "").map((c) => c.label)).toEqual(CHOICES.map((c) => c.label));
  });

  test("matches case-insensitively, prefixes before mere mentions", () => {
    expect(filterChoices(CHOICES, "em").map((c) => c.label)).toEqual(["@Claim.email", "@User.email"]);
    expect(filterChoices(CHOICES, "NAME").map((c) => c.label)).toEqual(["@firstName", "@lastName"]);
    expect(filterChoices(CHOICES, "cl").map((c) => c.label)).toEqual(["@Claim.email", "@amount"]);
  });

  test("matches the entity name of a prefixed choice", () => {
    expect(filterChoices(CHOICES, "user").map((c) => c.label)).toEqual(["@User.email"]);
    expect(filterChoices(CHOICES, "User.em").map((c) => c.label)).toEqual(["@User.email"]);
  });

  test("offers nothing for a query nothing matches, and at most the limit", () => {
    expect(filterChoices(CHOICES, "zzz")).toEqual([]);
    expect(filterChoices(CHOICES, "", 2).map((c) => c.label)).toEqual(["@amount", "@Claim.email"]);
  });
});

describe("insertChoice", () => {
  test("replaces the @ run with the choice and puts the caret after it", () => {
    const r = insertChoice("Given @fi is set", 6, 9, CHOICES[2]!);
    expect(r).toEqual({ text: "Given @firstName is set", start: 16, end: 16 });
  });

  test("replaces a bare @ too", () => {
    expect(insertChoice("@", 0, 1, CHOICES[0]!)).toEqual({ text: "@amount", start: 7, end: 7 });
  });
});

// The editor's shell (specs/editor/data-model-integration-in-editor
// .feature.md): the list is not there until Tab opens it, and a read-only
// body — nothing to complete — has no source pane to complete in until its
// Source tab is opened. CodeMirror needs a browser; the markup is what can
// be checked here.
describe("MarkdownEditor shell", () => {
  const g = globalThis as { localStorage?: Storage };
  const html = (el: React.ReactElement) => renderToStaticMarkup(el);

  test("shows no field list before Tab is pressed, even with an @ in the text", () => {
    const saved = g.localStorage;
    delete g.localStorage;
    try {
      const markup = html(<MarkdownEditor value="Given @" onChange={() => {}} />);
      expect(markup).toContain('class="md-source"');
      expect(markup).not.toContain("cm-tooltip-autocomplete");
      expect(markup).not.toContain('role="listbox"');
    } finally {
      if (saved !== undefined) g.localStorage = saved;
    }
  });

  test("a read-only body opens rendered, with no pane to complete in", () => {
    const markup = html(<MarkdownEditor value="Given @" onChange={() => {}} readOnly initialTab="preview" />);
    expect(markup).not.toContain("md-source");
    expect(markup).toContain("md-preview");
  });
});

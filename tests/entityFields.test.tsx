// Automates specs/editor/data-model-integration-in-editor.feature.md on
// the editor's side: the `@…` run the caret ends is what gets completed,
// the list is searchable by what follows the `@`, and picking a choice
// replaces that run and leaves the caret after it.

import { test, expect, describe } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownEditor } from "../src/frontend/MarkdownEditor";
import { atQuery, filterChoices, insertChoice } from "../src/frontend/entityFields";
import type { FieldChoice } from "../src/frontend/entityFields";
import { anchorVisible, placePopup } from "../src/frontend/caretPosition";

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

// Where the list lands (specs/editor/data-model-integration-in-editor
// .feature.md): next to the `@` it completes, not in a corner of the pane.
// Measuring the `@` itself needs a layout engine and is checked in the
// browser; the rule applied to that measurement is pure and checked here.
describe("placePopup", () => {
  const pane = { width: 600, height: 400 };
  const popup = { width: 200, height: 100 };
  // A `@` on an early line, with room below it.
  const high = { left: 40, top: 20, bottom: 36 };

  test("puts the top-left corner just below the anchored character", () => {
    const p = placePopup({ anchor: high, pane, popup, gap: 4 });
    expect(p).toEqual({ left: 40, top: 40, flipped: false });
  });

  test("flips above when the list would overflow the pane's bottom", () => {
    // A `@` near the bottom: 100 tall below 380 would run off a 400 pane.
    const low = { left: 40, top: 360, bottom: 376 };
    const p = placePopup({ anchor: low, pane, popup, gap: 4 });
    expect(p.flipped).toBe(true);
    // Its bottom sits just above the character's line, so it never covers it.
    expect(p.top + popup.height).toBe(low.top - 4);
    expect(p.left).toBe(40);
  });

  test("keeps a list opened near the right edge inside the pane", () => {
    const p = placePopup({ anchor: { ...high, left: 560 }, pane, popup, margin: 4 });
    expect(p.left).toBe(pane.width - 4 - popup.width);
  });

  test("says when the anchored character has scrolled out of the pane", () => {
    const pane = { height: 400 };
    expect(anchorVisible(high, pane)).toBe(true);
    // Scrolled off the top: the line is above the pane entirely.
    expect(anchorVisible({ left: 40, top: -36, bottom: -20 }, pane)).toBe(false);
    // Scrolled off the bottom.
    expect(anchorVisible({ left: 40, top: 404, bottom: 420 }, pane)).toBe(false);
    // Half-visible at an edge still counts as something to point at.
    expect(anchorVisible({ left: 40, top: -8, bottom: 8 }, pane)).toBe(true);
  });

  test("with room in neither direction, stays below and is pulled into the pane", () => {
    // A tall list on a short pane: above would overflow the top too.
    const tall = { width: 200, height: 380 };
    const p = placePopup({ anchor: { left: 10, top: 180, bottom: 196 }, pane, popup: tall });
    expect(p.flipped).toBe(false);
    expect(p.top).toBe(pane.height - 4 - tall.height);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });
});

// The editor's shell (specs/editor/data-model-integration-in-editor
// .feature.md): the list is not there until Tab opens it, and a read-only
// body — nothing to complete — does not present itself as completable.
// CodeMirror and the textarea's keys need a browser; the markup is what
// can be checked here.
describe("MarkdownEditor shell", () => {
  const g = globalThis as { localStorage?: Storage };
  const html = (el: React.ReactElement) => renderToStaticMarkup(el);

  test("shows no field list before Tab is pressed, even with an @ in the text", () => {
    const saved = g.localStorage;
    delete g.localStorage;
    try {
      const markup = html(<MarkdownEditor value="Given @" onChange={() => {}} />);
      expect(markup).not.toContain("md-complete");
      expect(markup).not.toContain('role="listbox"');
      expect(markup).toContain('aria-autocomplete="list"');
    } finally {
      if (saved !== undefined) g.localStorage = saved;
    }
  });

  test("a read-only body is not completable", () => {
    const markup = html(<MarkdownEditor value="Given @" onChange={() => {}} readOnly initialTab="preview" />);
    expect(markup).not.toContain("aria-autocomplete");
  });
});

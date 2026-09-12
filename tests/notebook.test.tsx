// The notebook tab's list (src/frontend/notebook.tsx): entries grouped by the
// month they were written in, each with the chip that says what kind it is.
// Static markup only — specs/app/engineering-notebook.feature.md "The
// notebook is a sidebar tab".
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PageListing } from "../src/server/pages";
import { EntryKindChip, dayOf, entryGroups, entryKindOf, monthOf } from "../src/frontend/notebook";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const entry = (over: Partial<PageListing> & { fileName: string }): PageListing => ({
  name: "An entry",
  ...over,
});

describe("entryKindOf", () => {
  test("a decision is a decision; anything else reads as an observation", () => {
    expect(entryKindOf(entry({ fileName: "notebook/a.md", kind: "Decision" }))).toBe("Decision");
    expect(entryKindOf(entry({ fileName: "notebook/a.md", kind: "Observation" }))).toBe(
      "Observation",
    );
    // A file dropped into the folder by hand carries no kind at all.
    expect(entryKindOf(entry({ fileName: "notebook/a.md" }))).toBe("Observation");
  });
});

describe("EntryKindChip", () => {
  test("names the kind and carries its own class", () => {
    const observation = html(<EntryKindChip kind="Observation" />);
    expect(observation).toContain("Observation");
    expect(observation).toContain('class="entry-kind entry-kind-observation"');

    const decision = html(<EntryKindChip kind="Decision" />);
    expect(decision).toContain("Decision");
    expect(decision).toContain('class="entry-kind entry-kind-decision"');
    // The two chips differ by more than their words: each has its own icon.
    expect(decision).not.toBe(observation.replace(/Observation/g, "Decision"));
  });
});

describe("monthOf and dayOf", () => {
  test("a date reads as its month and its day", () => {
    expect(monthOf("2026-09-12")).toBe("September 2026");
    expect(monthOf("2026-01-05")).toBe("January 2026");
    expect(dayOf("2026-09-12")).toBe("12");
    // The day loses its leading zero; the month heading keeps the year.
    expect(dayOf("2026-01-05")).toBe("5");
  });

  test("no date, or a date that makes no sense, is Undated", () => {
    expect(monthOf(undefined)).toBe("Undated");
    expect(monthOf("2026-13-01")).toBe("Undated");
    expect(dayOf(undefined)).toBe("");
  });
});

describe("entryGroups", () => {
  test("groups by month, newest month first, order within kept", () => {
    const groups = entryGroups([
      entry({ fileName: "notebook/d.md", name: "Newest", date: "2026-09-12" }),
      entry({ fileName: "notebook/c.md", name: "Also September", date: "2026-09-01" }),
      entry({ fileName: "notebook/b.md", name: "August", date: "2026-08-30" }),
    ]);
    expect(groups.map((g) => g.dir)).toEqual(["September 2026", "August 2026"]);
    expect(groups[0]!.pages.map((p) => p.name)).toEqual(["Newest", "Also September"]);
    expect(groups[1]!.pages.map((p) => p.name)).toEqual(["August"]);
  });

  test("undated entries come last rather than disappearing", () => {
    const groups = entryGroups([
      entry({ fileName: "notebook/a.md", name: "By hand" }),
      entry({ fileName: "notebook/b.md", name: "Dated", date: "2026-09-12" }),
    ]);
    expect(groups.map((g) => g.dir)).toEqual(["September 2026", "Undated"]);
    expect(groups[1]!.pages.map((p) => p.name)).toEqual(["By hand"]);
  });

  test("an empty notebook has no groups", () => {
    expect(entryGroups([])).toEqual([]);
  });
});

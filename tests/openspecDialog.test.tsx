// specs/external-links/openspec-import.feature.md as static markup: the
// dialog (where it reads from, the capabilities as a checklist, Import), the
// checklist with what is already imported greyed out, and the line an import
// is summed up in. App.tsx owns the open state and the menu entries.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  importSummary,
  initialSelection,
  OpenSpecImportDialog,
  OpenSpecSpecList,
  type OpenSpecSpec,
} from "../src/frontend/OpenSpecImportDialog";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};

const spec = (capability: string, extra: Partial<OpenSpecSpec> = {}): OpenSpecSpec => ({
  capability,
  path: `openspec/specs/${capability}/spec.md`,
  name: capability.charAt(0).toUpperCase() + capability.slice(1),
  fileName: `specs/${capability}.feature.md`,
  exists: false,
  requirements: 2,
  scenarios: 3,
  ...extra,
});

describe("OpenSpecImportDialog", () => {
  test("a modal dialog that says where the features land and that changes are not imported", () => {
    const markup = html(<OpenSpecImportDialog folder="billing" onImported={noop} onClose={noop} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Import from OpenSpec");
    expect(markup).toContain("in <strong>billing</strong>");
    expect(markup).toContain("<code>openspec/changes</code> are not imported");
    expect(markup).toContain('aria-label="Repository"');
    expect(markup).toContain("Looking for specs…");
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Import<\/button>/);
    expect(html(<OpenSpecImportDialog folder={null} onImported={noop} onClose={noop} />)).toContain("at the top level");
  });
});

describe("OpenSpecSpecList", () => {
  test("each capability with its counts; one already imported, or unreadable, cannot be ticked", () => {
    const specs = [
      spec("auth"),
      spec("payments", { exists: true, fileName: "specs/payments.feature.md" }),
      spec("broken", { error: "openspec/specs/broken/spec.md is a binary file" }),
    ];
    const selected = initialSelection(specs);
    expect([...selected]).toEqual(["auth"]);
    const markup = html(<OpenSpecSpecList specs={specs} selected={selected} onToggle={noop} />);
    expect(markup).toContain('aria-label="Import auth"');
    expect(markup).toContain("2 requirements, 3 scenarios");
    expect(markup).toContain("already imported as specs/payments.feature.md");
    expect(markup).toContain("is a binary file");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup.match(/checked=""/g)).toHaveLength(1);
  });
});

describe("importSummary", () => {
  test("what was written, what was there already, and what failed, in one line", () => {
    expect(
      importSummary({
        created: [{ capability: "auth", fileName: "specs/auth.feature.md", title: "Auth", scenarios: 1 }],
        skipped: [],
        failed: [],
      }),
    ).toBe("Imported “Auth” with 1 scenario");
    expect(
      importSummary({
        created: [
          { capability: "a", fileName: "a", title: "A", scenarios: 2 },
          { capability: "b", fileName: "b", title: "B", scenarios: 3 },
        ],
        skipped: [{ capability: "c", fileName: "c" }],
        failed: [{ capability: "d", error: "boom" }],
      }),
    ).toBe("Imported 2 features with 5 scenarios · 1 spec already imported · 1 not imported: d (boom)");
    expect(importSummary({ created: [], skipped: [], failed: [] })).toBe("Nothing imported");
  });
});

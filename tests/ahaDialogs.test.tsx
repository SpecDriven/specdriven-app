// specs/external-links/aha-import.feature.md "Import a feature by its url"
// and "An Aha! API key is kept per site on this device" as static markup:
// the dialog (the feature's url, what comes along, Import) and the Settings
// → Aha! form (the sites with a key, and how to add one). App.tsx owns the
// open state, the menu entries and the button.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AhaImportDialog, importUrlProblem } from "../src/frontend/AhaImportDialog";
import { AhaTokens } from "../src/frontend/AhaToken";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};
const SITE = { base: "https://acme.aha.io", user: "Pat Example" };
const OTHER = { base: "https://other.aha.io", user: "Sam" };
const URL = "https://acme.aha.io/features/APP-123";

describe("AhaImportDialog", () => {
  test("a modal dialog with the feature url, the two scopes and Import", () => {
    const markup = html(<AhaImportDialog folder="billing" sites={[SITE]} onImported={noop} onClose={noop} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Import from Aha!");
    expect(markup).toContain("in <strong>billing</strong>");
    expect(markup).toContain('aria-label="Aha! feature url"');
    expect(markup).toContain('placeholder="https://acme.aha.io/features/APP-123"');
    expect(markup).toContain('aria-label="Requirements as scenarios"');
    expect(markup).toContain('aria-label="Description only"');
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Import<\/button>/);
    expect(html(<AhaImportDialog folder={null} sites={[SITE]} onImported={noop} onClose={noop} />)).toContain(
      "at the top level",
    );
  });

  test("Import waits for a feature url on a site with a key, and says what is missing", () => {
    expect(importUrlProblem(URL, "", [SITE])).toBeNull();
    expect(importUrlProblem("app-123", SITE.base, [SITE])).toBeNull();
    expect(importUrlProblem("", "", [SITE])).toContain("Paste the url");
    expect(importUrlProblem("https://acme.aha.io/epics/APP-E-1", "", [SITE])).toBe(
      "Only an Aha! feature can be imported for now; APP-E-1 is an epic.",
    );
    expect(importUrlProblem("Basic Quote", SITE.base, [SITE])).toContain("Not an Aha! feature url");
    expect(importUrlProblem("APP-123", "", [])).toBe("No Aha! API key on this device — add one in Settings → Aha!.");
    expect(importUrlProblem("https://other.aha.io/features/APP-1", "", [SITE])).toBe(
      "No API key for https://other.aha.io — add one in Settings → Aha!.",
    );
  });

  test("a site to read a bare reference number against is offered only with several keys", () => {
    const one = html(<AhaImportDialog folder={null} sites={[SITE]} onImported={noop} onClose={noop} />);
    expect(one).not.toContain('aria-label="Aha! site"');
    // The select shows once a bare reference is typed; the markup cannot type, so
    // the static render only proves the field is absent at rest with two sites too.
    const two = html(<AhaImportDialog folder={null} sites={[SITE, OTHER]} onImported={noop} onClose={noop} />);
    expect(two).not.toContain('aria-label="Aha! site"');
  });
});

describe("AhaTokens", () => {
  test("lists each site with who its key signs in as, never the key, each with Remove", () => {
    const markup = html(<AhaTokens sites={[SITE]} onChange={noop} />);
    expect(markup).toContain("<strong>https://acme.aha.io</strong>");
    expect(markup).toContain("as Pat Example");
    expect(markup).toContain('aria-label="Remove the key for https://acme.aha.io"');
    expect(markup).toContain("Add another Aha! site");
  });

  test("offers the url and key fields, the key as a password", () => {
    const markup = html(<AhaTokens sites={[]} onChange={noop} />);
    expect(markup).toContain("Add an Aha! site");
    expect(markup).toContain('aria-label="Aha! url"');
    expect(markup).toMatch(/aria-label="Aha! API key" type="password"/);
    expect(markup).toContain("kept on this device only");
    expect(markup).toContain("Developer → API keys");
  });
});

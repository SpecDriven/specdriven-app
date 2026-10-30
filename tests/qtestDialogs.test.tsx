// specs/external-links/qtest-test-cases.feature.md "Create qTest test cases
// from a feature" and "A qTest token is kept per site on this device" as
// static markup: the dialog (the parent module, which scenarios go in,
// Create test cases) and the Settings → qTest form (the sites with a token,
// and how to add one). App.tsx owns the open state, the menu entry and the
// chips.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QtestPublishDialog, parentModuleProblem } from "../src/frontend/QtestPublishDialog";
import { QtestTokens } from "../src/frontend/QtestToken";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};
const SITE = { base: "https://acme.qtestnet.com", user: "3 projects" };
const PARENT = "https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=0&id=901";

describe("QtestPublishDialog", () => {
  test("a modal dialog with the parent module url, the two scopes and Create test cases", () => {
    const markup = html(
      <QtestPublishDialog
        file="specs/quote.feature.md"
        featureName="Quote Policy"
        initialParentUrl={PARENT}
        sites={[SITE]}
        onPublished={noop}
        onClose={noop}
      />,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Create qTest test cases");
    expect(markup).toContain("<strong>Quote Policy</strong>");
    expect(markup).toContain('aria-label="Parent module url"');
    expect(markup).toContain(`value="${PARENT.replace(/&/g, "&amp;")}"`);
    expect(markup).toContain('aria-label="All scenarios"');
    expect(markup).toContain('aria-label="Published scenarios only"');
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary">Create test cases<\/button>/);
  });

  test("a feature whose test cases were created before says creating them again updates its module", () => {
    const markup = html(
      <QtestPublishDialog
        file="f"
        featureName="F"
        linkedUrl="https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=0&id=66"
        initialParentUrl={PARENT}
        sites={[SITE]}
        onPublished={noop}
        onClose={noop}
      />,
    );
    expect(markup).toContain("creating them again updates");
    expect(markup).toContain('href="https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&amp;object=0&amp;id=66"');
  });

  test("Create waits for a module url on a site with a token, and says what is missing", () => {
    expect(parentModuleProblem(PARENT, [SITE])).toBeNull();
    expect(parentModuleProblem("", [SITE])).toContain("Paste the url");
    expect(parentModuleProblem("https://acme.qtestnet.com/p/12/portal/project#object=1&id=5", [SITE])).toContain(
      "Not a qTest module url",
    );
    expect(parentModuleProblem("https://other.qtestnet.com/p/1/portal/project#object=0&id=1", [SITE])).toBe(
      "No token for https://other.qtestnet.com — add one in Settings → qTest.",
    );
    const markup = html(
      <QtestPublishDialog file="f" featureName="F" initialParentUrl={PARENT} sites={[]} onPublished={noop} onClose={noop} />,
    );
    expect(markup).toContain("No token for https://acme.qtestnet.com");
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Create test cases<\/button>/);
  });
});

describe("QtestTokens", () => {
  test("lists each site with what its token reaches, never the token, each with Remove", () => {
    const markup = html(<QtestTokens sites={[SITE]} onChange={noop} />);
    expect(markup).toContain("<strong>https://acme.qtestnet.com</strong>");
    expect(markup).toContain("3 projects");
    expect(markup).toContain('aria-label="Remove the token for https://acme.qtestnet.com"');
    expect(markup).toContain("Add another qTest site");
  });

  test("offers the url and token fields, the token as a password", () => {
    const markup = html(<QtestTokens sites={[]} onChange={noop} />);
    expect(markup).toContain("Add a qTest site");
    expect(markup).toContain('aria-label="qTest url"');
    expect(markup).toMatch(/aria-label="qTest Bearer token" type="password"/);
    expect(markup).toContain("its url and a Bearer token");
    expect(markup).toContain("kept on this device only");
  });
});

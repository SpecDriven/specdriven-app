// specs/external-links/confluence-wiki.feature.md as static markup: the
// publish dialog (the parent page, which scenarios go in, Publish) and the
// Settings → Confluence form (the wikis with a token, and how to add one).
// App.tsx owns the open state, the menu entry and the chip.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfluencePublishDialog, parentUrlProblem } from "../src/frontend/ConfluencePublishDialog";
import { ConfluenceTokens } from "../src/frontend/ConfluenceToken";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};
const WIKI = { base: "https://wiki.acme.com", user: "David V" };
const PARENT = "https://wiki.acme.com/spaces/ABC/pages/99999/Parent+Page";

describe("ConfluencePublishDialog", () => {
  test("a modal dialog with the parent url, the two scopes and Publish", () => {
    const markup = html(
      <ConfluencePublishDialog
        file="specs/quote.feature.md"
        featureName="Quote Policy"
        initialParentUrl={PARENT}
        wikis={[WIKI]}
        onPublished={noop}
        onClose={noop}
      />,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Publish to Confluence");
    expect(markup).toContain("<strong>Quote Policy</strong>");
    expect(markup).toContain('aria-label="Parent page url"');
    expect(markup).toContain(`value="${PARENT}"`);
    expect(markup).toContain('aria-label="All scenarios"');
    expect(markup).toContain('aria-label="Published scenarios only"');
    expect(markup).toMatch(/<button type="submit" class="primary">Publish<\/button>/);
  });

  test("a feature published before says publishing again updates its page", () => {
    const markup = html(
      <ConfluencePublishDialog
        file="f"
        featureName="F"
        linkedUrl="https://wiki.acme.com/spaces/ABC/pages/5/F"
        initialParentUrl={PARENT}
        wikis={[WIKI]}
        onPublished={noop}
        onClose={noop}
      />,
    );
    expect(markup).toContain("publishing again updates");
    expect(markup).toContain('href="https://wiki.acme.com/spaces/ABC/pages/5/F"');
  });

  test("Publish waits for a page url on a wiki with a token, and says what is missing", () => {
    expect(parentUrlProblem(PARENT, [WIKI])).toBeNull();
    expect(parentUrlProblem("", [WIKI])).toContain("Paste the url");
    expect(parentUrlProblem("https://wiki.acme.com/x/abc", [WIKI])).toContain("Not a Confluence page url");
    expect(parentUrlProblem("https://other.acme.com/spaces/ABC/pages/1/P", [WIKI])).toBe(
      "No token for https://other.acme.com — add one in Settings → Confluence.",
    );
    const markup = html(
      <ConfluencePublishDialog file="f" featureName="F" initialParentUrl={PARENT} wikis={[]} onPublished={noop} onClose={noop} />,
    );
    expect(markup).toContain("No token for https://wiki.acme.com");
    expect(markup).toMatch(/<button type="submit" class="primary" disabled="">Publish<\/button>/);
  });
});

describe("ConfluenceTokens", () => {
  test("lists each wiki with who its token signs in as, never the token, each with Remove", () => {
    const markup = html(<ConfluenceTokens wikis={[WIKI]} onChange={noop} />);
    expect(markup).toContain("<strong>https://wiki.acme.com</strong>");
    expect(markup).toContain("as David V");
    expect(markup).toContain('aria-label="Remove the token for https://wiki.acme.com"');
    expect(markup).toContain("Add another wiki");
  });

  test("offers the url and token fields, the token as a password", () => {
    const markup = html(<ConfluenceTokens wikis={[]} onChange={noop} />);
    expect(markup).toContain("Add a wiki");
    expect(markup).toContain('aria-label="Confluence url"');
    expect(markup).toMatch(/aria-label="Confluence personal access token" type="password"/);
    expect(markup).toContain("kept on this device only");
  });
});

// specs/external-links/qtest-test-cases.feature.md "Publish the page and
// the test cases from one dialog": the combined dialog as static markup (the
// parent page, the parent module, which scenarios go in, one Publish) and
// the order its run goes in — the page first, the test cases only once the
// page stands. App.tsx owns the open state and the menu entry.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { publishPageThenCases, WikiQtestPublishDialog } from "../src/frontend/WikiQtestPublishDialog";
import type { ConfluencePublishResult, PublishOutcome } from "../src/frontend/ConfluencePublishDialog";
import type { QtestPublishOutcome, QtestPublishResult } from "../src/frontend/QtestPublishDialog";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};
const WIKI = { base: "https://wiki.acme.com", user: "David V" };
const SITE = { base: "https://acme.qtestnet.com", user: "3 projects" };
const PAGE_PARENT = "https://wiki.acme.com/spaces/ABC/pages/99999/Parent+Page";
const MODULE_PARENT = "https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=0&id=901";

const dialog = (over: Partial<Parameters<typeof WikiQtestPublishDialog>[0]> = {}) => (
  <WikiQtestPublishDialog
    file="specs/quote.feature.md"
    featureName="Quote Policy"
    initialParentPageUrl={PAGE_PARENT}
    initialParentModuleUrl={MODULE_PARENT}
    wikis={[WIKI]}
    sites={[SITE]}
    onPagePublished={noop}
    onCasesPublished={noop}
    onClose={noop}
    {...over}
  />
);

describe("WikiQtestPublishDialog", () => {
  test("a modal dialog with the parent page, the parent module, the two scopes and one Publish", () => {
    const markup = html(dialog());
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Publish to Wiki &amp; qTest");
    expect(markup).toContain("<strong>Quote Policy</strong>");
    expect(markup).toContain('aria-label="Parent page url"');
    expect(markup).toContain(`value="${PAGE_PARENT}"`);
    expect(markup).toContain('aria-label="Parent module url"');
    expect(markup).toContain(`value="${MODULE_PARENT.replace(/&/g, "&amp;")}"`);
    expect(markup).toContain('aria-label="All scenarios"');
    expect(markup).toContain('aria-label="Published scenarios only"');
    expect(markup).toContain("The test cases link their scenarios on the page");
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary">Publish<\/button>/);
    // Nothing has run yet: no progress list.
    expect(markup).not.toContain('aria-label="Progress"');
  });

  test("a feature published before says both its page and its module are updated", () => {
    const markup = html(
      dialog({
        linkedPageUrl: "https://wiki.acme.com/pages/123",
        linkedModuleUrl: "https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=0&id=66",
      }),
    );
    expect(markup).toContain('href="https://wiki.acme.com/pages/123"');
    expect(markup).toContain("its page");
    expect(markup).toContain('href="https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&amp;object=0&amp;id=66"');
    expect(markup).toContain("its module");
  });

  test("Publish waits for both urls, each on a site with a token, and says what is missing under its field", () => {
    const noWiki = html(dialog({ wikis: [] }));
    expect(noWiki).toContain("No token for https://wiki.acme.com — add one in Settings → Confluence.");
    expect(noWiki).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Publish<\/button>/);
    const noSite = html(dialog({ sites: [] }));
    expect(noSite).toContain("No token for https://acme.qtestnet.com — add one in Settings → qTest.");
    expect(noSite).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Publish<\/button>/);
    const badModule = html(dialog({ initialParentModuleUrl: "https://acme.qtestnet.com/p/12/portal/project#object=1&id=5" }));
    expect(badModule).toContain("Not a qTest module url");
    const badPage = html(dialog({ initialParentPageUrl: "https://wiki.acme.com/nowhere" }));
    expect(badPage).toContain("Not a Confluence page url");
    expect(html(dialog())).not.toContain('<p class="hint">');
  });
});

describe("publishPageThenCases", () => {
  const page: ConfluencePublishResult = {
    id: "123",
    url: "https://wiki.acme.com/pages/123",
    created: true,
    version: 1,
    title: "Quote Policy",
    parentUrl: PAGE_PARENT,
    content: "",
    parsed: { name: "Quote Policy", description: "", scenarios: [] } as unknown as ConfluencePublishResult["parsed"],
  };
  const cases = {
    module: { id: "66", pid: "MD-66", url: "https://acme.qtestnet.com/#id=66", created: true },
    cases: [],
    created: 2,
    updated: 0,
    title: "Quote Policy",
    parentUrl: MODULE_PARENT,
    content: "",
    parsed: page.parsed,
  } as QtestPublishResult;

  /** The calls made, in order. */
  const run = async (pageDone: boolean, pageOutcome: PublishOutcome, casesOutcome: QtestPublishOutcome) => {
    const calls: string[] = [];
    const out = await publishPageThenCases({
      pageDone,
      publishPage: async () => {
        calls.push("page");
        return pageOutcome;
      },
      publishCases: async () => {
        calls.push("cases");
        return casesOutcome;
      },
    });
    return { calls, out };
  };

  test("the page goes first, and the test cases follow it", async () => {
    const { calls, out } = await run(false, { kind: "done", result: page }, { kind: "done", result: cases });
    expect(calls).toEqual(["page", "cases"]);
    expect(out.page?.kind).toBe("done");
    expect(out.cases?.kind).toBe("done");
  });

  test("a page that conflicts or fails stops the run before any test case is written", async () => {
    const conflict: PublishOutcome = {
      kind: "conflict",
      conflict: { pageId: "123", url: page.url, version: 4, lastVersion: 3 },
    };
    const stopped = await run(false, conflict, { kind: "done", result: cases });
    expect(stopped.calls).toEqual(["page"]);
    expect(stopped.out.cases).toBeUndefined();
    const failed = await run(false, { kind: "failed", error: "no such page", status: 404 }, { kind: "done", result: cases });
    expect(failed.calls).toEqual(["page"]);
    expect(failed.out.cases).toBeUndefined();
  });

  test("a page published in this run is not published again when the test cases are retried", async () => {
    const { calls, out } = await run(true, { kind: "done", result: page }, { kind: "done", result: cases });
    expect(calls).toEqual(["cases"]);
    expect(out.page).toBeUndefined();
    expect(out.cases?.kind).toBe("done");
  });
});

// specs/external-links/confluence-wiki.feature.md as static markup: the
// publish dialog (the parent page, which scenarios go in, Publish) and the
// Settings → Confluence form (the wikis with a token, and how to add one).
// App.tsx owns the open state, the menu entry and the chip.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfluenceConflictNotice, ConfluencePublishDialog, parentUrlProblem } from "../src/frontend/ConfluencePublishDialog";
import { ConfluenceTokens } from "../src/frontend/ConfluenceToken";
import {
  commonParentUrl,
  ConfluenceFolderPublishDialog,
  failsEveryFeature,
  pendingFiles,
  publishEach,
  type FolderFeature,
  type RowState,
} from "../src/frontend/ConfluenceFolderPublishDialog";
import type { ConfluencePublishResult, PublishOutcome } from "../src/frontend/ConfluencePublishDialog";

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
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary">Publish<\/button>/);
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

  test("says who changed the page in Confluence and offers to publish anyway", () => {
    const markup = html(
      <ConfluenceConflictNotice
        conflict={{
          pageId: "5",
          url: "https://wiki.acme.com/spaces/ABC/pages/5/F",
          version: 7,
          lastVersion: 6,
          by: "Jane Doe",
          when: "2026-10-21T15:04:05.000+0000",
        }}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("changed in Confluence");
    expect(markup).toContain("version 7 by Jane Doe on ");
    expect(markup).toContain("wrote version 6");
    expect(markup).toContain("Publishing will replace those changes");
    expect(markup).toContain('href="https://wiki.acme.com/spaces/ABC/pages/5/F"');
    // Without an author or a time, Confluence's answer is still a sentence.
    const bare = html(
      <ConfluenceConflictNotice conflict={{ pageId: "5", url: "https://w/5", version: 7, lastVersion: 6 }} />,
    );
    expect(bare).toContain("version 7 (the last publish wrote version 6)");
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
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Publish<\/button>/);
  });
});

describe("ConfluenceFolderPublishDialog", () => {
  const FEATURES: FolderFeature[] = [
    { file: "specs/billing/invoices.feature.md", name: "Invoices", linkedUrl: "https://wiki.acme.com/spaces/ABC/pages/5/Invoices", parentUrl: PARENT },
    { file: "specs/billing/tax/vat.feature.md", name: "VAT" },
  ];
  const folderDialog = (features: FolderFeature[] | null, wikis = [WIKI]) =>
    html(
      <ConfluenceFolderPublishDialog
        folderLabel="Billing"
        features={features}
        wikis={wikis}
        onPublished={noop}
        onFinished={noop}
        onClose={noop}
      />,
    );

  test("a modal dialog with the parent url, the two scopes and each feature checked", () => {
    const markup = folderDialog(FEATURES);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Publish folder to Confluence"');
    expect(markup).toContain("Each feature in <strong>Billing</strong> becomes its own page under the parent page");
    expect(markup).toContain(`value="${PARENT}"`);
    expect(markup).toContain('aria-label="All scenarios"');
    expect(markup).toContain('aria-label="Published scenarios only"');
    expect(markup).toMatch(/type="checkbox" aria-label="Invoices" checked=""/);
    expect(markup).toMatch(/type="checkbox" aria-label="VAT" checked=""/);
    // A feature published before says it updates its page; the rest are new.
    expect(markup).toContain('Updates <a href="https://wiki.acme.com/spaces/ABC/pages/5/Invoices"');
    expect(markup).toContain("New page");
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary">Publish 2 features<\/button>/);
  });

  test("waits for the folder's features, and says when there are none", () => {
    expect(folderDialog(null)).toContain("Loading the folder&#x27;s features");
    expect(folderDialog(null)).toMatch(/disabled="">Publish<\/button>/);
    expect(folderDialog([])).toContain("This folder has no features to publish.");
  });

  test("Publish waits for a page url on a wiki with a token", () => {
    const markup = folderDialog(FEATURES, []);
    expect(markup).toContain("No token for https://wiki.acme.com");
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Publish 2 features<\/button>/);
  });

  test("offers the parent most of the folder's features were last published under", () => {
    const other = "https://wiki.acme.com/spaces/ABC/pages/2/Archive";
    const f = (file: string, parentUrl?: string): FolderFeature => ({ file, name: file, ...(parentUrl ? { parentUrl } : {}) });
    expect(commonParentUrl([])).toBe("");
    expect(commonParentUrl([f("a"), f("b")])).toBe("");
    expect(commonParentUrl([f("a", other), f("b", PARENT), f("c", PARENT)])).toBe(PARENT);
    // A tie goes to the first in the folder's order.
    expect(commonParentUrl([f("a", other), f("b", PARENT)])).toBe(other);
  });

  const done = (file: string): PublishOutcome => ({
    kind: "done",
    result: { id: file, url: `https://wiki.acme.com/pages/${file}`, created: true, title: file } as ConfluencePublishResult,
  });

  test("publishes each feature in turn, forcing only the conflicts the user chose to replace", async () => {
    const calls: [string, boolean][] = [];
    const states: [string, RowState["kind"]][] = [];
    await publishEach(
      ["a", "b", "c"],
      async (file, force) => {
        calls.push([file, force]);
        return file === "b" ? { kind: "failed", error: "Confluence answered HTTP 500", status: 502, details: { method: "PUT", url: "u", status: 500, time: "t" } } : done(file);
      },
      (file, state) => states.push([file, state.kind]),
      new Set(["c"]),
    );
    // A failure of one feature's own does not stop the rest.
    expect(calls).toEqual([["a", false], ["b", false], ["c", true]]);
    expect(states).toEqual([
      ["a", "publishing"],
      ["a", "done"],
      ["b", "publishing"],
      ["b", "failed"],
      ["c", "publishing"],
      ["c", "done"],
    ]);
  });

  test("stops at a failure every feature would meet, a refused token or a wiki with no answer", async () => {
    const refused: PublishOutcome = { kind: "failed", error: "Confluence rejected the token", status: 401 };
    const unreachable: PublishOutcome = {
      kind: "failed",
      error: "Could not reach Confluence",
      status: 502,
      details: { method: "GET", url: "u", cause: "ECONNREFUSED", time: "t" },
    };
    for (const failure of [refused, unreachable]) {
      expect(failsEveryFeature(failure)).toBe(true);
      const calls: string[] = [];
      await publishEach(["a", "b", "c"], async (file) => (calls.push(file), file === "b" ? failure : done(file)), noop);
      expect(calls).toEqual(["a", "b"]);
    }
    expect(failsEveryFeature({ kind: "failed", error: "no such page", status: 404 })).toBe(false);
    expect(failsEveryFeature({ kind: "conflict", conflict: { pageId: "5", url: "u", version: 7, lastVersion: 6 } })).toBe(false);
  });

  test("Publish sends the checked features not yet published in this run", () => {
    const files = FEATURES.map((f) => f.file);
    expect(pendingFiles(FEATURES, new Set(files), new Map())).toEqual(files);
    expect(pendingFiles(FEATURES, new Set([files[1]!]), new Map())).toEqual([files[1]!]);
    expect(pendingFiles(FEATURES, new Set(files), new Map([[files[0]!, done(files[0]!) as RowState]]))).toEqual([files[1]!]);
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

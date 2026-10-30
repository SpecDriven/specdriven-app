// Automates specs/external-links/confluence-wiki.feature.md "The Confluence
// line in the feature file" and "Confluence is reserved for the page link":
// the page a feature was published to is one `[Confluence:<page id>](url)`
// line under the feature's heading — held in the Automerge document always,
// in the `.feature.md` while "Publish external links" is on — like the qTest
// line (qtestLinks.test.ts), but on the feature only.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "@automerge/automerge";
import { isConfluenceLink, parseFeature, serializeFeature } from "../src/server/parser";
import {
  docToFeature,
  isProjectionOf,
  projectFeature,
  projectionOptions,
  setProjectionOptions,
} from "../src/server/automerge/project";
import { importFeatureDoc, reconcile } from "../src/server/automerge/reconcile";
import { threeWayFeature } from "../src/server/automerge/merge";
import { importDrift } from "../src/server/automerge/driftSync";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { createFeature, readFeature, readFeatureView, saveFeature } from "../src/server/features";
import { normalizeProjectManagementTool } from "../src/server/state";
import { resolveLinkDraft } from "../src/frontend/externallinks";

const JIRA = { program: "Jira", ticket: "ABC-123", url: "https://acme.atlassian.net/browse/ABC-123" };
const JIRA_LINE = "[Jira:ABC-123](https://acme.atlassian.net/browse/ABC-123)";
const QURL = "https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=1&id=901";
const QTEST_LINE = `[qTest:TC-42](${QURL})`;
const PAGE_URL = "https://wiki.acme.com/spaces/ABC/pages/4242/Quote+Policy";
const PAGE = { program: "Confluence", ticket: "4242", url: PAGE_URL };
const PAGE_LINE = `[Confluence:4242](${PAGE_URL})`;

const SAMPLE = `# Quote Policy

${JIRA_LINE}

${QTEST_LINE}

${PAGE_LINE}

Quotes for potential customers.

## Basic Quote @v1 [proposed]

- **Given** a potential customer has an account
- **Then** a quote is provided
`;

// What the app writes: the same text with the scenario numbered by its
// position (parser.ts `S<n>:`); parsing either form gives the same feature.
const WRITTEN = SAMPLE.replace("## Basic Quote", "## S1: Basic Quote");

const defaults = projectionOptions();
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-confluence-links-"));
});

afterEach(async () => {
  setProjectionOptions(defaults);
  await rm(root, { recursive: true, force: true });
});

describe("the Confluence line", () => {
  test("is lifted into confluence, beside the ticket and the test case", () => {
    const feature = parseFeature(SAMPLE);
    expect(feature.confluence).toEqual(PAGE);
    expect(feature.links).toEqual([JIRA]);
    expect(feature.qtest?.ticket).toBe("TC-42");
    expect(feature.description).toBe("Quotes for potential customers.");
  });

  test("survives a round trip, written after the ticket and test case whatever the order", () => {
    expect(serializeFeature(parseFeature(SAMPLE))).toBe(WRITTEN);
    const first = SAMPLE.replace(`${JIRA_LINE}\n\n${QTEST_LINE}\n\n${PAGE_LINE}`, `${PAGE_LINE}\n\n${JIRA_LINE}\n\n${QTEST_LINE}`);
    expect(serializeFeature(parseFeature(first))).toBe(WRITTEN);
  });

  test("is the page and never the ticket, whatever its case", () => {
    expect(isConfluenceLink(PAGE)).toBe(true);
    expect(isConfluenceLink({ ...PAGE, program: "CONFLUENCE" })).toBe(true);
    expect(isConfluenceLink(JIRA)).toBe(false);
    const only = parseFeature(`# F\n\n[confluence:7](${PAGE_URL})\n`);
    expect(only.confluence?.ticket).toBe("7");
    expect(only.links).toBeUndefined();
  });

  test("under a scenario heading it is content, not the scenario's ticket", () => {
    const feature = parseFeature(`# F\n\n## S @v1 [proposed]\n\n${PAGE_LINE}\n\n- a step\n`);
    const s = feature.scenarios[0]!;
    expect(s.link).toBeUndefined();
    expect(s.body).toBe(`${PAGE_LINE}\n\n- a step`);
    expect(feature.confluence).toBeUndefined();
  });

  test("is left out with the other links when links are not written", () => {
    const text = serializeFeature(parseFeature(SAMPLE), { links: false });
    expect(text).not.toContain("[Confluence:");
  });

  test("Confluence can't be a ticket tool, where it would read back as the page", () => {
    expect(resolveLinkDraft({ program: "Confluence", ticket: "ABC-1", url: JIRA.url }).error).toContain("Confluence");
    expect(normalizeProjectManagementTool("confluence")).toBe("Jira");
  });
});

describe("the document", () => {
  test("holds the page link and projects it back, or leaves it out with links off", () => {
    const doc = importFeatureDoc(parseFeature(SAMPLE));
    expect(docToFeature(doc).confluence).toEqual(PAGE);
    expect(projectFeature(doc)).toBe(WRITTEN);
    const without = projectFeature(doc, { publishExternalLinks: false });
    expect(without).not.toContain("[Confluence:");
    expect(isProjectionOf(without, doc)).toBe(true);
    expect(isProjectionOf(SAMPLE.replace("4242", "4243"), doc)).toBe(false);
  });

  test("reconcile sets, replaces and clears it — and a no-op stays one", () => {
    const plain = parseFeature(SAMPLE);
    delete plain.confluence;
    let doc = importFeatureDoc(plain);
    doc = reconcile(doc, parseFeature(SAMPLE));
    expect(docToFeature(doc).confluence).toEqual(PAGE);
    const heads = A.getHeads(doc);
    expect(A.getHeads(reconcile(doc, parseFeature(SAMPLE)))).toEqual(heads);

    const moved = parseFeature(SAMPLE);
    moved.confluence = { ...PAGE, ticket: "9" };
    doc = reconcile(doc, moved);
    expect(docToFeature(doc).confluence!.ticket).toBe("9");
    expect(docToFeature(doc).links).toEqual([JIRA]);

    doc = reconcile(doc, plain);
    expect(docToFeature(doc).confluence).toBeUndefined();
    expect(docToFeature(doc).links).toEqual([JIRA]);
  });

  test("a three-way merge keeps the side that changed it, ours when both did", () => {
    const base = parseFeature(SAMPLE);
    delete base.confluence;
    const added = threeWayFeature(base, base, parseFeature(SAMPLE));
    expect(added.ok && added.feature.confluence).toEqual(PAGE);
    const ours = { ...parseFeature(SAMPLE), confluence: { ...PAGE, ticket: "1" } };
    const theirs = { ...parseFeature(SAMPLE), confluence: { ...PAGE, ticket: "2" } };
    const both = threeWayFeature(parseFeature(SAMPLE), ours, theirs);
    expect(both.ok && both.feature.confluence).toEqual(ours.confluence);
  });
});

describe("saving a feature", () => {
  test("writes the line while links are published; with links off the editor still sees it", async () => {
    const file = await createFeature(root, "Quote Policy");
    await saveFeature(root, file, SAMPLE);
    expect(await readFeature(root, file)).toBe(WRITTEN);

    setProjectionOptions({ publishExternalLinks: false });
    const other = await createFeature(root, "Other Policy");
    await saveFeature(root, other, SAMPLE.replace("# Quote Policy", "# Other Policy"));
    expect(await readFeature(root, other)).not.toContain("[Confluence:");
    expect((await readFeatureView(root, other))!.parsed.confluence).toEqual(PAGE);
  });

  test("a file in the other form is not drift; an edited page link is", async () => {
    const file = await createFeature(root, "Quote Policy");
    await saveFeature(root, file, SAMPLE);
    await Bun.write(join(root, file), serializeFeature(parseFeature(SAMPLE), { links: false }));
    expect(await importDrift(root)).toBe("");
    expect(docToFeature((await loadFeatureDoc(root, file))!.doc).confluence).toEqual(PAGE);

    await Bun.write(join(root, file), SAMPLE.replace(PAGE_LINE, `[Confluence:77](${PAGE_URL})`));
    expect(await importDrift(root)).toContain("absorbed 1");
    expect(docToFeature((await loadFeatureDoc(root, file))!.doc).confluence!.ticket).toBe("77");
  });
});

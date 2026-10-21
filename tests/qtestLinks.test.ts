// Automates specs/external-links/qtest-test-cases.feature.md: a feature and
// each of its scenarios can link the qTest test case covering it. The link
// works like the ticket link (externalLinks.test.ts) — one
// `[qTest:<id>](<url>)` line under the heading, held in the Automerge
// document always and in the `.feature.md` while "Publish external links"
// is on — and is offered only once its Settings switch is on.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "@automerge/automerge";
import { handleApi, reloader } from "../src/server/api";
import { isQtestLink, parseFeature, serializeFeature } from "../src/server/parser";
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
import {
  createFeature,
  publishFeature,
  readFeature,
  readFeatureForEditor,
  readFeatureView,
  saveFeature,
} from "../src/server/features";
import {
  normalizeProjectManagementTool,
  normalizeQtestLinks,
  readState,
  writeState,
} from "../src/server/state";
import {
  EMPTY_LINK_DRAFT,
  externalLinkLabel,
  linkDraftOf,
  qtestCaseFromUrl,
  resolveLinkDraft,
  resolveQtestDraft,
  withQtestUrl,
} from "../src/frontend/externallinks";
import { scenarioSignature } from "../src/frontend/App";

const JIRA = { program: "Jira", ticket: "ABC-123", url: "https://acme.atlassian.net/browse/ABC-123" };
const JIRA_LINE = "[Jira:ABC-123](https://acme.atlassian.net/browse/ABC-123)";
const QURL = "https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=1&id=901";
const QTEST = { program: "qTest", ticket: "TC-42", url: QURL };
const QTEST_LINE = `[qTest:TC-42](${QURL})`;
const SCENARIO_QURL = "https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&object=1&id=902";
const SCENARIO_QTEST = { program: "qTest", ticket: "TC-43", url: SCENARIO_QURL };

const SAMPLE = `# Quote Policy

${JIRA_LINE}

${QTEST_LINE}

Quotes for potential customers.

## Basic Quote @v1 [proposed]

[qTest:TC-43](${SCENARIO_QURL})

- **Given** a potential customer has an account
- **Then** a quote is provided

## Declined Quote @v2 [published]

- **Given** the customer has no account
`;

// What the app writes: the same text with each scenario numbered by its
// position (parser.ts `S<n>:`); parsing either form gives the same feature.
const WRITTEN = SAMPLE.replace("## Basic Quote", "## S1: Basic Quote").replace(
  "## Declined Quote",
  "## S2: Declined Quote",
);

const defaults = projectionOptions();
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-qtest-"));
});

afterEach(async () => {
  setProjectionOptions(defaults);
  await rm(root, { recursive: true, force: true });
});

// --- the markdown line -----------------------------------------------------

describe("the qTest line", () => {
  test("is lifted into qtest, beside the ticket, under the heading it belongs to", () => {
    const feature = parseFeature(SAMPLE);
    expect(feature.link).toEqual(JIRA);
    expect(feature.qtest).toEqual(QTEST);
    expect(feature.description).toBe("Quotes for potential customers.");
    const [basic, declined] = feature.scenarios;
    expect(basic!.qtest).toEqual(SCENARIO_QTEST);
    expect(basic!.link).toBeUndefined();
    expect(basic!.body).toBe(
      "- **Given** a potential customer has an account\n- **Then** a quote is provided",
    );
    expect(declined!.qtest).toBeUndefined();
  });

  test("survives a parse/serialize round trip", () => {
    const feature = parseFeature(SAMPLE);
    expect(serializeFeature(feature)).toBe(WRITTEN);
    expect(parseFeature(serializeFeature(feature))).toEqual(feature);
  });

  test("may come before the ticket line, and is written back after it", () => {
    const swapped = SAMPLE.replace(`${JIRA_LINE}\n\n${QTEST_LINE}`, `${QTEST_LINE}\n\n${JIRA_LINE}`);
    const feature = parseFeature(swapped);
    expect(feature.link).toEqual(JIRA);
    expect(feature.qtest).toEqual(QTEST);
    expect(serializeFeature(feature)).toBe(WRITTEN);
  });

  test("is told from a ticket by its program, whatever its case", () => {
    expect(isQtestLink(QTEST)).toBe(true);
    expect(isQtestLink({ ...QTEST, program: "QTEST" })).toBe(true);
    expect(isQtestLink(JIRA)).toBe(false);
    const lower = parseFeature(`# F\n\n[qtest:TC-1](${QURL})\n`);
    expect(lower.qtest?.ticket).toBe("TC-1");
    expect(lower.link).toBeUndefined();
  });

  test("a second qTest line is content, not a second link", () => {
    const feature = parseFeature(`# F\n\n${QTEST_LINE}\n\n[qTest:TC-9](${QURL})\n`);
    expect(feature.qtest).toEqual(QTEST);
    expect(feature.description).toBe(`[qTest:TC-9](${QURL})`);
  });

  test("is left out with the ticket links when links are not written", () => {
    const text = serializeFeature(parseFeature(SAMPLE), { links: false });
    expect(text).not.toContain("[qTest:");
    expect(text).not.toContain("[Jira:");
    expect(parseFeature(text).qtest).toBeUndefined();
  });
});

// --- the document and its projection -----------------------------------------

describe("the document", () => {
  test("holds the qTest links and projects them back", () => {
    const feature = parseFeature(SAMPLE);
    const doc = importFeatureDoc(feature);
    expect(docToFeature(doc)).toEqual(feature);
    expect(projectFeature(doc)).toBe(WRITTEN);
  });

  test("keeps them out of the projection while Publish external links is off", () => {
    const doc = importFeatureDoc(parseFeature(SAMPLE));
    const without = projectFeature(doc, { publishExternalLinks: false });
    expect(without).not.toContain("[qTest:");
    expect(docToFeature(doc).qtest).toEqual(QTEST);
    expect(isProjectionOf(without, doc)).toBe(true);
    expect(isProjectionOf(SAMPLE.replace("TC-42", "TC-44"), doc)).toBe(false);
  });

  test("reconcile sets, replaces and clears them — and a no-op stays one", () => {
    const plain = parseFeature(serializeFeature(parseFeature(SAMPLE), { links: false }));
    let doc = importFeatureDoc(plain);
    doc = reconcile(doc, parseFeature(SAMPLE));
    expect(docToFeature(doc).qtest).toEqual(QTEST);
    expect(docToFeature(doc).scenarios[0]!.qtest).toEqual(SCENARIO_QTEST);
    const heads = A.getHeads(doc);
    expect(A.getHeads(reconcile(doc, parseFeature(SAMPLE)))).toEqual(heads);

    const moved = parseFeature(SAMPLE);
    moved.qtest = { ...QTEST, ticket: "TC-99" };
    doc = reconcile(doc, moved);
    expect(docToFeature(doc).qtest!.ticket).toBe("TC-99");
    // The ticket is a separate key: replacing the test case left it alone.
    expect(docToFeature(doc).link).toEqual(JIRA);

    const noQtest = parseFeature(SAMPLE);
    delete noQtest.qtest;
    delete noQtest.scenarios[0]!.qtest;
    doc = reconcile(doc, noQtest);
    expect(docToFeature(doc).qtest).toBeUndefined();
    expect(docToFeature(doc).scenarios[0]!.qtest).toBeUndefined();
    expect(docToFeature(doc).link).toEqual(JIRA);
  });

  test("a published scenario's test case stays editable", () => {
    const doc = importFeatureDoc(parseFeature(SAMPLE));
    const target = parseFeature(SAMPLE);
    target.scenarios[1]!.qtest = QTEST; // Declined Quote @v2 [published]
    expect(docToFeature(reconcile(doc, target)).scenarios[1]!.qtest).toEqual(QTEST);
  });

  test("a three-way merge keeps the side that changed it, ours when both did", () => {
    const base = parseFeature(serializeFeature(parseFeature(SAMPLE), { links: false }));
    const added = threeWayFeature(base, base, parseFeature(SAMPLE));
    expect(added.ok && added.feature.qtest).toEqual(QTEST);
    expect(
      added.ok && added.feature.scenarios.find((s) => s.name === "Basic Quote")!.qtest,
    ).toEqual(SCENARIO_QTEST);

    const ours = parseFeature(SAMPLE);
    ours.qtest = { ...QTEST, ticket: "TC-1" };
    const theirs = parseFeature(SAMPLE);
    theirs.qtest = { ...QTEST, ticket: "TC-2" };
    const both = threeWayFeature(parseFeature(SAMPLE), ours, theirs);
    expect(both.ok && both.feature.qtest).toEqual(ours.qtest);
  });
});

// --- through the feature layer ------------------------------------------------

describe("saving a feature", () => {
  test("writes the test cases into the file while links are published", async () => {
    const file = await createFeature(root, "Quote Policy");
    await saveFeature(root, file, SAMPLE);
    expect(await readFeature(root, file)).toBe(WRITTEN);
    expect(docToFeature((await loadFeatureDoc(root, file))!.doc).qtest).toEqual(QTEST);
  });

  test("with links unpublished the file has none, but the editor sees and keeps them", async () => {
    setProjectionOptions({ publishExternalLinks: false });
    const file = await createFeature(root, "Quote Policy");
    const saved = await saveFeature(root, file, SAMPLE);
    expect(saved.content).toBe(WRITTEN);
    expect(await readFeature(root, file)).not.toContain("[qTest:");
    expect(await readFeatureForEditor(root, file)).toBe(WRITTEN);
    const view = (await readFeatureView(root, file))!;
    expect(view.parsed.qtest).toEqual(QTEST);
    expect(view.parsed.scenarios[0]!.qtest).toEqual(SCENARIO_QTEST);
    const again = await saveFeature(root, file, SAMPLE.replace("is provided", "is emailed"));
    expect(parseFeature(again.content).qtest).toEqual(QTEST);
  });

  test("a file in the other form is not drift; an edited test case is", async () => {
    const file = await createFeature(root, "Quote Policy");
    await saveFeature(root, file, SAMPLE);
    await Bun.write(join(root, file), serializeFeature(parseFeature(SAMPLE), { links: false }));
    expect(await importDrift(root)).toBe("");
    expect(docToFeature((await loadFeatureDoc(root, file))!.doc).qtest).toEqual(QTEST);

    const edited = SAMPLE.replace(QTEST_LINE, `[qTest:TC-77](${QURL})`);
    await Bun.write(join(root, file), edited);
    expect(await importDrift(root)).toContain("absorbed 1");
    expect(docToFeature((await loadFeatureDoc(root, file))!.doc).qtest!.ticket).toBe("TC-77");
  });

  test("publishing keeps the scenario's test case", async () => {
    const file = await createFeature(root, "Quote Policy");
    await saveFeature(root, file, SAMPLE);
    expect((await publishFeature(root, file, SAMPLE)).status).toBe("published");
    const published = parseFeature((await readFeature(root, file))!);
    expect(published.qtest).toEqual(QTEST);
    expect(published.scenarios[0]!.qtest).toEqual(SCENARIO_QTEST);
  });
});

// --- the fields ----------------------------------------------------------------

describe("the qTest fields", () => {
  test("the id comes off the url only when the url spells it out", () => {
    expect(qtestCaseFromUrl(QURL)).toBe("");
    expect(qtestCaseFromUrl("https://acme.qtestnet.com/p/12/portal/project#tab=testdesign&id=TC-42")).toBe(
      "TC-42",
    );
    expect(qtestCaseFromUrl("https://acme.qtestnet.com/search?q=tc-7")).toBe("TC-7");
    expect(qtestCaseFromUrl("not a url")).toBe("");
  });

  test("a url fills the id while it is empty or derived; a typed one stays", () => {
    const derived = withQtestUrl(EMPTY_LINK_DRAFT, "https://q.example/TC-5");
    expect(derived).toEqual({ program: "qTest", ticket: "TC-5", url: "https://q.example/TC-5" });
    expect(withQtestUrl(derived, "https://q.example/TC-6").ticket).toBe("TC-6");
    const typed = { program: "qTest", ticket: "TC-42", url: "" };
    expect(withQtestUrl(typed, QURL)).toEqual(QTEST);
    expect(withQtestUrl(typed, "https://q.example/TC-6").ticket).toBe("TC-42");
  });

  test("empty is no link; a whole one resolves; anything partial is an error", () => {
    expect(resolveQtestDraft(EMPTY_LINK_DRAFT)).toEqual({ link: null });
    expect(resolveQtestDraft(linkDraftOf(QTEST))).toEqual({ link: QTEST });
    // The program is always qTest, whatever the draft held.
    expect(resolveQtestDraft({ program: "", ticket: " TC-42 ", url: ` ${QURL} ` })).toEqual({
      link: QTEST,
    });
    expect(resolveQtestDraft({ ...linkDraftOf(QTEST), url: "" }).error).toContain("url");
    expect(resolveQtestDraft({ ...linkDraftOf(QTEST), ticket: "" }).error).toContain("test case id");
    expect(resolveQtestDraft({ ...linkDraftOf(QTEST), url: "qtestnet.com" }).error).toContain(
      "Not a web link",
    );
    expect(resolveQtestDraft({ ...linkDraftOf(QTEST), ticket: "TC[1]" }).error).toContain("brackets");
  });

  test("the chip reads the program and the test case id", () => {
    expect(externalLinkLabel(QTEST)).toBe("qTest:TC-42");
  });

  test("a ticket can't be recorded under qTest, where it would read back as the test case", () => {
    expect(resolveLinkDraft({ program: "qTest", ticket: "ABC-1", url: JIRA.url }).error).toContain(
      "qTest",
    );
    expect(normalizeProjectManagementTool("qTest")).toBe("Jira");
    expect(normalizeProjectManagementTool(" QTEST ")).toBe("Jira");
  });

  test("the autosave signature follows the test case", () => {
    const s = parseFeature(SAMPLE).scenarios[1]!;
    expect(scenarioSignature({ ...s, qtest: QTEST }, 2)).not.toBe(scenarioSignature(s, 2));
  });
});

// --- the setting ------------------------------------------------------------------

describe("the qTest setting", () => {
  let home: string;
  const realRoot = process.env.SPECDRIVEN_ROOT;
  const realHome = process.env.SPECDRIVEN_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "specdriven-qtest-home-"));
    process.env.SPECDRIVEN_ROOT = root;
    process.env.SPECDRIVEN_HOME = home;
  });

  afterEach(async () => {
    reloader.stop();
    await rm(home, { recursive: true, force: true });
    for (const [name, value] of [
      ["SPECDRIVEN_ROOT", realRoot],
      ["SPECDRIVEN_HOME", realHome],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const settings = async (patch: Record<string, unknown>) =>
    (await handleApi(
      new Request("http://localhost/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    ))!;

  test("is off unless explicitly turned on", () => {
    expect(normalizeQtestLinks(undefined)).toBe(false);
    expect(normalizeQtestLinks("yes")).toBe(false);
    expect(normalizeQtestLinks(false)).toBe(false);
    expect(normalizeQtestLinks(true)).toBe(true);
  });

  test("round-trips through the settings file, off stored as an absent key", async () => {
    const data = join(root, "data");
    await createFeature(data, "Quote Policy");
    await writeState({ dataRepo: data }, root);
    const on = await settings({ qtestLinks: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { qtestLinks: boolean }).qtestLinks).toBe(true);
    expect((await readState(root)).qtestLinks).toBe(true);
    const off = await settings({ qtestLinks: false });
    expect(((await off.json()) as { qtestLinks: boolean }).qtestLinks).toBe(false);
    expect((await readState(root)).qtestLinks).toBeUndefined();
    expect((await settings({ qtestLinks: "yes" })).status).toBe(400);
  });

  test("qTest can't be the project management tool", async () => {
    const data = join(root, "data");
    await createFeature(data, "Quote Policy");
    await writeState({ dataRepo: data }, root);
    expect((await settings({ projectManagementTool: "qTest" })).status).toBe(400);
  });
});

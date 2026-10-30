import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "@automerge/automerge";
import {
  dedupeTicketLinks,
  EXTERNAL_LINK_TYPES,
  externalLinkTypeOf,
  formatExternalLink,
  isExternalLink,
  MAX_FEATURE_TICKETS,
  parseExternalLinkLine,
  parseFeature,
  sameTicket,
  serializeFeature,
  splitExternalLink,
} from "../src/server/parser";
import { ticketLinksOf } from "../src/server/automerge/schema";
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
  reprojectFeatures,
  saveFeature,
} from "../src/server/features";
import {
  DEFAULT_PROJECT_MANAGEMENT_TOOL,
  normalizeProjectManagement,
  normalizeProjectManagementTool,
  normalizePublishExternalLinks,
} from "../src/server/state";
import {
  EMPTY_LINK_DRAFT,
  externalLinkLabel,
  isBlankLinkDraft,
  linkDraftOf,
  resolveLinkDraft,
  suggestLink,
  ticketAddProblem,
  ticketChipLabel,
  ticketFromUrl,
  withLinkUrl,
  withLinkUrlForTool,
} from "../src/frontend/externallinks";
import { scenarioSignature } from "../src/frontend/App";

// specs/external-links/project-management-jira-linear-etc.feature.md: a
// feature and each of its scenarios can carry a link to the ticket tracking
// it in a project management tool; the links live in the Automerge document
// and are written into the projected `.feature.md` as
// `[<program>:<ticket>](<url>)` while the "Publish external links" setting
// is on.

const JIRA = { program: "Jira", ticket: "ABC-123", url: "https://acme.atlassian.net/browse/ABC-123" };
const LINEAR = { program: "Linear", ticket: "ENG-42", url: "https://linear.app/acme/issue/ENG-42/title" };
const JIRA_LINE = "[Jira:ABC-123](https://acme.atlassian.net/browse/ABC-123)";

const SAMPLE = `# Quote Policy

${JIRA_LINE}

Quotes for potential customers.

## Basic Quote @v1 [proposed]

[Linear:ENG-42](https://linear.app/acme/issue/ENG-42/title)

- **Given** a potential customer has an account
- **Then** a quote is provided

[test: https://github.com/acme/repo/blob/main/quote.test.ts ]

## Declined Quote @v2 [published]

- **Given** the customer has no account
`;

// What the app writes: the same text with each scenario numbered by its
// position (parser.ts `S<n>:`) — the number is a label for the order, not
// part of the name, so parsing either form gives the same feature.
const WRITTEN = SAMPLE.replace("## Basic Quote", "## S1: Basic Quote").replace(
  "## Declined Quote",
  "## S2: Declined Quote",
);

let root: string;
const defaults = projectionOptions();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-links-"));
});

afterEach(async () => {
  setProjectionOptions(defaults);
  await rm(root, { recursive: true, force: true });
});

// --- the markdown line -----------------------------------------------------

test("a link is written as [program:ticket](url) on a line of its own", () => {
  expect(formatExternalLink(JIRA)).toBe(JIRA_LINE);
  expect(parseExternalLinkLine(JIRA_LINE)).toEqual(JIRA);
  expect(parseExternalLinkLine(`  ${JIRA_LINE}  `)).toEqual(JIRA);
  // The program ends at the first colon; the ticket may hold more of them.
  expect(parseExternalLinkLine("[Jira:ABC-123:x](https://j.example/x)")).toEqual({
    program: "Jira",
    ticket: "ABC-123:x",
    url: "https://j.example/x",
  });
});

test("a line that is not exactly one link is ordinary content", () => {
  expect(parseExternalLinkLine("see [Jira:ABC-123](https://j.example/x)")).toBeNull();
  expect(parseExternalLinkLine("[Jira:ABC-123](https://j.example/x) and more")).toBeNull();
  expect(parseExternalLinkLine("[ABC-123](https://j.example/x)")).toBeNull(); // no program
  expect(parseExternalLinkLine("[Jira:ABC-123](j.example/x)")).toBeNull(); // not a web url
  expect(parseExternalLinkLine("[Jira:](https://j.example/x)")).toBeNull();
  expect(parseExternalLinkLine("[:ABC-123](https://j.example/x)")).toBeNull();
});

test("a link is well-formed only when its line parses back to itself", () => {
  expect(isExternalLink(JIRA)).toBe(true);
  expect(isExternalLink({ ...JIRA, program: "Ji:ra" })).toBe(false);
  expect(isExternalLink({ ...JIRA, ticket: "A]B" })).toBe(false);
  expect(isExternalLink({ ...JIRA, url: "https://j.example/a b" })).toBe(false);
  expect(isExternalLink({ ...JIRA, url: "ftp://j.example/a" })).toBe(false);
});

test("the link is lifted off the top of a text, and only from there", () => {
  expect(splitExternalLink(`${JIRA_LINE}\n\nbody`)).toEqual({ text: "body", link: JIRA });
  expect(splitExternalLink(`\n\n${JIRA_LINE}\n`)).toEqual({ text: "", link: JIRA });
  expect(splitExternalLink(`body\n\n${JIRA_LINE}`)).toEqual({ text: `body\n\n${JIRA_LINE}` });
  expect(splitExternalLink("")).toEqual({ text: "" });
});

// --- feature files ---------------------------------------------------------

test("the parser lifts the feature's and each scenario's link out of the text", () => {
  const feature = parseFeature(SAMPLE);
  expect(feature.links).toEqual([JIRA]);
  expect(feature.description).toBe("Quotes for potential customers.");
  const [basic, declined] = feature.scenarios;
  expect(basic!.link).toEqual(LINEAR);
  expect(basic!.body).toBe(
    "- **Given** a potential customer has an account\n- **Then** a quote is provided",
  );
  expect(basic!.tests).toEqual(["https://github.com/acme/repo/blob/main/quote.test.ts"]);
  expect(declined!.link).toBeUndefined();
  expect(declined!.body).toBe("- **Given** the customer has no account");
});

test("links survive a parse/serialize round trip, under the heading they belong to", () => {
  const feature = parseFeature(SAMPLE);
  const text = serializeFeature(feature);
  expect(text).toBe(WRITTEN);
  expect(parseFeature(text)).toEqual(feature);
});

test("serializing with links off leaves every link line out", () => {
  const feature = parseFeature(SAMPLE);
  const text = serializeFeature(feature, { links: false });
  expect(text).not.toContain("[Jira:");
  expect(text).not.toContain("[Linear:");
  const reread = parseFeature(text);
  expect(reread.links).toBeUndefined();
  expect(reread.scenarios[0]!.link).toBeUndefined();
  // Nothing else changed.
  expect(reread.description).toBe(feature.description);
  expect(reread.scenarios[0]!.body).toBe(feature.scenarios[0]!.body);
});

test("a link line inside a code fence at the top of a body is content", () => {
  const feature = parseFeature(`# F\n\n## S @v1\n\n\`\`\`\n${JIRA_LINE}\n\`\`\`\n`);
  expect(feature.scenarios[0]!.link).toBeUndefined();
  expect(feature.scenarios[0]!.body).toBe(`\`\`\`\n${JIRA_LINE}\n\`\`\``);
});

// --- the document and its projection -----------------------------------------

test("an imported document holds the links and projects them back", () => {
  const feature = parseFeature(SAMPLE);
  const doc = importFeatureDoc(feature);
  expect(docToFeature(doc)).toEqual(feature);
  expect(projectFeature(doc)).toBe(WRITTEN);
});

test("with Publish external links off, the projection leaves the links out", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  setProjectionOptions({ publishExternalLinks: false });
  const text = projectFeature(doc);
  expect(text).toBe(serializeFeature(parseFeature(SAMPLE), { links: false }));
  // The document still has them: the setting is about the markdown only.
  expect(docToFeature(doc).links).toEqual([JIRA]);
  // An explicit option overrides the setting.
  expect(projectFeature(doc, { publishExternalLinks: true })).toBe(WRITTEN);
});

test("either form of the projection counts as the document's projection", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const withLinks = projectFeature(doc, { publishExternalLinks: true });
  const withoutLinks = projectFeature(doc, { publishExternalLinks: false });
  expect(isProjectionOf(withLinks, doc)).toBe(true);
  expect(isProjectionOf(withoutLinks, doc)).toBe(true);
  expect(isProjectionOf(withLinks.replace("ABC-123", "ABC-124"), doc)).toBe(false);
  expect(isProjectionOf(withoutLinks.replace("no account", "an account"), doc)).toBe(false);
});

test("reconcile sets, replaces and clears links", () => {
  const plain = parseFeature(serializeFeature(parseFeature(SAMPLE), { links: false }));
  let doc = importFeatureDoc(plain);
  expect(docToFeature(doc).links).toBeUndefined();

  doc = reconcile(doc, parseFeature(SAMPLE));
  expect(docToFeature(doc).links).toEqual([JIRA]);
  expect(docToFeature(doc).scenarios[0]!.link).toEqual(LINEAR);
  expect(projectFeature(doc)).toBe(WRITTEN);

  const moved = { ...JIRA, ticket: "ABC-999", url: "https://acme.atlassian.net/browse/ABC-999" };
  const retargeted = parseFeature(SAMPLE);
  retargeted.links = [moved];
  doc = reconcile(doc, retargeted);
  expect(docToFeature(doc).links).toEqual([moved]);

  doc = reconcile(doc, plain);
  expect(docToFeature(doc).links).toBeUndefined();
  expect(docToFeature(doc).scenarios[0]!.link).toBeUndefined();
});

test("reconciling the same links again is a no-op", () => {
  const doc = reconcile(importFeatureDoc(parseFeature(SAMPLE)), parseFeature(SAMPLE));
  const heads = A.getHeads(doc);
  expect(A.getHeads(reconcile(doc, parseFeature(SAMPLE)))).toEqual(heads);
});

test("a scenario's link is editable while it is published", () => {
  const doc = importFeatureDoc(parseFeature(SAMPLE));
  const target = parseFeature(SAMPLE);
  target.scenarios[1]!.link = JIRA; // Declined Quote @v2 [published]
  const next = reconcile(doc, target);
  expect(docToFeature(next).scenarios[1]!.link).toEqual(JIRA);
});

// --- three-way merge (markdown-only peers, PRs) ---------------------------------

test("a link added on one side survives a three-way merge", () => {
  const base = parseFeature(serializeFeature(parseFeature(SAMPLE), { links: false }));
  const theirs = parseFeature(SAMPLE);
  const merged = threeWayFeature(base, base, theirs);
  expect(merged.ok).toBe(true);
  if (!merged.ok) return;
  expect(merged.feature.links).toEqual([JIRA]);
  expect(merged.feature.scenarios.find((s) => s.name === "Basic Quote")!.link).toEqual(LINEAR);
});

test("when both sides change a link, ours wins; a removal on one side stands", () => {
  const base = parseFeature(SAMPLE);
  const ours = parseFeature(SAMPLE);
  ours.links = [{ ...JIRA, ticket: "ABC-1" }];
  const theirs = parseFeature(SAMPLE);
  theirs.links = [{ ...JIRA, ticket: "ABC-2" }];
  const both = threeWayFeature(base, ours, theirs);
  expect(both.ok && both.feature.links).toEqual(ours.links);

  const removed = parseFeature(serializeFeature(parseFeature(SAMPLE), { links: false }));
  const gone = threeWayFeature(base, base, removed);
  expect(gone.ok && gone.feature.links).toBeUndefined();
});

// --- through the feature layer ------------------------------------------------

test("a saved link lands in the document and, with the setting on, in the file", async () => {
  const file = await createFeature(root, "Quote Policy");
  await saveFeature(root, file, SAMPLE);
  expect(await readFeature(root, file)).toBe(WRITTEN);
  const loaded = await loadFeatureDoc(root, file);
  expect(docToFeature(loaded!.doc).links).toEqual([JIRA]);
});

test("with the setting off, the file has no links but the editor still sees them", async () => {
  setProjectionOptions({ publishExternalLinks: false });
  const file = await createFeature(root, "Quote Policy");
  const saved = await saveFeature(root, file, SAMPLE);
  // The save answers with the editor's view: links included, scenarios numbered.
  expect(saved.content).toBe(WRITTEN);
  const onDisk = (await readFeature(root, file))!;
  expect(onDisk).not.toContain("[Jira:");
  expect(onDisk).not.toContain("[Linear:");
  // Reading for the editor folds the document's links back in.
  expect(await readFeatureForEditor(root, file)).toBe(WRITTEN);
  // And a later save that still carries them keeps them.
  const again = await saveFeature(root, file, SAMPLE.replace("is provided", "is emailed"));
  expect(parseFeature(again.content).links).toEqual([JIRA]);
  expect(docToFeature((await loadFeatureDoc(root, file))!.doc).links).toEqual([JIRA]);
});

test("the editor can remove a link: a save without it clears the document", async () => {
  setProjectionOptions({ publishExternalLinks: false });
  const file = await createFeature(root, "Quote Policy");
  await saveFeature(root, file, SAMPLE);
  const withoutFeatureLink = parseFeature(SAMPLE);
  delete withoutFeatureLink.links;
  const saved = await saveFeature(root, file, serializeFeature(withoutFeatureLink));
  expect(parseFeature(saved.content).links).toBeUndefined();
  expect(parseFeature(saved.content).scenarios[0]!.link).toEqual(LINEAR);
  expect(docToFeature((await loadFeatureDoc(root, file))!.doc).links).toBeUndefined();
});

test("flipping the setting rewrites every feature file to the new form", async () => {
  const file = await createFeature(root, "Quote Policy");
  await saveFeature(root, file, SAMPLE);
  const other = await createFeature(root, "Plain");
  await saveFeature(root, other, "# Plain\n\n## S @v1\n\nbody\n");

  setProjectionOptions({ publishExternalLinks: false });
  expect(await reprojectFeatures(root)).toBe(1);
  expect(await readFeature(root, file)).toBe(serializeFeature(parseFeature(SAMPLE), { links: false }));
  expect(await readFeature(root, other)).toBe("# Plain\n\n## S1: S @v1 [proposed]\n\nbody\n");

  setProjectionOptions({ publishExternalLinks: true });
  expect(await reprojectFeatures(root)).toBe(1);
  expect(await readFeature(root, file)).toBe(WRITTEN);
  expect(await reprojectFeatures(root)).toBe(0);
});

test("a file in the other form is not drift: peers with different settings leave it alone", async () => {
  const file = await createFeature(root, "Quote Policy");
  await saveFeature(root, file, SAMPLE);
  // A peer with the setting off rewrote the file without links.
  const withoutLinks = serializeFeature(parseFeature(SAMPLE), { links: false });
  await Bun.write(join(root, file), withoutLinks);
  expect(await importDrift(root)).toBe("");
  expect(await readFeature(root, file)).toBe(withoutLinks);
  expect(docToFeature((await loadFeatureDoc(root, file))!.doc).links).toEqual([JIRA]);
  // The editor still sees the links.
  expect(await readFeatureForEditor(root, file)).toBe(WRITTEN);
});

test("an outside edit that changes a link is absorbed like any other drift", async () => {
  const file = await createFeature(root, "Quote Policy");
  await saveFeature(root, file, SAMPLE);
  const retargeted = "[Jira:ABC-777](https://acme.atlassian.net/browse/ABC-777)";
  await Bun.write(join(root, file), SAMPLE.replace(JIRA_LINE, retargeted));
  expect(await importDrift(root)).toContain("absorbed 1");
  // Absorbed, and written back in the app's form: the scenarios numbered.
  expect(await readFeature(root, file)).toBe(WRITTEN.replace(JIRA_LINE, retargeted));
  expect(docToFeature((await loadFeatureDoc(root, file))!.doc).links).toEqual([{
    program: "Jira",
    ticket: "ABC-777",
    url: "https://acme.atlassian.net/browse/ABC-777",
  }]);
});

test("publishing keeps the links, and a published scenario's link stays editable", async () => {
  const file = await createFeature(root, "Quote Policy");
  await saveFeature(root, file, SAMPLE);
  const result = await publishFeature(root, file, SAMPLE);
  expect(result.status).toBe("published");
  const published = parseFeature((await readFeature(root, file))!);
  expect(published.links).toEqual([JIRA]);
  expect(published.scenarios.every((s) => s.status === "published")).toBe(true);
  expect(published.scenarios[0]!.link).toEqual(LINEAR);

  published.scenarios[1]!.link = JIRA;
  const saved = await saveFeature(root, file, serializeFeature(published));
  expect(parseFeature(saved.content).scenarios[1]!.link).toEqual(JIRA);
});

// --- the setting ----------------------------------------------------------------

test("publishExternalLinks defaults to ON and only an explicit false turns it off", () => {
  expect(normalizePublishExternalLinks(undefined)).toBe(true);
  expect(normalizePublishExternalLinks(true)).toBe(true);
  expect(normalizePublishExternalLinks(null)).toBe(true);
  expect(normalizePublishExternalLinks("no")).toBe(true);
  expect(normalizePublishExternalLinks(false)).toBe(false);
});

// --- the dialog fields ----------------------------------------------------------

test("the chip reads program:ticket", () => {
  expect(externalLinkLabel(JIRA)).toBe("Jira:ABC-123");
});

test("empty fields are no link; a whole link resolves; anything partial is an error", () => {
  expect(resolveLinkDraft(EMPTY_LINK_DRAFT)).toEqual({ link: null });
  expect(resolveLinkDraft({ program: " ", ticket: "", url: "  " })).toEqual({ link: null });
  expect(resolveLinkDraft(linkDraftOf(JIRA))).toEqual({ link: JIRA });
  expect(resolveLinkDraft({ program: " Jira ", ticket: " ABC-123 ", url: ` ${JIRA.url} ` })).toEqual({
    link: JIRA,
  });
  expect(resolveLinkDraft({ ...linkDraftOf(JIRA), url: "" }).error).toContain("url");
  expect(resolveLinkDraft({ ...linkDraftOf(JIRA), url: "acme.atlassian.net" }).error).toContain(
    "Not a web link",
  );
  expect(resolveLinkDraft({ ...linkDraftOf(JIRA), program: "" }).error).toContain("tool");
  expect(resolveLinkDraft({ ...linkDraftOf(JIRA), ticket: "" }).error).toContain("ticket id");
  expect(resolveLinkDraft({ ...linkDraftOf(JIRA), program: "Ji:ra" }).error).toContain("':'");
  expect(isBlankLinkDraft(EMPTY_LINK_DRAFT)).toBe(true);
  expect(isBlankLinkDraft(linkDraftOf(JIRA))).toBe(false);
  expect(linkDraftOf(undefined)).toEqual(EMPTY_LINK_DRAFT);
});

test("a pasted url suggests the tool and the ticket", () => {
  expect(suggestLink("https://acme.atlassian.net/browse/ABC-123")).toEqual({
    program: "Jira",
    ticket: "ABC-123",
  });
  expect(
    suggestLink("https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-9"),
  ).toEqual({ program: "Jira", ticket: "ABC-9" });
  expect(suggestLink("https://linear.app/acme/issue/ENG-42/some-title")).toEqual({
    program: "Linear",
    ticket: "ENG-42",
  });
  expect(suggestLink("https://github.com/acme/repo/issues/17")).toEqual({
    program: "GitHub",
    ticket: "#17",
  });
  expect(suggestLink("https://github.com/acme/repo/pull/18")).toEqual({
    program: "GitHub",
    ticket: "#18",
  });
  expect(suggestLink("https://tracker.example.com/tickets/OPS-7")).toEqual({ ticket: "OPS-7" });
  expect(suggestLink("https://example.com/")).toEqual({});
  expect(suggestLink("not a url")).toEqual({});
});

test("a pasted url fills only the fields still empty", () => {
  expect(withLinkUrl(EMPTY_LINK_DRAFT, JIRA.url)).toEqual(linkDraftOf(JIRA));
  expect(withLinkUrl({ program: "Tracker", ticket: "", url: "" }, JIRA.url)).toEqual({
    program: "Tracker",
    ticket: "ABC-123",
    url: JIRA.url,
  });
  expect(withLinkUrl(linkDraftOf(JIRA), "https://example.com/")).toEqual({
    ...linkDraftOf(JIRA),
    url: "https://example.com/",
  });
});

test("a url typed a character at a time ends with the whole ticket id", () => {
  // The first keystrokes of https://jira.com/ABC-124 suggest ABC-1; the
  // fields must follow the url to ABC-124 rather than keep the prefix.
  const full = "https://jira.com/ABC-124";
  let draft = EMPTY_LINK_DRAFT;
  for (let n = 1; n <= full.length; n++) draft = withLinkUrl(draft, full.slice(0, n));
  expect(draft).toEqual({ program: "Jira", ticket: "ABC-124", url: full });
  // A ticket the user typed themselves is not replaced when the url changes.
  const mine = withLinkUrl({ program: "", ticket: "ABC-9", url: "" }, full);
  expect(mine).toEqual({ program: "Jira", ticket: "ABC-9", url: full });
  // A tool picked from the dropdown stays as the url's host changes.
  const picked = withLinkUrl({ program: "Linear", ticket: "", url: "https://jira.com/browse/AB" }, full);
  expect(picked).toEqual({ program: "Linear", ticket: "ABC-124", url: full });
});

test("the tool dropdown offers GitHub, Jira, Linear and Other", () => {
  expect(EXTERNAL_LINK_TYPES).toEqual(["GitHub", "Jira", "Linear", "Other"]);
  expect(externalLinkTypeOf("Jira")).toBe("Jira");
  expect(externalLinkTypeOf(" github ")).toBe("GitHub");
  expect(externalLinkTypeOf("Linear")).toBe("Linear");
  expect(externalLinkTypeOf("YouTrack")).toBe("Other");
  expect(externalLinkTypeOf("")).toBe("Other");
});

test("the autosave signature follows the link", () => {
  const s = parseFeature(SAMPLE).scenarios[1]!;
  const sig = scenarioSignature(s, 2);
  expect(scenarioSignature({ ...s }, 2)).toBe(sig);
  expect(scenarioSignature({ ...s, link: JIRA }, 2)).not.toBe(sig);
});

// Project management chosen in Settings (specs/external-links/project-
// management-jira-linear-etc.feature.md): the switch decides whether tickets
// are tracked at all, and the tool named there is the one every new link
// carries — which is why the editors ask for the url alone.
test("project management is on by default and only an explicit false turns it off", () => {
  expect(normalizeProjectManagement(undefined)).toBe(true);
  expect(normalizeProjectManagement(true)).toBe(true);
  expect(normalizeProjectManagement(null)).toBe(true);
  expect(normalizeProjectManagement(false)).toBe(false);
});

test("the tool falls back to Jira unless a usable name is stored", () => {
  expect(DEFAULT_PROJECT_MANAGEMENT_TOOL).toBe("Jira");
  expect(normalizeProjectManagementTool(undefined)).toBe("Jira");
  expect(normalizeProjectManagementTool("")).toBe("Jira");
  expect(normalizeProjectManagementTool("   ")).toBe("Jira");
  expect(normalizeProjectManagementTool(7)).toBe("Jira");
  expect(normalizeProjectManagementTool(" Linear ")).toBe("Linear");
  expect(normalizeProjectManagementTool("YouTrack")).toBe("YouTrack");
  // The name becomes the `<program>` of `[Jira:ABC-123](url)`, so a name
  // that would break that form is not one.
  expect(normalizeProjectManagementTool("Ji:ra")).toBe("Jira");
  expect(normalizeProjectManagementTool("Ji[ra]")).toBe("Jira");
});

test("the url alone yields the ticket id", () => {
  expect(ticketFromUrl(JIRA.url)).toBe("ABC-123");
  expect(ticketFromUrl(LINEAR.url)).toBe("ENG-42");
  expect(ticketFromUrl("https://github.com/acme/repo/issues/17")).toBe("#17");
  // No key anywhere: the last path segment is what the tool put there.
  expect(ticketFromUrl("https://tracker.example.com/tickets/quote%20policy")).toBe("quote policy");
  expect(ticketFromUrl("https://example.com/")).toBe("");
  expect(ticketFromUrl("not a url")).toBe("");
});

test("with the tool chosen in Settings, only the url is needed", () => {
  const typed = withLinkUrlForTool(EMPTY_LINK_DRAFT, JIRA.url, "Jira");
  expect(typed).toEqual(linkDraftOf(JIRA));
  expect(resolveLinkDraft(typed)).toEqual({ link: JIRA });
  // The Settings tool wins over the one the url would suggest.
  expect(withLinkUrlForTool(EMPTY_LINK_DRAFT, LINEAR.url, "Jira")).toEqual({
    program: "Jira",
    ticket: "ENG-42",
    url: LINEAR.url,
  });
  // A link recorded under another tool keeps it — editing the url of a
  // Linear ticket must not rename it to the Settings tool.
  expect(withLinkUrlForTool(linkDraftOf(LINEAR), "https://linear.app/acme/issue/ENG-43", "Jira")).toEqual(
    { program: "Linear", ticket: "ENG-43", url: "https://linear.app/acme/issue/ENG-43" },
  );
  // A ticket derived from the old url follows the new one, even when it came
  // from the last path segment rather than an ABC-123 key.
  const slug = withLinkUrlForTool(EMPTY_LINK_DRAFT, "https://tracker.example.com/t/one", "Tracker");
  expect(slug).toEqual({ program: "Tracker", ticket: "one", url: "https://tracker.example.com/t/one" });
  expect(withLinkUrlForTool(slug, "https://tracker.example.com/t/two", "Tracker").ticket).toBe("two");
  // A ticket id typed by hand stays put.
  const mine = { program: "Jira", ticket: "ABC-9", url: "https://tracker.example.com/t/one" };
  expect(withLinkUrlForTool(mine, "https://tracker.example.com/t/two", "Jira").ticket).toBe("ABC-9");
});

test("a url typed a character at a time ends with the whole ticket id, tool and all", () => {
  const full = "https://acme.atlassian.net/browse/ABC-124";
  let draft = EMPTY_LINK_DRAFT;
  for (let n = 1; n <= full.length; n++) draft = withLinkUrlForTool(draft, full.slice(0, n), "Jira");
  expect(draft).toEqual({ program: "Jira", ticket: "ABC-124", url: full });
});

// --- several tickets on a feature ------------------------------------------------
// specs/external-links/project-management-jira-linear-etc.feature.md "Several
// tickets on a feature": a feature carries up to MAX_FEATURE_TICKETS tickets,
// one line each; the list is one value, set whole; the single `link` of an
// older document reads as a list of one.

const JIRA2 = { program: "Jira", ticket: "ABC-124", url: "https://acme.atlassian.net/browse/ABC-124" };
const JIRA3 = { program: "Jira", ticket: "ABC-125", url: "https://acme.atlassian.net/browse/ABC-125" };
const JIRA2_LINE = formatExternalLink(JIRA2);
const JIRA3_LINE = formatExternalLink(JIRA3);
const THREE = SAMPLE.replace(JIRA_LINE, `${JIRA_LINE}\n${JIRA2_LINE}\n${JIRA3_LINE}`);
const THREE_WRITTEN = WRITTEN.replace(JIRA_LINE, `${JIRA_LINE}\n${JIRA2_LINE}\n${JIRA3_LINE}`);

test("a feature carries several tickets, one line each, in order, and writes them back together", () => {
  const feature = parseFeature(THREE);
  expect(feature.links).toEqual([JIRA, JIRA2, JIRA3]);
  expect(feature.description).toBe("Quotes for potential customers.");
  expect(serializeFeature(feature)).toBe(THREE_WRITTEN);
  expect(parseFeature(THREE_WRITTEN)).toEqual(feature);
  // Spread out, or mixed with the other metadata, they are still the tickets.
  const spread = SAMPLE.replace(JIRA_LINE, `${JIRA_LINE}\n\n**Assigned:** Dana\n\n${JIRA2_LINE}`);
  expect(parseFeature(spread).links).toEqual([JIRA, JIRA2]);
  expect(parseFeature(spread).assigned).toBe("Dana");
  expect(serializeFeature(parseFeature(spread), { links: false })).not.toContain("[Jira:");
});

test("a repeated ticket is dropped on parse, the first kept; a scenario still takes one", () => {
  const sameUrl = { ...JIRA, ticket: "abc-123" };
  const sameId = { ...JIRA, url: "https://acme.atlassian.net/browse/ABC-123/" };
  const text = SAMPLE.replace(JIRA_LINE, `${JIRA_LINE}\n${formatExternalLink(sameUrl)}\n${formatExternalLink(sameId)}\n${JIRA2_LINE}`);
  expect(parseFeature(text).links).toEqual([JIRA, JIRA2]);
  expect(dedupeTicketLinks([JIRA, sameUrl, JIRA2, sameId])).toEqual([JIRA, JIRA2]);
  expect(sameTicket(JIRA, LINEAR)).toBe(false);
  // Under a scenario a second ticket line is content, as before.
  const scenario = SAMPLE.replace("[Linear:ENG-42]", `${JIRA2_LINE}\n\n[Linear:ENG-42]`);
  const [basic] = parseFeature(scenario).scenarios;
  expect(basic!.link).toEqual(JIRA2);
  expect(basic!.body.startsWith("[Linear:ENG-42]")).toBe(true);
});

test("the list is set whole — reconcile replaces it, an empty target clears it, a no-op leaves the heads", () => {
  let doc = importFeatureDoc(parseFeature(SAMPLE));
  doc = reconcile(doc, parseFeature(THREE));
  expect(docToFeature(doc).links).toEqual([JIRA, JIRA2, JIRA3]);
  expect(projectFeature(doc)).toBe(THREE_WRITTEN);
  const heads = A.getHeads(doc);
  expect(A.getHeads(reconcile(doc, parseFeature(THREE)))).toEqual(heads);
  // Reordered is changed: the order is the file's.
  const reordered = parseFeature(THREE);
  reordered.links = [JIRA3, JIRA, JIRA2];
  doc = reconcile(doc, reordered);
  expect(docToFeature(doc).links).toEqual([JIRA3, JIRA, JIRA2]);
  doc = reconcile(doc, parseFeature(serializeFeature(parseFeature(SAMPLE), { links: false })));
  expect(docToFeature(doc).links).toBeUndefined();
});

test("an older document's single link reads as a list of one, and the first change retires it", () => {
  const plain = parseFeature(serializeFeature(parseFeature(SAMPLE), { links: false }));
  // A document written before the list: the scenario link in place, the
  // feature's ticket under the old key.
  const before = parseFeature(SAMPLE);
  delete before.links;
  const legacy = A.change(importFeatureDoc(before), (d) => {
    d.link = { ...JIRA };
  });
  expect(ticketLinksOf(legacy)).toEqual([JIRA]);
  expect(docToFeature(legacy).links).toEqual([JIRA]);
  expect(projectFeature(legacy)).toBe(WRITTEN);
  // Reconciling what it already projects is a no-op: the old key stays.
  const same = reconcile(A.clone(legacy), parseFeature(SAMPLE));
  expect(A.getHeads(same)).toEqual(A.getHeads(legacy));
  expect(same.link).toEqual(JIRA);
  expect(same.links).toBeUndefined();
  // The first change writes the list and drops the old key.
  const changed = reconcile(A.clone(legacy), parseFeature(THREE));
  expect(changed.link).toBeUndefined();
  expect(docToFeature(changed).links).toEqual([JIRA, JIRA2, JIRA3]);
  // Clearing them drops both.
  const cleared = reconcile(A.clone(legacy), plain);
  expect(cleared.link).toBeUndefined();
  expect(cleared.links).toBeUndefined();
});

test("a three-way merge takes the side that changed the list, ours when both did", () => {
  const base = parseFeature(SAMPLE);
  const theirs = parseFeature(THREE);
  const added = threeWayFeature(base, base, theirs);
  expect(added.ok && added.feature.links).toEqual([JIRA, JIRA2, JIRA3]);
  const ours = parseFeature(SAMPLE);
  ours.links = [JIRA, LINEAR];
  const both = threeWayFeature(base, ours, theirs);
  expect(both.ok && both.feature.links).toEqual([JIRA, LINEAR]);
});

test("with the setting off, the editor's view folds every ticket back; drift absorbs a hand-added one", async () => {
  setProjectionOptions({ publishExternalLinks: false });
  const file = await createFeature(root, "Quote Policy");
  const saved = await saveFeature(root, file, THREE);
  expect(saved.content).toBe(THREE_WRITTEN);
  expect(await readFeature(root, file)).not.toContain("[Jira:");
  expect(parseFeature((await readFeatureForEditor(root, file))!).links).toEqual([JIRA, JIRA2, JIRA3]);

  setProjectionOptions({ publishExternalLinks: true });
  expect(await reprojectFeatures(root)).toBe(1);
  expect(await readFeature(root, file)).toBe(THREE_WRITTEN);
  // A teammate adds a fourth by hand: absorbed, and kept in order.
  const fourth = { program: "Jira", ticket: "ABC-126", url: "https://acme.atlassian.net/browse/ABC-126" };
  await Bun.write(join(root, file), THREE_WRITTEN.replace(JIRA3_LINE, `${JIRA3_LINE}\n${formatExternalLink(fourth)}`));
  expect(await importDrift(root)).toContain("absorbed 1");
  expect(docToFeature((await loadFeatureDoc(root, file))!.doc).links).toEqual([JIRA, JIRA2, JIRA3, fourth]);
});

test("the chip reads the one ticket, or counts them, or offers to link one", () => {
  expect(ticketChipLabel(undefined)).toBe("Link ticket");
  expect(ticketChipLabel([])).toBe("Link ticket");
  expect(ticketChipLabel([JIRA])).toBe("Jira:ABC-123");
  expect(ticketChipLabel([JIRA, JIRA2, JIRA3])).toBe("3 tickets");
});

test("a repeat, or a sixth, cannot join the list", () => {
  expect(ticketAddProblem([JIRA], JIRA2)).toBeNull();
  expect(ticketAddProblem([JIRA], { ...JIRA, ticket: "abc-123" })).toContain("already linked");
  expect(ticketAddProblem([JIRA], { ...LINEAR, url: JIRA.url })).toContain("already linked");
  const five = [1, 2, 3, 4, 5].map((n) => ({ ...JIRA, ticket: `X-${n}`, url: `https://acme.atlassian.net/browse/X-${n}` }));
  expect(MAX_FEATURE_TICKETS).toBe(5);
  expect(ticketAddProblem(five, JIRA2)).toContain("up to 5");
});

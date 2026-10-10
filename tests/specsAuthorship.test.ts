// specs/app/specs-authorship.feature.md: the app records who created each
// feature and each atomic spec (scenario), and who last updated it — the
// identity the app works as, which may be an agent given its own GitHub
// token. A setting of the specs repo (`authors-in-markdown` in its
// project-settings.json) decides whether the `.feature.md` files carry it.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatCreatedBy,
  formatUpdatedBy,
  parseFeature,
  serializeFeature,
} from "../src/server/parser";
import { docToFeature, isProjectionOf, projectFeature } from "../src/server/automerge/project";
import { importFeatureDoc, reconcile } from "../src/server/automerge/reconcile";
import { threeWayFeature } from "../src/server/automerge/merge";
import { importDrift } from "../src/server/automerge/driftSync";
import { loadFeatureDoc } from "../src/server/automerge/store";
import {
  createFeature,
  readFeature,
  readFeatureView,
  reprojectFeatures,
  saveFeature,
} from "../src/server/features";
import {
  AUTHORS_IN_MARKDOWN_KEY,
  PROJECT_SETTINGS_FILE,
  normalizeAuthorsInMarkdown,
  readProjectSettings,
  writeAuthorsInMarkdown,
} from "../src/server/members";
import { currentAuthor } from "../src/server/user";
import { authorshipLine } from "../src/frontend/authorship";

const ADA = "ada";
const GRACE = "grace";

const PLAIN = `# Quote Policy

Quotes for potential customers.

## Request Quote @v1 [proposed]

- **Given** a potential customer
- **Then** a quote is provided
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-authorship-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- the markdown format -----------------------------------------------------

test("authorship lines under a heading are lifted out of the description and the body", () => {
  const text = `# Quote Policy

${formatCreatedBy(ADA)}

${formatUpdatedBy(GRACE)}

Quotes for potential customers.

## Request Quote @v1 [proposed]

[Jira:ABC-1](https://acme.atlassian.net/browse/ABC-1)

${formatUpdatedBy(ADA)}

${formatCreatedBy(GRACE)}

- **Given** a potential customer
`;
  const feature = parseFeature(text);
  expect(feature.createdBy).toBe(ADA);
  expect(feature.updatedBy).toBe(GRACE);
  expect(feature.description).toBe("Quotes for potential customers.");
  const s = feature.scenarios[0]!;
  expect(s.createdBy).toBe(GRACE);
  expect(s.updatedBy).toBe(ADA);
  expect(s.link?.ticket).toBe("ABC-1");
  expect(s.body).toBe("- **Given** a potential customer");
  // Written back in a fixed order, and dropped entirely with authors off.
  expect(parseFeature(serializeFeature(feature))).toEqual(feature);
  const bare = serializeFeature(feature, { authors: false });
  expect(bare).not.toContain("Created by");
  expect(bare).not.toContain("Updated by");
});

test("a line further down the body is ordinary content", () => {
  const text = `# F

## S @v1 [proposed]

Some text.

${formatCreatedBy(ADA)}
`;
  const s = parseFeature(text).scenarios[0]!;
  expect(s.createdBy).toBeUndefined();
  expect(s.body).toContain(formatCreatedBy(ADA));
});

// --- the document ------------------------------------------------------------

test("New feature has an author: an import signed by its writer records it at the feature level", () => {
  const doc = importFeatureDoc(parseFeature(PLAIN), ADA);
  expect(doc.createdBy).toBe(ADA);
  expect(doc.updatedBy).toBe(ADA);
  expect(doc.specs[0]!.createdBy).toBe(ADA);
});

test("new spec has an author: a scenario added by a save is created by whoever saved", () => {
  const doc = importFeatureDoc(parseFeature(PLAIN), ADA);
  const target = parseFeature(
    `${PLAIN}\n## Decline Quote @v1 [proposed]\n\n- **Then** the quote is declined\n`,
  );
  const next = reconcile(doc, target, { author: GRACE });
  const added = next.specs.find((s) => s.name === "Decline Quote")!;
  expect(added.createdBy).toBe(GRACE);
  expect(added.updatedBy).toBe(GRACE);
  // The untouched scenario keeps its own record; the feature changed, so
  // its last updater is the new one, its creator still the first.
  const kept = next.specs.find((s) => s.name === "Request Quote")!;
  expect(kept.createdBy).toBe(ADA);
  expect(kept.updatedBy).toBe(ADA);
  expect(next.createdBy).toBe(ADA);
  expect(next.updatedBy).toBe(GRACE);
});

test("an edit records its author as the last updater and keeps the creator", () => {
  const doc = importFeatureDoc(parseFeature(PLAIN), ADA);
  const next = reconcile(doc, parseFeature(PLAIN.replace("is provided", "is emailed")), {
    author: GRACE,
  });
  expect(next.specs[0]!.createdBy).toBe(ADA);
  expect(next.specs[0]!.updatedBy).toBe(GRACE);
});

test("a save that changes nothing signs nothing", () => {
  const doc = importFeatureDoc(parseFeature(PLAIN), ADA);
  const next = reconcile(doc, parseFeature(PLAIN), { author: GRACE });
  expect(next.updatedBy).toBe(ADA);
  expect(next.specs[0]!.updatedBy).toBe(ADA);
});

test("a rename keeps the scenario's creator", () => {
  const doc = importFeatureDoc(parseFeature(PLAIN), ADA);
  const next = reconcile(doc, parseFeature(PLAIN.replace("Request Quote", "Ask For Quote")), {
    author: GRACE,
  });
  expect(next.specs).toHaveLength(1);
  expect(next.specs[0]!.createdBy).toBe(ADA);
  expect(next.specs[0]!.updatedBy).toBe(GRACE);
});

test("drift absorbed without an author stamps nobody, and stale lines never rewrite the record", () => {
  const doc = importFeatureDoc(parseFeature(PLAIN), ADA);
  const edited = parseFeature(PLAIN.replace("is provided", "is emailed"));
  const drifted = reconcile(doc, edited);
  expect(drifted.specs[0]!.updatedBy).toBe(ADA);
  // A buffer that still names an earlier updater does not move it back.
  const later = reconcile(drifted, parseFeature(PLAIN.replace("is provided", "is sent")), {
    author: GRACE,
  });
  const stale = parseFeature(serializeFeature(docToFeature(later)).replaceAll(GRACE, "mallory"));
  const after = reconcile(later, stale);
  expect(after.specs[0]!.updatedBy).toBe(GRACE);
  expect(after.updatedBy).toBe(GRACE);
});

test("a file found on disk that names its authors gives the document them", () => {
  const authored = serializeFeature({
    ...parseFeature(PLAIN),
    createdBy: ADA,
    updatedBy: GRACE,
  });
  const doc = importFeatureDoc(parseFeature(authored));
  expect(doc.createdBy).toBe(ADA);
  expect(doc.updatedBy).toBe(GRACE);
});

test("the projection writes authors only when asked, and either form is a projection", () => {
  const doc = importFeatureDoc(parseFeature(PLAIN), ADA);
  const without = projectFeature(doc, { publishExternalLinks: true });
  const withAuthors = projectFeature(doc, { publishExternalLinks: true, publishAuthors: true });
  expect(without).toBe(PLAIN);
  expect(withAuthors).toContain(formatCreatedBy(ADA));
  expect(withAuthors).toContain(formatUpdatedBy(ADA));
  expect(isProjectionOf(without, doc)).toBe(true);
  expect(isProjectionOf(withAuthors, doc)).toBe(true);
});

test("the three-way merge keeps the side that changed the authorship", () => {
  const base = parseFeature(PLAIN);
  base.scenarios[0]!.updatedBy = ADA;
  const ours = parseFeature(PLAIN);
  ours.scenarios[0]!.updatedBy = ADA;
  const theirs = parseFeature(PLAIN.replace("is provided", "is emailed"));
  theirs.scenarios[0]!.updatedBy = GRACE;
  theirs.updatedBy = GRACE;
  const merged = threeWayFeature(base, ours, theirs);
  expect(merged.ok && merged.feature.scenarios[0]!.updatedBy).toBe(GRACE);
  expect(merged.ok && merged.feature.updatedBy).toBe(GRACE);
});

// --- the repo setting --------------------------------------------------------

test("authors-in-markdown is off unless the settings file says true", async () => {
  expect((await readProjectSettings(root)).authorsInMarkdown).toBe(false);
  expect(normalizeAuthorsInMarkdown({ [AUTHORS_IN_MARKDOWN_KEY]: true })).toBe(true);
  expect(normalizeAuthorsInMarkdown({ authorsInMarkdown: "true" })).toBe(true);
  expect(normalizeAuthorsInMarkdown({ [AUTHORS_IN_MARKDOWN_KEY]: "yes" })).toBe(false);
  expect(normalizeAuthorsInMarkdown(["Ada"])).toBe(false);
});

test("turning the setting on keeps the file's other keys", async () => {
  const path = join(root, PROJECT_SETTINGS_FILE);
  await writeFile(path, JSON.stringify({ members: ["Ada"], "code-repo": "../app" }));
  expect(await writeAuthorsInMarkdown(root, true)).toBe(true);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    members: ["Ada"],
    "code-repo": "../app",
    [AUTHORS_IN_MARKDOWN_KEY]: true,
  });
  expect(await writeAuthorsInMarkdown(root, true)).toBe(false);
  expect(await writeAuthorsInMarkdown(root, false)).toBe(true);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ members: ["Ada"], "code-repo": "../app" });
});

test("a settings file that is not JSON is refused, not overwritten", async () => {
  const path = join(root, PROJECT_SETTINGS_FILE);
  await writeFile(path, "{ members: oops");
  await expect(writeAuthorsInMarkdown(root, true)).rejects.toThrow("not valid JSON");
  expect(await readFile(path, "utf8")).toBe("{ members: oops");
});

// --- through the feature layer -------------------------------------------------

test("a feature created in the app is signed by the app's user, in the document only by default", async () => {
  const me = await currentAuthor();
  const file = await createFeature(root, "Quote Policy");
  await saveFeature(root, file, PLAIN);
  const loaded = await loadFeatureDoc(root, file);
  expect(loaded!.doc.createdBy).toBe(me);
  expect(loaded!.doc.specs[0]!.createdBy).toBe(me);
  // The file is untouched by authorship while the repo does not ask for it…
  expect(await readFeature(root, file)).toBe(PLAIN);
  // …and the editor still sees who wrote what.
  const view = await readFeatureView(root, file);
  expect(view!.parsed.createdBy).toBe(me);
  expect(view!.parsed.scenarios[0]!.updatedBy).toBe(me);
  expect(view!.content).toBe(PLAIN);
});

test("with authors-in-markdown on, the files carry the lines, and switching reprojects them", async () => {
  const me = await currentAuthor();
  const file = await createFeature(root, "Quote Policy");
  await saveFeature(root, file, PLAIN);
  await writeAuthorsInMarkdown(root, true);
  expect(await reprojectFeatures(root)).toBe(1);
  const on = (await readFeature(root, file))!;
  expect(on).toContain(formatCreatedBy(me));
  expect(on).toContain(formatUpdatedBy(me));
  // The sync tick sees a projection, not drift.
  await importDrift(root);
  expect(await readFeature(root, file)).toBe(on);
  // A save keeps writing them.
  await saveFeature(root, file, PLAIN.replace("is provided", "is emailed"));
  expect(await readFeature(root, file)).toContain(formatUpdatedBy(me));

  await writeAuthorsInMarkdown(root, false);
  expect(await reprojectFeatures(root)).toBe(1);
  const off = (await readFeature(root, file))!;
  expect(off).not.toContain("Created by");
  expect(off).not.toContain("Updated by");
});

// --- the feature page ----------------------------------------------------------

test("the page reads authorship as one short line", () => {
  expect(authorshipLine({})).toBeNull();
  expect(authorshipLine({ createdBy: ADA })).toBe("Created by ada");
  expect(authorshipLine({ updatedBy: GRACE })).toBe("Last updated by grace");
  expect(authorshipLine({ createdBy: ADA, updatedBy: ADA })).toBe("Created and last updated by ada");
  expect(authorshipLine({ createdBy: ADA, updatedBy: GRACE })).toBe(
    "Created by ada · updated by grace",
  );
});

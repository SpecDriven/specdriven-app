// Reconciliation drives the Automerge document toward a parsed Feature — the
// bridge from today's whole-file writes (the REST API sends full markdown, and
// external GitHub edits arrive as full files) into CRDT operations. Field
// edits become Automerge.updateText splices so concurrent peers' changes to
// the same body merge at character level instead of last-writer-wins.

import * as A from "@automerge/automerge";
import { randomUUID } from "node:crypto";
import {
  attributesKey,
  featureFlagsKey,
  plainAttributes,
  plainFeatureFlags,
  splitScenarioMeta,
  type ConfluencePage,
  type QtestModule,
  type ExternalLink,
  type Feature,
  type FeatureFlag,
  type PullRequestLink,
  type ResourceLink,
  type Scenario,
  type ScenarioFile,
  type ScenarioPick,
  type ScenarioTarget,
  type SpecAttribute,
} from "../parser";
import type { ResourceLinkKind } from "../resourceLinks";
import { compareSpecs, interleaveDrafts } from "./project";
import { effectiveBody, type FeatureDoc, snapshotOf, type SpecEntry } from "./schema";
import { newFeatureDoc } from "./store";

/**
 * Create a document from a parsed feature file (first import). `author` is
 * who is writing it (specs/app/specs-authorship.feature.md): the creator of
 * whatever the file does not already name a creator for, and the last
 * updater of everything. Without one — a file found on disk, whose writer
 * the app cannot know — only the authorship the markdown itself carries is
 * recorded.
 */
export function importFeatureDoc(feature: Feature, author?: string): A.Doc<FeatureDoc> {
  const createdBy = feature.createdBy ?? author;
  const updatedBy = author ?? feature.updatedBy;
  return newFeatureDoc({
    name: feature.name,
    description: feature.description,
    specs: feature.scenarios.map((s, i) => newEntry(s, author, i + 1)),
    ...(feature.flags?.length ? { flags: plainFeatureFlags(feature.flags)! } : {}),
    ...(feature.attributes?.length ? { attributes: plainAttributes(feature.attributes)! } : {}),
    ...(feature.link ? { link: { ...feature.link } } : {}),
    ...(feature.qtest ? { qtest: { ...feature.qtest } } : {}),
    ...(feature.confluence ? { confluence: { ...feature.confluence } } : {}),
    ...(feature.assigned ? { assigned: feature.assigned } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  });
}

function newEntry(s: Scenario, author: string | undefined, rank: number): SpecEntry {
  const createdBy = s.createdBy ?? author;
  const updatedBy = author ?? s.updatedBy;
  return {
    id: randomUUID(),
    type: "Scenario",
    name: s.name,
    version: s.version,
    status: s.status,
    body: s.body,
    rank,
    // A scenario imported already published records its body (schema.ts
    // `publishedBody`), the same as one published through reconcile.
    ...(s.status === "published" ? { publishedBody: new A.ImmutableString(s.body) } : {}),
    tests: [...s.tests],
    ...(s.negative ? { negative: true as const } : {}),
    ...(s.flags?.length ? { flags: plainFeatureFlags(s.flags)! } : {}),
    ...(s.attributes?.length ? { attributes: plainAttributes(s.attributes)! } : {}),
    ...(s.link ? { link: { ...s.link } } : {}),
    ...(s.qtest ? { qtest: { ...s.qtest } } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  };
}

/**
 * Set or clear the negative marker on a spec entry
 * (specs/ui/scenario-polarity.feature.md). One scalar set whole, like a
 * link: concurrent flips resolve to one winner the same way on every peer.
 */
function assignNegative(
  target: { negative?: true },
  before: true | undefined,
  after: true | undefined,
): void {
  if (!!before === !!after) return;
  if (after) target.negative = true;
  else delete target.negative;
}

/**
 * Set a doc map's authorship (specs/app/specs-authorship.feature.md). The
 * creator is history: once the document records one it stays, and the
 * target's only fills in a creator the document never had. The last updater
 * is `author` when this write changed the thing, else the same rule as the
 * creator — markdown cannot move it, so a stale line in an editor's buffer
 * or a hand edit never rewrites who last touched a spec.
 */
function assignAuthors(
  holder: { createdBy?: string; updatedBy?: string },
  target: { createdBy?: string; updatedBy?: string },
  stamp: string | undefined,
): void {
  if (!holder.createdBy && target.createdBy) holder.createdBy = target.createdBy;
  const updatedBy = stamp ?? holder.updatedBy ?? target.updatedBy;
  if (updatedBy && holder.updatedBy !== updatedBy) holder.updatedBy = updatedBy;
}

/** Identity of a link for change detection; none is the empty string. */
function linkKey(link: ExternalLink | undefined): string {
  return link ? `${link.program}\n${link.ticket}\n${link.url}` : "";
}

/**
 * Set or clear a `link` key — or the `qtest` one
 * (specs/external-links/qtest-test-cases.feature.md), or a feature's
 * `confluence` one (specs/external-links/confluence-wiki.feature.md) — on a
 * doc map. A link
 * is replaced whole (it is one ticket, not text to merge), and concurrent
 * replacements resolve to one winner the same way on every peer.
 */
function assignLink(
  target: { link?: ExternalLink; qtest?: ExternalLink; confluence?: ExternalLink },
  before: ExternalLink | undefined,
  after: ExternalLink | undefined,
  key: "link" | "qtest" | "confluence" = "link",
): void {
  if (linkKey(before) === linkKey(after)) return;
  if (after) target[key] = { program: after.program, ticket: after.ticket, url: after.url };
  else delete target[key];
}

/** A plain copy of a link held in the doc; undefined when none. */
function plainLink(link: ExternalLink | undefined): ExternalLink | undefined {
  return link ? { program: link.program, ticket: link.ticket, url: link.url } : undefined;
}

/**
 * Set or clear a `flags` key on a doc map. The list is replaced whole, like a
 * link (specs/app/feature-flags.feature.md): concurrent edits resolve to one
 * list the same way on every peer.
 */
function assignFlags(
  target: { flags?: FeatureFlag[] },
  before: FeatureFlag[] | undefined,
  after: FeatureFlag[] | undefined,
): void {
  if (featureFlagsKey(before) === featureFlagsKey(after)) return;
  const flags = plainFeatureFlags(after);
  if (flags) target.flags = flags;
  else delete target.flags;
}

/**
 * Set or clear an `attributes` key on a doc map: replaced whole, like the
 * flags (specs/app/custom-attributes.feature.md).
 */
function assignAttributes(
  target: { attributes?: SpecAttribute[] },
  before: SpecAttribute[] | undefined,
  after: SpecAttribute[] | undefined,
): void {
  if (attributesKey(before) === attributesKey(after)) return;
  const attributes = plainAttributes(after);
  if (attributes) target.attributes = attributes;
  else delete target.attributes;
}

const sameScenario = (a: ScenarioPick, b: ScenarioPick) =>
  a.name === b.name && a.version === b.version;

/**
 * The published-immutability invariant (specs/ui/ui.feature.md), stated on the
 * doc: every published scenario must survive reconciliation under its (name,
 * version) identity, still published, with its body intact — the body as it was
 * published (`effectiveBody`), not the live collaborative text, which a CRDT
 * merge of two peers' identical absorbs can leave doubled; that artifact is
 * the doc's to heal (`healPublished`), never the file's fault. A status marker
 * edited down to [proposed] or [draft] is refused too: the demoted scenario
 * would otherwise be free to change (or, as a doc-only draft, drop out of the
 * markdown) and be published again under the same version. Same rule and message as
 * assertPublishedUnchanged in features.ts, checked here so a drifted markdown
 * file can never rewrite published history through the reconciliation door.
 */
/**
 * Whether a published scenario's body survives in the target: unchanged, or
 * the recorded body with the metadata lines an older build kept as text read
 * off its top — a flag or attribute line published before the parser lifted
 * it (specs/app/custom-attributes.feature.md). Without the second reading a
 * body recorded that way would refuse every later save of its feature.
 */
function keptBody(body: string, recorded: string): boolean {
  return body === recorded || body === splitScenarioMeta(recorded).text;
}

export function assertPublishedKept(doc: A.Doc<FeatureDoc>, target: Feature): void {
  for (const entry of doc.specs) {
    if (entry.status !== "published") continue;
    const match = target.scenarios.find((s) => sameScenario(entry, s));
    if (!match || match.status !== "published" || !keptBody(match.body, effectiveBody(entry))) {
      throw new Error(`Scenario "${entry.name}" @v${entry.version} is published and immutable`);
    }
  }
}

/**
 * Mutate the doc so its projection equals the projection of the target.
 * Scenarios are matched by (name, version) — the projection's identity — with
 * a second pass that treats an unmatched pair with identical bodies as a
 * rename, keeping the entry's id and its body's edit history. The match plan
 * is computed from plain copies up front, then applied by index inside one
 * change: updates first, removals in descending order, additions last.
 *
 * A draft entry the target doesn't claim is kept, not removed: drafts are
 * doc-only, so a markdown-derived target cannot see them — and what markdown
 * cannot see it must not delete. A target scenario that does claim one (same
 * name and version, or same body) promotes or renames it in place.
 *
 * `scenario` is the editor's word on which entry one target scenario is: the
 * entry carrying `scenario.id` — the document id the editor read it under
 * (Scenario.id) — is the target scenario with that name and version, whatever
 * its name, version or body were when it was last saved
 * (specs/editor/editor-autosave.feature.md "Autosave Never Adds the Same
 * Scenario Twice"). The passes below can only see a rename by an unchanged
 * body, which a title retyped while the body is still being written never has —
 * and a draft left unclaimed that way would linger under its old name while its
 * new self was filed as a second scenario. The claim is skipped when it no
 * longer fits: the id is gone from the doc, the target has no scenario of that
 * name and version, another entry already carries that identity (the identity
 * pass's to claim), or the entry is published — whose identity no editor may
 * move (specs/ui/ui.feature.md: published scenarios are immutable).
 *
 * `force` skips the published-immutability gate — only for an explicit human
 * decision (the conflict-resolution dialog), never for an automated write.
 *
 * `author` is who is making the edit (specs/app/specs-authorship.feature.md):
 * the creator of every spec it adds and the last updater of every spec it
 * changes, and of the feature when anything in it changed. Without one — an
 * external edit the drift pass absorbs, whose writer the app cannot know —
 * nobody is stamped.
 */
export function reconcile(
  doc: A.Doc<FeatureDoc>,
  target: Feature,
  {
    force = false,
    scenario,
    author,
  }: { force?: boolean; scenario?: ScenarioTarget; author?: string } = {},
): A.Doc<FeatureDoc> {
  if (!force) assertPublishedKept(doc, target);

  const entries: (Scenario & { publishedBody?: string; rank?: number })[] = doc.specs.map((e) => ({
    id: e.id,
    name: e.name,
    version: e.version,
    status: e.status,
    body: e.body,
    publishedBody: snapshotOf(e),
    ...(e.rank === undefined ? {} : { rank: e.rank }),
    tests: [...e.tests],
    ...(e.link ? { link: plainLink(e.link)! } : {}),
    ...(e.qtest ? { qtest: plainLink(e.qtest)! } : {}),
    ...(e.flags?.length ? { flags: plainFeatureFlags(e.flags)! } : {}),
    ...(e.attributes?.length ? { attributes: plainAttributes(e.attributes)! } : {}),
    ...(e.negative ? { negative: true as const } : {}),
  }));
  // Read before any key is assigned below — schema.ts keeps them optional.
  const authorsAt = doc.specs.map((e) => ({ createdBy: e.createdBy, updatedBy: e.updatedBy }));
  const docLink = plainLink(doc.link);
  const docQtest = plainLink(doc.qtest);
  const docConfluence = plainLink(doc.confluence);
  const docAssigned = doc.assigned;
  const docFlags = plainFeatureFlags(doc.flags);
  const docAttributes = plainAttributes(doc.attributes);
  const matchAt = new Map<number, Scenario>();
  const matched = new Set<Scenario>();
  const claim = (candidate: (s: Scenario, i: number) => boolean) => {
    entries.forEach((entry, i) => {
      if (matchAt.has(i)) return;
      const match = target.scenarios.find((s) => !matched.has(s) && candidate(s, i));
      if (match) {
        matchAt.set(i, match);
        matched.add(match);
      }
    });
  };
  if (scenario?.id) {
    // Trimmed, as the target's headings parsed (parser.ts SCENARIO_RE): an
    // editor name with a stray space must still claim its entry, or the
    // rename falls to the passes below and a retyped body files it twice.
    const { id, version } = scenario;
    const name = scenario.name.trim();
    const at = entries.findIndex((e) => e.id === id);
    const entry = at === -1 ? undefined : entries[at];
    const claimed = target.scenarios.find((s) => sameScenario(s, { name, version }));
    const blocked =
      entries.some((e, i) => i !== at && sameScenario(e, { name, version })) ||
      (entry?.status === "published" && !sameScenario(entry, { name, version }));
    if (entry && claimed && !blocked) {
      matchAt.set(at, claimed);
      matched.add(claimed);
    }
  }
  claim((s, i) => sameScenario(entries[i]!, s));
  claim((s, i) => s.body === effectiveBody(entries[i]!)); // rename / version bump

  const additions = target.scenarios.filter((s) => !matched.has(s));

  // The order this write leaves (schema.ts `rank`): the target's, with the
  // document's unclaimed drafts — kept below, invisible to a markdown-derived
  // target — placed next to where they were (project.ts interleaveDrafts).
  // A rank is 1-based, like the `S<n>:` the projection writes for it.
  type Slot = { entry: number } | { add: Scenario };
  const entryOf = new Map<Scenario, number>();
  for (const [i, match] of matchAt) entryOf.set(match, i);
  const held: Slot[] = target.scenarios.map((s) => {
    const at = entryOf.get(s);
    return at === undefined ? { add: s } : { entry: at };
  });
  const docOrder: Slot[] = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => matchAt.has(i) || e.status === "draft")
    .sort((a, b) => compareSpecs(a.e, b.e))
    .map(({ i }) => ({ entry: i }));
  const slotKey = (slot: Slot) =>
    "entry" in slot ? `entry:${slot.entry}` : `add:${additions.indexOf(slot.add)}`;
  const rankAt = new Map<number, number>();
  const rankOf = new Map<Scenario, number>();
  interleaveDrafts(held, docOrder, slotKey).forEach((slot, i) => {
    if ("entry" in slot) rankAt.set(slot.entry, i + 1);
    else rankOf.set(slot.add, i + 1);
  });
  const moved = [...rankAt].some(([i, rank]) => entries[i]!.rank !== rank);

  // What this write changes, for the authorship stamps: a matched entry
  // whose projection moves, and the feature when anything in it does. A
  // move is the feature's change, not the scenarios': their ranks shift
  // without a word of them changing, so no scenario gets stamped for it.
  const entryChanged = (entry: (typeof entries)[number], match: Scenario) =>
    entry.name !== match.name ||
    entry.version !== match.version ||
    entry.status !== match.status ||
    effectiveBody(entry) !== match.body ||
    entry.tests.join("\n") !== match.tests.join("\n") ||
    linkKey(entry.link) !== linkKey(match.link) ||
    linkKey(entry.qtest) !== linkKey(match.qtest) ||
    featureFlagsKey(entry.flags) !== featureFlagsKey(match.flags) ||
    attributesKey(entry.attributes) !== attributesKey(match.attributes) ||
    !!entry.negative !== !!match.negative;
  const changedAt = new Set<number>();
  for (const [i, match] of matchAt) if (entryChanged(entries[i]!, match)) changedAt.add(i);
  const removed = entries.some((e, i) => !matchAt.has(i) && e.status !== "draft");
  const featureChanged =
    doc.name !== target.name ||
    doc.description !== target.description ||
    linkKey(docLink) !== linkKey(target.link) ||
    linkKey(docQtest) !== linkKey(target.qtest) ||
    linkKey(docConfluence) !== linkKey(target.confluence) ||
    featureFlagsKey(docFlags) !== featureFlagsKey(target.flags) ||
    attributesKey(docAttributes) !== attributesKey(target.attributes) ||
    (docAssigned ?? "") !== (target.assigned ?? "") ||
    changedAt.size > 0 ||
    removed ||
    moved ||
    additions.length > 0;

  return A.change(doc, (d) => {
    if (d.name !== target.name) A.updateText(d, ["name"], target.name);
    if (d.description !== target.description) {
      A.updateText(d, ["description"], target.description);
    }
    assignLink(d, docLink, target.link);
    assignLink(d, docQtest, target.qtest, "qtest");
    assignLink(d, docConfluence, target.confluence, "confluence");
    assignFlags(d, docFlags, target.flags);
    assignAttributes(d, docAttributes, target.attributes);
    // The assignment is one member, not text to merge — replaced whole, the
    // same way on every peer (src/server/members.ts).
    if ((docAssigned ?? "") !== (target.assigned ?? "")) {
      if (target.assigned) d.assigned = target.assigned;
      else delete d.assigned;
    }
    for (const [i, match] of matchAt) {
      const entry = entries[i]!;
      const live = d.specs[i]!;
      if (entry.name !== match.name) A.updateText(d, ["specs", i, "name"], match.name);
      if (entry.version !== match.version) live.version = match.version;
      if (entry.status !== match.status) live.status = match.status;
      // The recorded published body follows the target: a published match
      // freezes the target's body (the gate made it the entry's effective
      // body unless `force`), any other status clears it. Set whole, so
      // concurrent publishes resolve to one body and nothing splices it.
      const snapshot = match.status === "published" ? match.body : undefined;
      if (entry.publishedBody !== snapshot) {
        if (snapshot === undefined) delete live.publishedBody;
        else live.publishedBody = new A.ImmutableString(snapshot);
      }
      // Also the heal: a published entry whose live text drifted from its
      // recorded body is driven back to it here.
      if (entry.body !== match.body) A.updateText(d, ["specs", i, "body"], match.body);
      if (entry.tests.join("\n") !== match.tests.join("\n")) {
        live.tests.splice(0, live.tests.length, ...match.tests);
      }
      assignLink(live, entry.link, match.link);
      assignLink(live, entry.qtest, match.qtest, "qtest");
      assignFlags(live, entry.flags, match.flags);
      assignAttributes(live, entry.attributes, match.attributes);
      assignNegative(live, entry.negative, match.negative);
      const before = authorsAt[i]!;
      const holder = { ...before };
      assignAuthors(holder, match, changedAt.has(i) ? author : undefined);
      if (holder.createdBy !== before.createdBy) live.createdBy = holder.createdBy!;
      if (holder.updatedBy !== before.updatedBy) live.updatedBy = holder.updatedBy!;
    }
    {
      const before = { createdBy: doc.createdBy, updatedBy: doc.updatedBy };
      const holder = { ...before };
      assignAuthors(holder, target, featureChanged ? author : undefined);
      if (holder.createdBy !== before.createdBy) d.createdBy = holder.createdBy!;
      if (holder.updatedBy !== before.updatedBy) d.updatedBy = holder.updatedBy!;
    }
    for (const [i, rank] of rankAt) {
      if (entries[i]!.rank !== rank) d.specs[i]!.rank = rank;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!matchAt.has(i) && entries[i]!.status !== "draft") A.deleteAt(d.specs, i);
    }
    for (const s of additions) d.specs.push(newEntry(s, author, rankOf.get(s)!));
  });
}

/**
 * Drive each published entry's live text back to its recorded body. Two
 * peers absorbing the same markdown edit each splice it in, and the CRDT
 * merge keeps both copies; the file, the API and the gate already read the
 * recorded body, so this only tidies the collaborative text so a later
 * demotion or edit starts from what was published. Returns the doc itself —
 * no change minted, nothing to save — when every published entry is already
 * tidy.
 */
export function healPublished(doc: A.Doc<FeatureDoc>): A.Doc<FeatureDoc> {
  const stale: [number, string][] = [];
  doc.specs.forEach((e, i) => {
    if (e.status !== "published") return;
    const snapshot = snapshotOf(e);
    if (snapshot !== undefined && e.body !== snapshot) stale.push([i, snapshot]);
  });
  if (stale.length === 0) return doc;
  return A.change(doc, (d) => {
    for (const [i, snapshot] of stale) A.updateText(d, ["specs", i, "body"], snapshot);
  });
}

/**
 * Delete one draft scenario, by the (name, version) identity the editor shows
 * it under. The one removal reconciliation cannot express: a draft is never
 * projected into the `.feature.md`, so markdown that leaves it out is exactly
 * what markdown always looks like, and reconcile keeps the entry. Deleting a
 * draft is therefore a direct document operation, asked for explicitly.
 *
 * Drafts only — a proposed scenario is removed by saving the feature without
 * it, and a published one through deletePublishedScenario in features.ts.
 * Null when no draft carries that name and version.
 */
export function removeDraftScenario(
  doc: A.Doc<FeatureDoc>,
  target: { name: string; version: number },
): A.Doc<FeatureDoc> | null {
  const at = doc.specs.findIndex(
    (s) => s.status === "draft" && s.name === target.name && s.version === target.version,
  );
  if (at === -1) return null;
  return A.change(doc, (d) => {
    A.deleteAt(d.specs, at);
  });
}

/**
 * Set the pull request links of the feature (`target` null) or of one of its
 * scenarios (specs/external-links/related-pull-requests.feature.md). Like
 * removeDraftScenario, a direct document operation: the links are never in
 * the markdown, so no save can express them, and reconcile never touches
 * them. The list is brought to `prs` by url — links gone from it are
 * deleted, links new to it appended, a kept link's title updated in place —
 * rather than replaced whole, so two peers linking different pull requests
 * at the same time end with both. The scenario is the entry carrying the
 * target's document id, else the one with its name and version. Null when
 * no scenario matches.
 */
export function setPullRequests(
  doc: A.Doc<FeatureDoc>,
  target: ScenarioTarget | null,
  prs: PullRequestLink[],
): A.Doc<FeatureDoc> | null {
  return setLinkList(doc, target, "prs", prs);
}

/**
 * Record the version of the feature's Confluence page as the app just
 * published it (specs/external-links/confluence-wiki.feature.md "Changes
 * made in Confluence are not overwritten unnoticed"). A direct document
 * operation like setPullRequests: the version is never in the markdown, so
 * no save can express it, and reconcile never touches it. The parent page
 * url published under rides along, so the dialog offers each feature its
 * own parent next time. Set whole — one
 * value, so two peers publishing at once end with one of theirs, not a mix.
 */
export function setConfluencePage(doc: A.Doc<FeatureDoc>, page: ConfluencePage): A.Doc<FeatureDoc> {
  const current = doc.confluencePage;
  if (current?.id === page.id && current.version === page.version && current.parentUrl === page.parentUrl) return doc;
  return A.change(doc, (d) => {
    d.confluencePage = {
      id: page.id,
      version: page.version,
      ...(page.parentUrl !== undefined ? { parentUrl: page.parentUrl } : {}),
    };
  });
}

/**
 * Record the qTest module the feature's test cases were just published into
 * and the parent module it went under (specs/external-links/
 * qtest-test-cases.feature.md "Create qTest test cases from a feature"), so
 * the dialog offers that parent next time. A direct document operation like
 * setConfluencePage, set whole.
 */
export function setQtestModule(doc: A.Doc<FeatureDoc>, module: QtestModule): A.Doc<FeatureDoc> {
  const current = doc.qtestModule;
  if (current?.id === module.id && current.parentUrl === module.parentUrl) return doc;
  return A.change(doc, (d) => {
    d.qtestModule = { id: module.id, parentUrl: module.parentUrl };
  });
}

/**
 * Set the Aha! or Figma links of the feature (`target` null) or of one of
 * its scenarios (specs/external-links/aha-and-figma-links.feature.md) — a
 * direct document operation merged exactly like setPullRequests, each tool
 * in its own list. Null when no scenario matches.
 */
export function setResourceLinks(
  doc: A.Doc<FeatureDoc>,
  target: ScenarioTarget | null,
  kind: ResourceLinkKind,
  links: ResourceLink[],
): A.Doc<FeatureDoc> | null {
  return setLinkList(doc, target, kind, links);
}

/** The document-only lists of `{ url, title }` links a feature and a spec carry. */
type LinkListKey = "prs" | ResourceLinkKind;

function setLinkList(
  doc: A.Doc<FeatureDoc>,
  target: ScenarioTarget | null,
  key: LinkListKey,
  links: { url: string; title: string }[],
): A.Doc<FeatureDoc> | null {
  let at = -1;
  if (target) {
    at = target.id ? doc.specs.findIndex((s) => s.id === target.id) : -1;
    if (at === -1) at = doc.specs.findIndex((s) => sameScenario(s, target));
    if (at === -1) return null;
  }
  const wanted = new Map<string, string>();
  for (const l of links) if (!wanted.has(l.url)) wanted.set(l.url, l.title);
  return A.change(doc, (d) => {
    const holder: Partial<Record<LinkListKey, { url: string; title: string }[]>> =
      at === -1 ? d : d.specs[at]!;
    // The list is created on first touch — even an empty one — and then
    // only ever spliced, so every later peer pushes into the same list and
    // concurrent links merge as a union. (Two peers creating it at the same
    // moment is the one race the CRDT resolves to one side; the list exists
    // from the first link on, so it never happens twice.)
    if (!holder[key]) holder[key] = [];
    const list = holder[key]!;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!wanted.has(list[i]!.url)) A.deleteAt(list, i);
    }
    const have = new Set<string>();
    for (const l of list) {
      have.add(l.url);
      const title = wanted.get(l.url)!;
      if (l.title !== title) l.title = title;
    }
    for (const [url, title] of wanted) {
      if (!have.has(url)) list.push({ url, title });
    }
  });
}

/**
 * Set the files stored with one scenario
 * (specs/editor/store-associated-files.feature.md) — a direct document
 * operation like setPullRequests, and merged the same way: the list is
 * brought to `files` by name — names gone from it deleted, names new to it
 * appended, a kept name pointed at its new stored file in place (a replaced
 * upload), a name whose stored file reappears under another renamed in
 * place — so two peers attaching different files at the same time end with
 * both. The scenario is the entry carrying the target's document id,
 * else the one with its name and version. Null when no scenario matches.
 */
export function setScenarioFiles(
  doc: A.Doc<FeatureDoc>,
  target: ScenarioTarget,
  files: ScenarioFile[],
): A.Doc<FeatureDoc> | null {
  let at = target.id ? doc.specs.findIndex((s) => s.id === target.id) : -1;
  if (at === -1) at = doc.specs.findIndex((s) => sameScenario(s, target));
  if (at === -1) return null;
  const wanted = new Map<string, ScenarioFile>();
  for (const f of files) if (!wanted.has(f.name)) wanted.set(f.name, f);
  return A.change(doc, (d) => {
    const entry = d.specs[at]!;
    // Created on first touch and only spliced after, as with pull requests.
    if (!entry.files) entry.files = [];
    const list = entry.files;
    // A name gone from the list whose stored file comes back under a new
    // name is a rename: renamed where it stands, so it keeps its place.
    const listed = new Set(list.map((f) => f.name));
    const newcomers = [...wanted.values()].filter((f) => !listed.has(f.name));
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i]!;
      if (wanted.has(f.name)) continue;
      const at = newcomers.findIndex((n) => n.file === f.file);
      if (at === -1) {
        A.deleteAt(list, i);
      } else {
        f.name = newcomers[at]!.name;
        newcomers.splice(at, 1);
      }
    }
    const have = new Set<string>();
    for (const f of list) {
      have.add(f.name);
      const next = wanted.get(f.name)!;
      if (f.file !== next.file) f.file = next.file;
      if (f.size !== next.size) f.size = next.size;
    }
    for (const [name, f] of wanted) {
      if (!have.has(name)) list.push({ name, file: f.file, size: f.size });
    }
  });
}

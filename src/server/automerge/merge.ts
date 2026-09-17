// Scenario-level three-way merge of parsed features. This is the bridge for
// edits that arrive as plain markdown with no CRDT ops behind them — an older
// app version's push, or a hand edit on GitHub — merged against the common
// ancestor the way git would, but at the granularity of the domain model:
// per scenario, not per line. Peers running this app version don't usually
// need it (their ops ride the chunk files and merge in the document itself);
// it is the fallback that keeps mixed-version teams and the PR workflow safe.

import * as A from "@automerge/automerge";
import type {
  EntryKind,
  ExternalLink,
  Feature,
  MarkdownPage,
  Scenario,
  Supersedes,
} from "../parser";

export type ThreeWayResult =
  | { ok: true; feature: Feature }
  | { ok: false; conflict: string };

const key = (s: Scenario) => `${s.name}@v${s.version}`;

function byKey(f: Feature): Map<string, Scenario> {
  return new Map(f.scenarios.map((s) => [key(s), s]));
}

/**
 * Character-level three-way text merge, with Automerge as the diff3 engine:
 * both sides' rewrites replay as updateText edits on forks of the base and
 * merge as CRDT operations. Overlapping edits both apply — the same outcome
 * concurrent in-app edits get — instead of surfacing a line conflict.
 */
function mergeText(base: string, ours: string, theirs: string): string {
  if (theirs === base || theirs === ours) return ours;
  if (ours === base) return theirs;
  const root = A.from<{ t: string }>({ t: base });
  const oursDoc = A.change(A.clone(root), (d) => A.updateText(d, ["t"], ours));
  const theirsDoc = A.change(A.clone(root), (d) => A.updateText(d, ["t"], theirs));
  return A.merge(oursDoc, theirsDoc).t;
}

/**
 * The same three-way merge for a markdown page — a roadmap page, a task, a
 * notebook entry (specs/app/engineering-notebook.feature.md). A page has no
 * scenarios, so there is nothing to match up by key: the heading and the body
 * merge as text, and each metadata field is one value, where the side that
 * changed it wins and ours wins when both did — the rule a feature's
 * assignment already follows. A page merge therefore never conflicts.
 */
export function threeWayPage(
  base: MarkdownPage,
  ours: MarkdownPage,
  theirs: MarkdownPage,
): MarkdownPage {
  const pick = <T>(b: T | undefined, o: T | undefined, t: T | undefined, same: (x?: T, y?: T) => boolean): T | undefined =>
    !same(t, b) && same(o, b) ? t : o;
  const eq = (x?: string, y?: string) => (x ?? "") === (y ?? "");
  const eqBool = (x?: boolean, y?: boolean) => (x ?? false) === (y ?? false);
  const eqNum = (x?: number, y?: number) => (x ?? 0) === (y ?? 0);
  const eqLink = (x?: Supersedes, y?: Supersedes) =>
    (x?.title ?? "") === (y?.title ?? "") && (x?.url ?? "") === (y?.url ?? "");
  const merged: MarkdownPage = {
    name: mergeText(base.name, ours.name, theirs.name),
    body: mergeText(base.body, ours.body, theirs.body),
  };
  const assigned = pick(base.assigned, ours.assigned, theirs.assigned, eq);
  const estimate = pick(base.estimate, ours.estimate, theirs.estimate, eqNum);
  const done = pick(base.done, ours.done, theirs.done, eqBool);
  const author = pick(base.author, ours.author, theirs.author, eq);
  const date = pick(base.date, ours.date, theirs.date, eq);
  const kind = pick(base.kind, ours.kind, theirs.kind, eq as (x?: EntryKind, y?: EntryKind) => boolean);
  const supersedes = pick(base.supersedes, ours.supersedes, theirs.supersedes, eqLink);
  if (assigned) merged.assigned = assigned;
  if (estimate) merged.estimate = estimate;
  if (done) merged.done = true;
  if (author) merged.author = author;
  if (date) merged.date = date;
  if (kind) merged.kind = kind;
  if (supersedes) merged.supersedes = supersedes;
  return merged;
}

/** draft → proposed → published: the lifecycle only moves forward. */
const STATUS_RANK = { draft: 0, proposed: 1, published: 2 } as const;

function linkKey(link: ExternalLink | undefined): string {
  return link ? `${link.program}\n${link.ticket}\n${link.url}` : "";
}

/**
 * An external link is one value, not text: the side that changed it wins,
 * ours when both did (specs/external-links/project-management-jira-linear-
 * etc.feature.md).
 */
function mergeLink(
  base: ExternalLink | undefined,
  ours: ExternalLink | undefined,
  theirs: ExternalLink | undefined,
): ExternalLink | undefined {
  const winner =
    linkKey(theirs) !== linkKey(base) && linkKey(ours) === linkKey(base) ? theirs : ours;
  return winner ? { ...winner } : undefined;
}

/** Merge one scenario present on both sides. */
function mergeScenario(base: Scenario | undefined, ours: Scenario, theirs: Scenario): Scenario {
  const baseTests = (base?.tests ?? []).join("\n");
  const tests =
    theirs.tests.join("\n") !== baseTests && ours.tests.join("\n") === baseTests
      ? theirs.tests
      : ours.tests;
  const link = mergeLink(base?.link, ours.link, theirs.link);
  return {
    name: ours.name,
    version: ours.version,
    // status is a one-way latch: the side further along the lifecycle wins,
    // so a concurrent publish (or propose) on either side sticks.
    status: STATUS_RANK[ours.status] >= STATUS_RANK[theirs.status] ? ours.status : theirs.status,
    body: mergeText(base?.body ?? "", ours.body, theirs.body),
    tests: [...tests],
    ...(link ? { link } : {}),
  };
}

/**
 * Merge two descendants of a common base. Text merges character-level (see
 * mergeText); structure merges per scenario. What still needs a human — one
 * side deleting a scenario the other edited — is a conflict, reported instead
 * of guessed at, and the existing resolution UI takes over as it does today.
 */
export function threeWayFeature(
  base: Feature,
  ours: Feature,
  theirs: Feature,
): ThreeWayResult {
  const name = mergeText(base.name, ours.name, theirs.name);
  const description = mergeText(base.description, ours.description, theirs.description);

  const b = byKey(base);
  const o = byKey(ours);
  const t = byKey(theirs);
  const scenarios: Scenario[] = [];
  for (const k of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
    const inBase = b.get(k);
    const inOurs = o.get(k);
    const inTheirs = t.get(k);
    if (inOurs && inTheirs) {
      scenarios.push(mergeScenario(inBase, inOurs, inTheirs));
    } else if (inOurs && !inTheirs) {
      if (!inBase) {
        scenarios.push(inOurs); // we added it
      } else if (sameScenario(inOurs, inBase)) {
        // they deleted it and we left it alone: the deletion stands
      } else {
        return { ok: false, conflict: `scenario ${k} was edited here and deleted there` };
      }
    } else if (inTheirs && !inOurs) {
      if (!inBase) {
        scenarios.push(inTheirs); // they added it
      } else if (sameScenario(inTheirs, inBase)) {
        // we deleted it and they left it alone: the deletion stands
      } else {
        return { ok: false, conflict: `scenario ${k} was deleted here and edited there` };
      }
    }
  }
  const link = mergeLink(base.link, ours.link, theirs.link);
  // The assignment merges like a link: one value, the side that changed it
  // wins, ours when both did (src/server/members.ts).
  const assigned =
    (theirs.assigned ?? "") !== (base.assigned ?? "") && (ours.assigned ?? "") === (base.assigned ?? "")
      ? theirs.assigned
      : ours.assigned;
  return {
    ok: true,
    feature: {
      name,
      description,
      scenarios,
      ...(link ? { link } : {}),
      ...(assigned ? { assigned } : {}),
    },
  };
}

function sameScenario(a: Scenario, b: Scenario): boolean {
  return (
    a.body === b.body &&
    a.status === b.status &&
    a.tests.join("\n") === b.tests.join("\n") &&
    linkKey(a.link) === linkKey(b.link)
  );
}

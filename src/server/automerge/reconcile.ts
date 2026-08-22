// Reconciliation drives the Automerge document toward a parsed Feature — the
// bridge from today's whole-file writes (the REST API sends full markdown, and
// external GitHub edits arrive as full files) into CRDT operations. Field
// edits become Automerge.updateText splices so concurrent peers' changes to
// the same body merge at character level instead of last-writer-wins.

import * as A from "@automerge/automerge";
import { randomUUID } from "node:crypto";
import type { Feature, Scenario } from "../parser";
import type { FeatureDoc, SpecEntry } from "./schema";
import { newFeatureDoc } from "./store";

/** Create a document from a parsed feature file (first import). */
export function importFeatureDoc(feature: Feature): A.Doc<FeatureDoc> {
  return newFeatureDoc({
    name: feature.name,
    description: feature.description,
    specs: feature.scenarios.map(newEntry),
  });
}

function newEntry(s: Scenario): SpecEntry {
  return {
    id: randomUUID(),
    type: "Scenario",
    name: s.name,
    version: s.version,
    status: s.status,
    body: s.body,
    tests: [...s.tests],
  };
}

const sameScenario = (e: { name: string; version: number }, s: Scenario) =>
  e.name === s.name && e.version === s.version;

/**
 * The published-immutability invariant (specs/ui.spec.md), stated on the doc:
 * every published scenario must survive reconciliation under its (name,
 * version) identity with its body intact. Same rule and message as
 * assertPublishedUnchanged in features.ts, checked here so a drifted markdown
 * file can never rewrite published history through the reconciliation door.
 */
function assertPublishedKept(doc: A.Doc<FeatureDoc>, target: Feature): void {
  for (const entry of doc.specs) {
    if (entry.status !== "published") continue;
    const match = target.scenarios.find((s) => sameScenario(entry, s));
    if (!match || match.body !== entry.body) {
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
 * `force` skips the published-immutability gate — only for an explicit human
 * decision (the conflict-resolution dialog), never for an automated write.
 */
export function reconcile(
  doc: A.Doc<FeatureDoc>,
  target: Feature,
  { force = false } = {},
): A.Doc<FeatureDoc> {
  if (!force) assertPublishedKept(doc, target);

  const entries: Scenario[] = doc.specs.map((e) => ({
    name: e.name,
    version: e.version,
    status: e.status,
    body: e.body,
    tests: [...e.tests],
  }));
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
  claim((s, i) => sameScenario(entries[i]!, s));
  claim((s, i) => s.body === entries[i]!.body); // rename / version bump

  const additions = target.scenarios.filter((s) => !matched.has(s));

  return A.change(doc, (d) => {
    if (d.name !== target.name) A.updateText(d, ["name"], target.name);
    if (d.description !== target.description) {
      A.updateText(d, ["description"], target.description);
    }
    for (const [i, match] of matchAt) {
      const entry = entries[i]!;
      const live = d.specs[i]!;
      if (entry.name !== match.name) A.updateText(d, ["specs", i, "name"], match.name);
      if (entry.version !== match.version) live.version = match.version;
      if (entry.status !== match.status) live.status = match.status;
      if (entry.body !== match.body) A.updateText(d, ["specs", i, "body"], match.body);
      if (entry.tests.join("\n") !== match.tests.join("\n")) {
        live.tests.splice(0, live.tests.length, ...match.tests);
      }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!matchAt.has(i) && entries[i]!.status !== "draft") A.deleteAt(d.specs, i);
    }
    for (const s of additions) d.specs.push(newEntry(s));
  });
}

/**
 * Delete one draft scenario, by the (name, version) identity the editor shows
 * it under. The one removal reconciliation cannot express: a draft is never
 * projected into the `.feature.md`, so markdown that leaves it out is exactly
 * what markdown always looks like, and reconcile keeps the entry. Deleting a
 * draft is therefore a direct document operation, asked for explicitly.
 *
 * Drafts only — a proposed or published scenario is removed by saving the
 * feature without it. Null when no draft carries that name and version.
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

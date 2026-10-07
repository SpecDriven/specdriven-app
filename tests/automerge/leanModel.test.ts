// Differential test between the TypeScript sync core and its Lean 4 model
// (verification/lean). A seeded generator drives the real functions over a
// corpus of inputs, writes the inputs and outputs as JSON vectors, and
// `lake exe check-vectors` replays them through the model and reports every
// mismatch. The model's proofs are only as good as this agreement.

import { test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { threeWayFeature, threeWayFeatureStrict } from "../../src/server/automerge/merge";
import * as A from "@automerge/automerge";
import { assertPublishedKept, healPublished, reconcile } from "../../src/server/automerge/reconcile";
import { docToFeature, projectFeature } from "../../src/server/automerge/project";
import { newFeatureDoc } from "../../src/server/automerge/store";
import { parseFeature, type Feature, type Scenario, type ScenarioStatus } from "../../src/server/parser";
import { type FeatureDoc, snapshotOf, type SpecEntry } from "../../src/server/automerge/schema";

const LEAN_DIR = join(import.meta.dir, "../../verification/lean");
const ELAN_BIN = join(process.env.HOME ?? "", ".elan/bin");

// mulberry32: deterministic, so a mismatch reproduces from the seed.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const next = rng(20261003);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
const chance = (p: number) => next() < p;

// Names restricted to lowercase letters, digits and spaces so localeCompare
// and Lean's code-point order agree (verification/lean/SpecDriven/Sync/Projection.lean).
const NAMES = ["alpha", "beta", "gamma", "delta", "alpha 2"] as const;
const BODIES = ["", "one", "two", "one two", "one\ntwo"] as const;
const TESTS = [[], ["https://g/a.test.ts#L1"], ["https://g/a.test.ts#L1", "https://g/b.test.ts#L9"], ["https://g/b.test.ts#L9"]] as const;
const LINKS = [undefined, { program: "Jira", ticket: "A-1", url: "https://j/A-1" }, { program: "Linear", ticket: "L-2", url: "https://l/L-2" }] as const;
const MEMBERS = [undefined, "ann", "bob"] as const;
const STATUSES: ScenarioStatus[] = ["draft", "proposed", "published"];

function scenario(name: string, version: number, status: ScenarioStatus): Scenario {
  const s: Scenario = { name, version, status, body: pick(BODIES), tests: [...pick(TESTS)] };
  const link = pick(LINKS);
  if (link) s.link = { ...link };
  return s;
}

/** A feature with distinct (name, version) keys, drafts optional. */
function feature(opts: { drafts?: boolean; n?: number } = {}): Feature {
  const n = opts.n ?? Math.floor(next() * 4);
  const keys = new Set<string>();
  const scenarios: Scenario[] = [];
  for (let i = 0; i < n; i++) {
    const name = pick(NAMES);
    const version = chance(0.7) ? 1 : 2;
    if (keys.has(`${name}@${version}`)) continue;
    keys.add(`${name}@${version}`);
    const status = opts.drafts ? pick(STATUSES) : pick(["proposed", "published"] as const);
    scenarios.push(scenario(name, version, status));
  }
  const f: Feature = { name: pick(["feat", "feat x"]), description: pick(BODIES), scenarios };
  const link = pick(LINKS);
  if (link) f.link = { ...link };
  const m = pick(MEMBERS);
  if (m) f.assigned = m;
  return f;
}

/** A descendant of `base`: each field left alone, changed, or (scenarios) added/removed. */
function descend(base: Feature): Feature {
  const f: Feature = structuredClone(base);
  if (chance(0.2)) f.name = pick(["feat", "feat x", "feat y"]);
  if (chance(0.3)) f.description = pick(BODIES);
  if (chance(0.2)) {
    const link = pick(LINKS);
    if (link) f.link = { ...link };
    else delete f.link;
  }
  if (chance(0.2)) {
    const m = pick(MEMBERS);
    if (m) f.assigned = m;
    else delete f.assigned;
  }
  f.scenarios = f.scenarios.filter(() => !chance(0.2));
  for (const s of f.scenarios) {
    if (chance(0.3)) s.body = pick(BODIES);
    if (chance(0.2)) s.status = pick(["proposed", "published"] as const);
    if (chance(0.2)) s.tests = [...pick(TESTS)];
    if (chance(0.15)) {
      const link = pick(LINKS);
      if (link) s.link = { ...link };
      else delete s.link;
    }
  }
  if (chance(0.3)) {
    const keys = new Set(f.scenarios.map((s) => `${s.name}@${s.version}`));
    const name = pick(NAMES);
    const version = chance(0.7) ? 1 : 2;
    if (!keys.has(`${name}@${version}`)) f.scenarios.push(scenario(name, version, pick(["proposed", "published"] as const)));
  }
  return f;
}

/** Both sides changed the same text to different values: mergeText's
 * nondeterministic branch, which the model leaves opaque. */
function textClash(base: Feature, ours: Feature, theirs: Feature): boolean {
  const clash = (b: string, o: string, t: string) => o !== b && t !== b && o !== t;
  if (clash(base.name, ours.name, theirs.name)) return true;
  if (clash(base.description, ours.description, theirs.description)) return true;
  const byKey = (f: Feature) => new Map(f.scenarios.map((s) => [`${s.name}@${s.version}`, s]));
  const b = byKey(base);
  const t = byKey(theirs);
  for (const s of ours.scenarios) {
    const other = t.get(`${s.name}@${s.version}`);
    if (other && clash(b.get(`${s.name}@${s.version}`)?.body ?? "", s.body, other.body)) return true;
  }
  return false;
}

// JSON shape the Lean decoder expects: every optional present, null for absent.
const link = (l?: { program: string; ticket: string; url: string }) => (l ? { ...l } : null);
const jsonScenario = (s: Scenario) => ({
  name: s.name, version: s.version, status: s.status, body: s.body, tests: s.tests,
  id: s.id ?? null, link: link(s.link), prs: s.prs ?? null,
});
const jsonFeature = (f: Feature) => ({
  name: f.name, description: f.description, scenarios: f.scenarios.map(jsonScenario),
  link: link(f.link), prs: f.prs ?? null, assigned: f.assigned ?? null,
});
// The recorded published body is an Automerge ImmutableString in a document
// and a plain string in generated input; `snapshotOf` reads both.
type PlainEntry = Omit<SpecEntry, "publishedBody"> & { publishedBody?: string };
type PlainInit = Omit<FeatureDoc, "schemaVersion" | "id" | "specs"> & { specs: PlainEntry[] };
type DocInit = Omit<FeatureDoc, "schemaVersion" | "id">;

const jsonEntry = (e: PlainEntry | SpecEntry, addedIds: Set<string>) => ({
  id: addedIds.has(e.id) ? "*" : e.id, type: e.type.toLowerCase(), name: e.name, version: e.version,
  status: e.status, body: e.body, publishedBody: snapshotOf(e) ?? null,
  tests: [...e.tests], link: link(e.link), prs: e.prs ? [...e.prs] : null,
});

// A published entry is one of: legacy (published before the key existed, no
// recorded body), stamped (recorded body is the live body), or untidy (a CRDT
// merge left the live body different from the recorded one — H2). An
// unpublished entry occasionally carries a stale record a demotion should
// clear.
function docInit(f: Feature): PlainInit {
  return {
    name: f.name,
    description: f.description,
    specs: f.scenarios.map((s, i) => {
      let body = s.body;
      let publishedBody: string | undefined;
      if (s.status === "published") {
        const r = next();
        if (r < 0.4) publishedBody = s.body;
        else if (r < 0.7) {
          publishedBody = s.body;
          body = pick(BODIES.filter((b) => b !== s.body));
        }
      } else if (chance(0.1)) publishedBody = pick(BODIES);
      return {
        id: `e${i}`, type: "Scenario", name: s.name, version: s.version, status: s.status,
        body, ...(publishedBody !== undefined ? { publishedBody } : {}),
        tests: [...s.tests], ...(s.link ? { link: { ...s.link } } : {}),
      };
    }),
    ...(f.link ? { link: { ...f.link } } : {}),
    ...(f.assigned ? { assigned: f.assigned } : {}),
  };
}

// `structuredClone` would turn an ImmutableString into a plain `{ val }` map,
// so the input stays plain and is wrapped after cloning.
function wrapSnapshots(init: PlainInit): DocInit {
  return {
    ...init,
    specs: init.specs.map(({ publishedBody, ...e }) => ({
      ...e,
      ...(publishedBody !== undefined ? { publishedBody: new A.ImmutableString(publishedBody) } : {}),
    })),
  };
}

function jsonDoc(init: PlainInit) {
  return {
    schemaVersion: 3, id: "doc", name: init.name, description: init.description,
    specs: init.specs.map((e) => jsonEntry(e, new Set())),
    link: link(init.link), prs: null, assigned: init.assigned ?? null,
  };
}

const N = Number(process.env.LEAN_VECTORS ?? 250);

function threeWayVectors(strict: boolean) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const base = feature();
    const ours = descend(base);
    const theirs = descend(base);
    const r = strict ? threeWayFeatureStrict(base, ours, theirs) : threeWayFeature(base, ours, theirs);
    out.push({
      base: jsonFeature(base), ours: jsonFeature(ours), theirs: jsonFeature(theirs),
      textClash: textClash(base, ours, theirs),
      result: r.ok ? { ok: true, feature: jsonFeature(r.feature) } : { ok: false, conflict: r.conflict },
    });
  }
  return out;
}

function reconcileVectors() {
  const out = [];
  for (let i = 0; i < N; i++) {
    const before = feature({ drafts: true });
    const init = docInit(before);
    const doc = newFeatureDoc(wrapSnapshots(structuredClone(init)));
    // The drift pass heals before it absorbs; the checker compares the healed
    // entries too. A clone, since Automerge refuses a second change on `doc`.
    const healed = healPublished(A.clone(doc)).specs.map((e) => jsonEntry(e, new Set()));
    // The target is usually a descendant of the projection (what a drift or
    // a save looks like), sometimes an unrelated feature.
    const target = chance(0.8) ? descend(parseFeature(projectFeature(doc))) : feature();
    // Sometimes the editor names the entry it is saving.
    let scenario: { id?: string; name: string; version: number } | undefined;
    if (chance(0.3) && init.specs.length > 0 && target.scenarios.length > 0) {
      const e = pick(init.specs);
      const t = pick(target.scenarios);
      scenario = { id: chance(0.8) ? e.id : "missing", name: t.name, version: t.version };
    }
    const force = chance(0.15);
    let kept = true;
    try {
      assertPublishedKept(doc, target);
    } catch {
      kept = false;
    }
    let result;
    try {
      const after = reconcile(doc, target, { force, scenario });
      const addedIds = new Set(after.specs.map((e) => e.id).filter((id) => !init.specs.some((e) => e.id === id)));
      result = {
        ok: true,
        projection: jsonFeature(parseFeature(projectFeature(after))),
        specs: after.specs.map((e) => jsonEntry(e, addedIds)),
        feature: jsonFeature(docToFeature(after)),
      };
    } catch (e) {
      result = { ok: false, conflict: e instanceof Error ? e.message : String(e) };
    }
    out.push({
      doc: jsonDoc(init), target: jsonFeature(target), force,
      scenario: scenario ? { id: scenario.id ?? null, name: scenario.name, version: scenario.version } : null,
      publishedKept: kept, healed, result,
    });
  }
  return out;
}

test("the Lean model agrees with the TypeScript on generated vectors", async () => {
  const dir = join(LEAN_DIR, "vectors");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "threeWay.json"), JSON.stringify(threeWayVectors(false)));
  await writeFile(join(dir, "threeWayStrict.json"), JSON.stringify(threeWayVectors(true)));
  await writeFile(join(dir, "reconcile.json"), JSON.stringify(reconcileVectors()));

  const lake = Bun.which("lake", { PATH: `${ELAN_BIN}:${process.env.PATH ?? ""}` });
  if (!lake) {
    console.warn("lake (Lean 4) not installed; vectors written but not checked");
    return;
  }
  const proc = Bun.spawn([lake, "exe", "check-vectors"], {
    cwd: LEAN_DIR,
    env: { ...process.env, PATH: `${ELAN_BIN}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) console.error(stdout, stderr);
  expect(code).toBe(0);
}, 600_000);

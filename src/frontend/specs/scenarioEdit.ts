// The pure half of editing a feature's scenarios — where a save places a
// scenario, which version it takes, which card it lands on, what autosave
// compares — moved out of App.tsx on the way to the Specs tab being its
// plugin's own (specs/app/plugins.feature.md "Specs is a built-in plugin").
// No React and no fetch: each function takes the feature and answers.

import { parseFeature, titleFromFileName } from "../../server/parser";
import type { Feature, Scenario, ScenarioTarget } from "../../server/parser";
import { cleanLine } from "../../server/text";

/**
 * index === null means a new scenario being added; every save — autosave
 * included — points it at the entry it wrote, so the next save rewrites that
 * entry instead of appending a second one. `scenario.id` — the document id
 * the server reads the scenario under, adopted from a new scenario's first
 * landed save — goes out with every save, so a retyped title or a re-derived
 * version renames that entry rather than filing a second one
 * (specs/editor/editor-autosave.feature.md "Autosave Never Adds the Same
 * Scenario Twice").
 */
export interface EditState {
  index: number | null;
  scenario: Scenario;
  /**
   * True while the editor pane is creating a scenario, which it stays even
   * after autosave (specs/editor/editor-autosave.feature.md) has put the
   * scenario in the feature and given `index` a value. The pane keeps its
   * new-scenario behavior for as long as it is open: retyping the name
   * re-derives the version, and the Draft checkbox stays unlocked.
   */
  isNew?: boolean;
  /**
   * Where a new scenario goes in the feature once a save places it (a new
   * version: right after the version it continues). Appended without.
   */
  insertAt?: number;
}

/**
 * The feature as the server sent it — its parsed form, which carries each
 * scenario's document id (the markdown never does) — with its name resolved
 * the way the page shows it: the `# <name>` heading, or the file stem when
 * the heading is missing (specs/ui/ui.feature.md "Main page"). Resolving it
 * here and not only at render time matters: every save serializes this object
 * back to the file, and a blank name would write a nameless `# ` heading over
 * the real one.
 */
export function featureFromResponse(
  data: { content: string; parsed?: Feature },
  fileName: string,
): Feature {
  const parsed = data.parsed ?? parseFeature(data.content);
  return parsed.name ? parsed : { ...parsed, name: titleFromFileName(fileName) };
}

/**
 * How a save or publish names its scenario to the server: the heading
 * identity plus the document id the editor holds for it, which keeps the
 * scenario one scenario through a rename
 * (specs/editor/editor-autosave.feature.md "Autosave Never Adds the Same
 * Scenario Twice").
 */
export function scenarioTarget(s: Scenario): ScenarioTarget {
  return { name: s.name, version: s.version, id: s.id };
}

/**
 * What autosave (specs/editor/editor-autosave.feature.md) compares to decide
 * whether the editor is holding anything new: everything a save would write,
 * under the version the dialog will save it as rather than the one on the
 * object.
 */
export function scenarioSignature(s: Scenario, version: number): string {
  // The name as a save writes it: a stray space is nothing new to save.
  return JSON.stringify([
    savedScenarioName(s),
    version,
    s.status,
    s.body,
    s.tests,
    s.link ?? null,
    s.qtest ?? null,
    s.flags ?? null,
    s.attributes ?? null,
    s.negative ?? null,
  ]);
}

/**
 * The name a save writes for the scenario (specs/ui/ui.feature.md
 * "User-entered text is cleaned up"): trimmed with inner runs of spaces
 * collapsed — except a published scenario's, which is immutable and only
 * saves for its test links, so its heading is kept verbatim (a changed one
 * would read as a rename the document must refuse).
 */
export function savedScenarioName(s: Pick<Scenario, "name" | "status">): string {
  return s.status === "published" ? s.name.trim() : cleanLine(s.name);
}

/**
 * Whether the scenario's name is still being typed — the dialog's title field
 * holds the caret (specs/editor/editor-autosave.feature.md "Autosave Waits
 * While the Name Is Being Typed"). A tick that fires mid-word would save the
 * half-typed name as a draft, so it stands down until focus moves on.
 */
export function namingInProgress(nameField: Element | null, active: Element | null): boolean {
  return nameField !== null && nameField === active;
}

/**
 * The feature with the editor's scenario written in — over the entry the
 * editor opened on (or the one a previous save placed), else at `insertAt`
 * (a new version goes right after its source), else appended — which is
 * where its card will be: scenarios keep their order
 * (specs/ui/ui.feature.md "number scenarios"). Every save places the
 * scenario this way, so the way back (specs/editor/spec-editor.feature.md
 * "Spec editor pane") can predict where to land.
 */
export function withScenario(
  feature: Feature,
  at: number | null,
  s: Scenario,
  insertAt?: number,
): Feature {
  if (at !== null) {
    return { ...feature, scenarios: feature.scenarios.map((sc, i) => (i === at ? s : sc)) };
  }
  const scenarios = [...feature.scenarios];
  scenarios.splice(Math.min(insertAt ?? scenarios.length, scenarios.length), 0, s);
  return { ...feature, scenarios };
}

/**
 * The feature with the scenario at `from` moved to `to` (specs/ui/
 * ui.feature.md "number scenarios": Move up, Move down), the rest keeping
 * their order. Out-of-range positions leave the feature as it is.
 */
export function withScenarioMoved(feature: Feature, from: number, to: number): Feature {
  const n = feature.scenarios.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return feature;
  const scenarios = [...feature.scenarios];
  const [moved] = scenarios.splice(from, 1);
  scenarios.splice(to, 0, moved!);
  return { ...feature, scenarios };
}

/**
 * The scenario with its polarity set (specs/ui/scenario-polarity.feature.md):
 * the `negative` key when negative, no key at all when positive, so the
 * markdown and the autosave signature never see an undefined marker.
 */
export function withPolarity(s: Scenario, negative: boolean): Scenario {
  const { negative: _previous, ...rest } = s;
  return negative ? { ...rest, negative: true } : rest;
}

/** The feature with the scenario at `i` marked negative or positive. */
export function withScenarioPolarity(feature: Feature, i: number, negative: boolean): Feature {
  const s = feature.scenarios[i];
  if (!s) return feature;
  return withScenario(feature, i, withPolarity(s, negative));
}


/**
 * The version a scenario takes in `feature` when its version is derived
 * (specs/ui/ui.feature.md): one past the highest version already carrying that
 * name, or 1 when the name is new; `ignoreIndex` leaves its own entry out.
 */
export function nextVersionIn(
  feature: Feature | null,
  name: string,
  ignoreIndex?: number,
): number {
  const versions = (feature?.scenarios ?? [])
    .filter((s, i) => i !== ignoreIndex && cleanLine(s.name) === cleanLine(name))
    .map((s) => s.version);
  return versions.length ? Math.max(...versions) + 1 : 1;
}

/**
 * Where the editor's scenario sits on the server: the feature a save was
 * answered with, the scenario's index in it and its document id. A save
 * queued behind another places itself here rather than where the render
 * that queued it thought the scenario was.
 */
export type Placement = {
  feature: Feature;
  index: number | null;
  id?: string;
  /** Where a scenario not yet in the feature goes (withScenario); appended without. */
  insertAt?: number;
};

/**
 * The editor's scenario written into the feature at `placement`: over the
 * entry found there (or appended when there is none), adopting the document
 * id a save gave it. A `derived` version (a new scenario) is re-derived
 * against that feature with its own entry left out, or it would bump past
 * itself.
 */
export function placeScenario(
  draft: Scenario,
  { feature, index, id, insertAt }: Placement,
  derived: boolean,
): { s: Scenario; next: Feature } {
  const version =
    derived || index === null ? nextVersionIn(feature, draft.name, index ?? undefined) : draft.version;
  // The name goes out trimmed, as the server parses every heading
  // (parser.ts SCENARIO_RE), and with inner runs of spaces collapsed
  // (savedScenarioName): the scenario the save lands is then the one this
  // save names, and the editor finds it again (landedScenario).
  const s: Scenario = { ...draft, name: savedScenarioName(draft), version, id: draft.id ?? id };
  return { s, next: withScenario(feature, index, s, insertAt) };
}

/**
 * Whether a click on a scenario card landed on one of its controls — a
 * button, a checkbox, the ticket link, a test link — rather than on the card
 * itself. The title link counts as the card: clicking it highlights, and
 * double-clicking it edits, like anywhere else on the card.
 */
export function isCardControl(
  target: { closest?: (selector: string) => unknown } | EventTarget | null,
): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest(".scenario-title > a")) return false;
  return el.closest("button, input, a") != null;
}

/**
 * The card to highlight on the way back from the editor pane
 * (specs/editor/spec-editor.feature.md "Spec editor pane"): the scenario's
 * entry found by identity, since a save may have moved it; null for a
 * scenario the feature never received.
 */
export function cardOfScenario(
  scenarios: readonly Scenario[],
  s: { name: string; version: number },
): number | null {
  // Names compare cleaned, as a save writes them (savedScenarioName) and
  // as nextVersionIn counts them.
  const name = cleanLine(s.name);
  const i = scenarios.findIndex((sc) => cleanLine(sc.name) === name && sc.version === s.version);
  return i === -1 ? null : i;
}

/**
 * Where a landed save left the editor's scenario (issue #173): its entry by
 * identity, else the entry carrying its document id. Losing it would leave
 * the editor new, deriving the next version for its name on the next tick
 * and appending the scenario again — on every tick after that too. Only a
 * scenario whose id is gone from the feature as well is lost: the entry was
 * dropped underneath the editor, and the next save re-adds the work.
 */
export function landedScenario(
  scenarios: readonly Scenario[],
  s: { name: string; version: number },
  id: string | undefined,
): number | null {
  const card = cardOfScenario(scenarios, s);
  if (card !== null || id === undefined) return card;
  const i = scenarios.findIndex((sc) => sc.id === id);
  return i === -1 ? null : i;
}

/**
 * The editor state for a scenario about to be written: a draft under `name`
 * (cleaned, as a save writes it), version 1 until the first save derives the
 * real one, going into the feature at `insertAt` — appended without
 * (specs/ui/ui.feature.md "Add A Scenario Button").
 */
export function newScenarioDraft(name: string, insertAt?: number): EditState {
  return {
    index: null,
    isNew: true,
    ...(insertAt === undefined ? {} : { insertAt }),
    scenario: { name: cleanLine(name), version: 1, status: "draft", body: "", tests: [] },
  };
}

/**
 * Where the scenario added from an open pane goes (specs/editor/
 * spec-editor.feature.md "Spec editor pane"): right after the pane's
 * scenario, found where its save landed it — by identity, else by document
 * id — and at `fallback` when the feature no longer has it.
 */
export function insertAfterScenario(
  scenarios: readonly Scenario[],
  current: { name: string; version: number },
  id: string | undefined,
  fallback: number,
): number {
  const at = landedScenario(scenarios, current, id);
  return at === null ? fallback : at + 1;
}

/**
 * The scenario whose page is open (specs/ui/navigation.feature.md "URL scheme")
 * — what the address bar and the window title name. Read through the pane's
 * index into the feature, so a rename follows the scenario the moment its save
 * lands; a highlighted card is not a page, and a new scenario no save has
 * placed in the feature yet has no url of its own.
 */
export function pageScenario(
  editing: { index: number | null } | null,
  scenarios: readonly Scenario[] | undefined,
): Scenario | null {
  if (!editing || editing.index === null) return null;
  return scenarios?.[editing.index] ?? null;
}

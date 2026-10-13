// Sidebar folder tree (specs/ui/folders.feature.md): folders are directories
// in the data repo; features hang off the folder they live in. The tree is
// built from the flat /api/features listing.

import type { FeatureListing } from "../server/features";
import type { Scenario, ScenarioStatus } from "../server/parser";
import { SPECS_FOLDER } from "./route";

export interface FolderNode {
  /** Display segment, e.g. `billing`. */
  name: string;
  /** Full folder path relative to the repo root; `specs` for the root node. */
  path: string;
  folders: FolderNode[];
  features: FeatureListing[];
}

/**
 * Arrange the flat listing into a tree rooted at the spec tree's top level.
 * Folders come from the explicit folder list (so empty folders show — they are
 * drop targets) plus any folder implied by a feature's path. Folders sort
 * before features; both alphabetically.
 *
 * The root node *is* `specs/`, so the storage prefix never shows up as a
 * folder of its own in the sidebar, while every `path` stays repo-relative —
 * which is what a drop target hands back to the move API.
 */
export function buildTree(folders: string[], features: FeatureListing[]): FolderNode {
  const root: FolderNode = { name: "", path: SPECS_FOLDER, folders: [], features: [] };
  const nodes = new Map<string, FolderNode>([[SPECS_FOLDER, root]]);

  const folderNode = (path: string): FolderNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    // Anything not under the spec tree hangs off the root rather than growing
    // a sibling of it — the listing never sends such a path, and a stray one
    // must not become a phantom top-level folder.
    if (!path.startsWith(`${SPECS_FOLDER}/`)) return root;
    const segments = path.split("/");
    const node: FolderNode = { name: segments[segments.length - 1]!, path, folders: [], features: [] };
    nodes.set(path, node);
    folderNode(segments.slice(0, -1).join("/")).folders.push(node);
    return node;
  };

  for (const path of folders) folderNode(path);
  for (const f of features) {
    folderNode(f.fileName.split("/").slice(0, -1).join("/")).features.push(f);
  }

  for (const node of nodes.values()) {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.features.sort((a, b) => a.name.localeCompare(b.name));
  }
  return root;
}

/** One scenario row under a feature in the sidebar tree. */
export interface ScenarioRow {
  name: string;
  version: number;
  status: ScenarioStatus;
}

/**
 * The scenarios a feature's tree row expands to (specs/ui/navigation.feature.md
 * "Scenario navigation").
 *
 * The listing carries every feature's scenarios already, so the tree needs no
 * fetch of its own. But the listing is only refreshed on start and on the
 * reload cron — a save into the open feature (a rename, a new version, a new
 * draft) lands in the open `Feature` first. So the feature that is open reads
 * from that live state, and every other feature from the listing.
 */
export function scenarioRows(
  listing: FeatureListing,
  openFile: string | null,
  open: { scenarios: readonly Scenario[] } | null,
): ScenarioRow[] {
  const source =
    open && listing.fileName === openFile ? open.scenarios : listing.scenarios;
  return source.map(({ name, version, status }) => ({ name, version, status }));
}

/**
 * The listing with the open feature's scenarios written into its entry, so
 * the tree shows the same rows once the feature is left as it did while the
 * feature was open — a scenario deleted, renamed or added there does not come
 * back, or go missing, until the next listing refresh catches up.
 *
 * The entry holds what the server's listing would: the scenarios in the file.
 * A draft lives only in the feature's document, so it stays out — the next
 * refresh would only take it out again. The same array comes back when the
 * entry already agrees, so a state update with it changes nothing.
 */
export function withOpenScenarios(
  listing: FeatureListing[],
  openFile: string,
  open: { scenarios: readonly Scenario[] },
): FeatureListing[] {
  const at = listing.findIndex((f) => f.fileName === openFile);
  if (at < 0) return listing;
  const scenarios = open.scenarios
    .filter((s) => s.status !== "draft")
    .map(({ name, version, status }) => ({ name, version, status }));
  const entry = listing[at]!;
  const same =
    entry.scenarios.length === scenarios.length &&
    entry.scenarios.every(
      (s, i) =>
        s.name === scenarios[i]!.name &&
        s.version === scenarios[i]!.version &&
        s.status === scenarios[i]!.status,
    );
  if (same) return listing;
  const next = listing.slice();
  next[at] = { ...entry, scenarios };
  return next;
}

/** One stop on the scenario editor's `<` / `>` walk: a scenario and its feature. */
export interface ScenarioStop {
  file: string;
  scenario: ScenarioRow;
}

/**
 * Every scenario in the spec tree, in the order the sidebar shows them —
 * folders before features, depth first, each feature's scenarios in file
 * order — for the scenario editor's `<` / `>` buttons. Rows come from
 * `scenarioRows`, so the open feature contributes its live scenarios (its
 * drafts included) and every other feature its listing.
 */
export function scenarioSequence(
  root: FolderNode,
  openFile: string | null,
  open: { scenarios: readonly Scenario[] } | null,
): ScenarioStop[] {
  const out: ScenarioStop[] = [];
  const walk = (node: FolderNode) => {
    for (const child of node.folders) walk(child);
    for (const f of node.features) {
      for (const scenario of scenarioRows(f, openFile, open)) out.push({ file: f.fileName, scenario });
    }
  };
  walk(root);
  return out;
}

/**
 * The scenarios either side of `at` in `sequence` — null at either end, and
 * both null when `at` isn't in it (a new scenario not yet saved).
 */
export function scenarioNeighbors(
  sequence: readonly ScenarioStop[],
  file: string,
  at: { name: string; version: number },
): { prev: ScenarioStop | null; next: ScenarioStop | null } {
  const i = sequence.findIndex(
    (s) => s.file === file && s.scenario.name === at.name && s.scenario.version === at.version,
  );
  if (i < 0) return { prev: null, next: null };
  return { prev: sequence[i - 1] ?? null, next: sequence[i + 1] ?? null };
}

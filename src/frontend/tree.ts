// Sidebar folder tree (specs/ui/folders.feature.md): folders are directories
// in the data repo; features hang off the folder they live in. The tree is
// built from the flat /api/features listing.

import type { FeatureListing } from "../server/features";
import { attributesKey, type Scenario, type ScenarioStatus, type SpecAttribute } from "../server/parser";
import { SPECS_FOLDER } from "./route";

export interface FolderNode {
  /** Display segment, e.g. `billing`. */
  name: string;
  /** Full folder path relative to the repo root; `specs` for the root node. */
  path: string;
  /**
   * What the folder's description.txt says (specs/ui/folders.feature.md
   * "describe a folder"): the sidebar shows it in place of `name`.
   */
  description?: string;
  folders: FolderNode[];
  features: FeatureListing[];
}

/** The sidebar's label for a folder: its description when it has one, else its name. */
export function folderLabel(node: Pick<FolderNode, "name" | "description">): string {
  return node.description ?? node.name;
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
 *
 * `descriptions` is the listing's folder-path → description map; a folder
 * in it carries its description on its node. Order is by folder name still —
 * the description is a label, not the folder's place in the tree.
 */
export function buildTree(
  folders: string[],
  features: FeatureListing[],
  descriptions: Record<string, string> = {},
): FolderNode {
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
    const description = descriptions[path];
    const node: FolderNode = {
      name: segments[segments.length - 1]!,
      path,
      ...(description ? { description } : {}),
      folders: [],
      features: [],
    };
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
 * entry already agrees, so a state update with it changes nothing. The
 * custom attributes come along (specs/app/custom-attributes.feature.md), so
 * the attribute filter sees an edit before the refresh does.
 */
export function withOpenScenarios(
  listing: FeatureListing[],
  openFile: string,
  open: { scenarios: readonly Scenario[]; attributes?: SpecAttribute[] },
): FeatureListing[] {
  const at = listing.findIndex((f) => f.fileName === openFile);
  if (at < 0) return listing;
  const scenarios = open.scenarios
    .filter((s) => s.status !== "draft")
    .map(({ name, version, status, attributes }) => ({
      name,
      version,
      status,
      ...(attributes?.length ? { attributes } : {}),
    }));
  const entry = listing[at]!;
  const same =
    attributesKey(entry.attributes) === attributesKey(open.attributes) &&
    entry.scenarios.length === scenarios.length &&
    entry.scenarios.every(
      (s, i) =>
        s.name === scenarios[i]!.name &&
        s.version === scenarios[i]!.version &&
        s.status === scenarios[i]!.status &&
        attributesKey(s.attributes) === attributesKey(scenarios[i]!.attributes),
    );
  if (same) return listing;
  const next = listing.slice();
  const { attributes: _previous, ...rest } = entry;
  next[at] = { ...rest, scenarios, ...(open.attributes?.length ? { attributes: open.attributes } : {}) };
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

/** How many features a folder holds, its subfolders included. */
export function featuresBeneath(node: FolderNode): number {
  return node.features.length + node.folders.reduce((n, child) => n + featuresBeneath(child), 0);
}

/** The node for a folder path, or null when the tree has no such folder. */
export function findFolder(root: FolderNode, path: string): FolderNode | null {
  if (root.path === path) return root;
  for (const child of root.folders) {
    const found = findFolder(child, path);
    if (found) return found;
  }
  return null;
}

/**
 * Where a path lands once the folder `from` is renamed to `to`
 * (specs/ui/folders.feature.md "rename a folder"): the folder itself, a
 * feature or folder beneath it, or — untouched — anything else. Keyed state
 * (the open feature, the collapsed set, the selected folder) is remapped
 * with it, so nothing points at the retired path.
 */
export function folderRenamed(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

/** One entry of the "Move to folder…" list. */
export interface FolderOption {
  /** Repo-relative folder path; `specs` for the top level. */
  value: string;
  label: string;
  /** Where it sits: the parent path within the tree, blank at the top level. */
  hint: string;
}

/**
 * Every folder a feature can move to, depth first in tree order, with the
 * top level first (specs/ui/folders.feature.md "move a feature from its
 * menu"). The folder the feature is in is left out: moving there is no move.
 */
export function folderOptions(root: FolderNode, except: string | null = null): FolderOption[] {
  const out: FolderOption[] = [];
  const walk = (node: FolderNode) => {
    if (node.path !== except) {
      out.push(
        node === root
          ? { value: root.path, label: "Top level", hint: "" }
          : { value: node.path, label: node.name, hint: node.path.slice(root.path.length + 1, -node.name.length - 1) },
      );
    }
    for (const child of node.folders) walk(child);
  };
  walk(root);
  return out;
}

/**
 * Where a scenario dragged in the sidebar outline lands
 * (specs/ui/navigation.feature.md "reorder scenarios by dragging them in the
 * tree"): dropped on the upper half of `target` it goes just before it, on
 * the lower half just after. Scenarios are found by name and version, so the
 * same drop places it in the open feature (drafts and all) or in the server's
 * copy of another one. The answer is the `from` / `to` pair withScenarioMoved
 * takes, or null when the scenario would stay where it is or either one is
 * not in `scenarios`.
 */
export function scenarioDrop(
  scenarios: readonly { name: string; version: number }[],
  dragged: { name: string; version: number },
  target: { name: string; version: number },
  after: boolean,
): { from: number; to: number } | null {
  const at = (x: { name: string; version: number }) =>
    scenarios.findIndex((s) => s.name === x.name && s.version === x.version);
  const from = at(dragged);
  const over = at(target);
  if (from < 0 || over < 0) return null;
  // The slot in the list as it stands, then one less once the dragged
  // scenario has left a place ahead of it.
  const slot = over + (after ? 1 : 0);
  const to = slot > from ? slot - 1 : slot;
  return to === from ? null : { from, to };
}

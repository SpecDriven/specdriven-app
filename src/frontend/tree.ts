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
   * What the folder's display-name.txt says (specs/ui/folders.feature.md
   * "describe a folder"): the sidebar shows it in place of `name`.
   */
  description?: string;
  folders: FolderNode[];
  features: FeatureListing[];
}

/**
 * The display name a new folder starts with: its own name in initial case —
 * `-` and `_` read as spaces, the first letter capitalised, the rest kept
 * (`billing-rules` → `Billing rules`). Null when that is the name itself.
 */
export function initialCaseDisplayName(folderName: string): string | null {
  const spaced = folderName.replace(/[-_]+/g, " ").trim();
  const name = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return name && name !== folderName ? name : null;
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
 *
 * `orders` is the listing's folder-path → subfolder-name list, from each
 * folder's folder-order.txt (specs/ui/folders.feature.md "order folders"):
 * a folder's subfolders come in that order, the ones it leaves out after
 * them by name. The root's order is keyed by `specs`.
 *
 * `featureOrders` is the same for features, from each folder's
 * feature-order.txt ("order features"): file names in that order first, the
 * rest after them by feature name.
 */
export function buildTree(
  folders: string[],
  features: FeatureListing[],
  descriptions: Record<string, string> = {},
  orders: Record<string, readonly string[]> = {},
  featureOrders: Record<string, readonly string[]> = {},
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
    node.folders = orderedFolders(node.folders, orders[node.path] ?? []);
    node.features = orderedFeatures(node.features, featureOrders[node.path] ?? []);
  }
  return root;
}

/** A feature's file name without its folder — what a feature-order.txt names. */
export function featureBaseName(fileName: string): string {
  return fileName.slice(fileName.lastIndexOf("/") + 1);
}

/**
 * Items in the order `order` ranks their keys: the ranked ones first, in
 * that order, then the rest as `rest` sorts them. A key the order names
 * with no item behind it is skipped.
 */
function ordered<T>(
  items: readonly T[],
  order: readonly string[],
  key: (item: T) => string,
  rest: (a: T, b: T) => number,
): T[] {
  const rank = new Map(order.map((name, i) => [name, i] as const));
  return items.slice().sort((a, b) => {
    const ra = rank.get(key(a));
    const rb = rank.get(key(b));
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return rest(a, b);
  });
}

/**
 * A folder's features in the order its feature-order.txt gives them
 * (specs/ui/folders.feature.md "order features"): the named files first, in
 * that order, then the rest by feature name.
 */
export function orderedFeatures<T extends { fileName: string; name: string }>(
  features: readonly T[],
  order: readonly string[],
): T[] {
  return ordered(features, order, (f) => featureBaseName(f.fileName), (a, b) => a.name.localeCompare(b.name));
}

/**
 * A folder's subfolders in the order its folder-order.txt gives them: the
 * named ones first, in that order, then the rest by name. A name with no
 * folder behind it is skipped.
 */
export function orderedFolders<T extends { name: string }>(folders: readonly T[], order: readonly string[]): T[] {
  return ordered(folders, order, (f) => f.name, (a, b) => a.name.localeCompare(b.name));
}

/**
 * The folder names to save once the subfolder at `from` moves to `to`
 * (specs/ui/folders.feature.md "order folders") — what Move up / Move down
 * and a drop in the tree send the server: every sibling, in the new order.
 * Null when the move goes nowhere.
 */
export function folderNamesMoved(siblings: readonly { name: string }[], from: number, to: number): string[] | null {
  return moved(siblings.map((f) => f.name), from, to);
}

/**
 * The feature file names to save once the feature at `from` moves to `to`
 * (specs/ui/folders.feature.md "order features") — every sibling's file name,
 * without its folder, in the new order. Null when the move goes nowhere.
 */
export function featureNamesMoved(siblings: readonly { fileName: string }[], from: number, to: number): string[] | null {
  return moved(siblings.map((f) => featureBaseName(f.fileName)), from, to);
}

/** `names` with the one at `from` moved to `to`; null when that goes nowhere. */
function moved(names: string[], from: number, to: number): string[] | null {
  if (from < 0 || to < 0 || from >= names.length || to >= names.length || from === to) return null;
  const [item] = names.splice(from, 1);
  names.splice(to, 0, item!);
  return names;
}

/**
 * Where a folder dragged onto a sibling's row lands ("order folders"): the
 * same halves as a scenario drop — the upper half of `target` puts it just
 * before, the lower half just after. The answer is the `from` / `to` pair
 * folderNamesMoved takes, or null when the folder would stay put or either
 * one is not among `siblings`.
 */
export function folderDrop(
  siblings: readonly { path: string }[],
  dragged: string,
  target: string,
  after: boolean,
): { from: number; to: number } | null {
  return dropMove(siblings.map((f) => f.path), dragged, target, after);
}

/**
 * Where a feature dragged onto a sibling feature's row lands ("order
 * features"): just before `target` on its upper half, just after on its
 * lower half — folderDrop's rule, by file name. Null when it would stay put
 * or either one is not among `siblings`.
 */
export function featureDrop(
  siblings: readonly { fileName: string }[],
  dragged: string,
  target: string,
  after: boolean,
): { from: number; to: number } | null {
  return dropMove(siblings.map((f) => f.fileName), dragged, target, after);
}

/** The `from` / `to` pair for dropping `dragged` before or after `target` among `ids`. */
function dropMove(
  ids: readonly string[],
  dragged: string,
  target: string,
  after: boolean,
): { from: number; to: number } | null {
  const from = ids.indexOf(dragged);
  const over = ids.indexOf(target);
  if (from < 0 || over < 0) return null;
  const slot = over + (after ? 1 : 0);
  const to = slot > from ? slot - 1 : slot;
  return to === from ? null : { from, to };
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
 * Every folder the folder at `path` can move to (specs/ui/folders.feature.md
 * "move a folder"): the "Move to folder…" list with the folder's own parent
 * left out, and the folder itself and everything beneath it too — a folder
 * never moves into itself.
 */
export function folderMoveOptions(root: FolderNode, path: string): FolderOption[] {
  const parent = path.slice(0, path.lastIndexOf("/"));
  return folderOptions(root, parent).filter((o) => o.value !== path && !o.value.startsWith(`${path}/`));
}

/**
 * Whether a folder dragged out of `dragged.parent` drops into `target`
 * (specs/ui/folders.feature.md "move a folder"): any folder but the one it
 * is already in, itself and what is beneath it — `SPECS_FOLDER` being the
 * tree background, the top level.
 */
export function folderDropsInto(dragged: { parent: string; path: string }, target: string): boolean {
  return target !== dragged.parent && target !== dragged.path && !target.startsWith(`${dragged.path}/`);
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

/**
 * Whether a scenario dragged out of `dragged.file` drops into the feature
 * `target` (specs/ui/navigation.feature.md "drag a scenario to another
 * feature"): any feature but its own, on the terms of its Move to… — a
 * published scenario only while Settings allows deleting published ones.
 */
export function scenarioMovesInto(
  dragged: { file: string; status: string },
  target: string,
  deletePublished: boolean,
): boolean {
  return target !== dragged.file && (dragged.status !== "published" || deletePublished);
}

/**
 * The place `s` holds among `scenarios`, as the move route's `at` names one:
 * just before the scenario after it, or just after the one before it when it
 * is last. A moved scenario's Undo puts it back there. Null when it is not
 * in `scenarios` or is the only one — back last is then back in place.
 */
export function scenarioPlace(
  scenarios: readonly { name: string; version: number }[],
  s: { name: string; version: number },
): { name: string; version: number; after: boolean } | null {
  const i = scenarios.findIndex((x) => x.name === s.name && x.version === s.version);
  if (i < 0) return null;
  const next = scenarios[i + 1];
  if (next) return { name: next.name, version: next.version, after: false };
  const prev = scenarios[i - 1];
  return prev ? { name: prev.name, version: prev.version, after: true } : null;
}

/**
 * The folders a feature file sits under, outermost first, the root left out
 * (`specs/billing/eu/quote.feature.md` → `specs/billing`, `specs/billing/eu`).
 * The ones to open so the file's row can be seen (specs/ui/navigation.
 * feature.md "the tree follows the open feature").
 */
export function foldersAbove(fileName: string): string[] {
  const segments = fileName.split("/").slice(0, -1);
  const above: string[] = [];
  for (let i = 2; i <= segments.length; i++) above.push(segments.slice(0, i).join("/"));
  return above;
}

/**
 * The collapsed-folder set with every folder above `fileName` opened — the
 * same set back when none of them was collapsed, so a state update can skip
 * the re-render.
 */
export function revealed(collapsed: Set<string>, fileName: string): Set<string> {
  const above = foldersAbove(fileName).filter((path) => collapsed.has(path));
  if (above.length === 0) return collapsed;
  const next = new Set(collapsed);
  for (const path of above) next.delete(path);
  return next;
}

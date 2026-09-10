// Full-text search over the data repo (specs/search.spec.md): an in-memory
// MiniSearch index over feature names/descriptions and scenario names/bodies,
// and one more over each special folder's pages — the roadmap's (specs/app
// /roadmap.feature.md) and the tasks folder's (specs/app/tasks.feature.md) —
// which is what that folder's sidebar tab searches instead of the specs. Each index is cached per data dir and rebuilt only when a stat
// fingerprint of its files changes, so edits made by the API, the reload
// cron's `git pull`, or an external editor are all picked up.

import { stat } from "node:fs/promises";
import MiniSearch from "minisearch";
import { walk } from "./walk";
import { readTextFile } from "./fsx";
import { parseFeature, parsePage, titleFromFileName } from "./parser";
import { PAGE_FOLDERS, pageFiles, pageFolderNamed, type PageFolder } from "./pages";
import { MODELS_FOLDER, modelFiles } from "./models";
import { modelTextError, parseModelFile } from "./eventModel/serialize";
import { allElements } from "./eventModel/types";

/**
 * What a search runs over: the spec files, a special folder's pages, or the
 * Event Models (roadmap/support-event-modeling.md) — what the Models tab
 * searches.
 */
export type SearchScope = "specs" | (typeof PAGE_FOLDERS)[number]["folder"] | typeof MODELS_FOLDER;

export function isSearchScope(value: unknown): value is SearchScope {
  return (
    value === "specs" ||
    value === MODELS_FOLDER ||
    (typeof value === "string" && pageFolderNamed(value) !== null)
  );
}

interface SearchDoc {
  id: string;
  /** Indexed: feature, scenario or page display name (boosted over `text`). */
  name: string;
  /** Indexed: feature description, scenario body (tests table excluded) or page body. */
  text: string;
  kind: "feature" | "scenario" | "page" | "model";
  fileName: string;
  featureName: string;
  scenarioName?: string;
  version?: number;
}

export interface SearchResultItem {
  kind: "feature" | "scenario" | "page" | "model";
  /** Path relative to the data repo root, e.g. `billing/quotes.feature.md`. */
  fileName: string;
  /** The feature's display name — for a page hit, the page's. */
  featureName: string;
  /** Scenario hits only — enough to open the result like its deep link. */
  scenario?: { name: string; version: number };
  score: number;
  /** Matched document terms (prefix/fuzzy-expanded) for client highlighting. */
  terms: string[];
  snippet: string;
}

function newIndex(): MiniSearch<SearchDoc> {
  return new MiniSearch<SearchDoc>({
    fields: ["name", "text"],
    storeFields: ["kind", "fileName", "featureName", "scenarioName", "version", "text"],
    searchOptions: { boost: { name: 3 }, prefix: true, fuzzy: 0.2 },
  });
}

/** One cached index per scope and data dir. */
const cache = new Map<string, { fingerprint: string; index: MiniSearch<SearchDoc> }>();

/** Test hook: drop cached indexes so a fresh fixture starts clean. */
export function resetSearchCache(): void {
  cache.clear();
}

/**
 * Change detector cheap enough to run per search: one stat per feature file,
 * no content reads. Any edit, add or delete shifts `mtimeMs`/`size`/the file
 * list and forces a rebuild.
 */
async function fingerprint(dataDir: string, files: string[]): Promise<string> {
  const parts = await Promise.all(
    files.map(async (f) => {
      try {
        const s = await stat(`${dataDir}/${f}`);
        return `${f}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${f}:gone`;
      }
    }),
  );
  return parts.sort().join("|");
}

async function buildSpecsIndex(dataDir: string, files: string[]): Promise<MiniSearch<SearchDoc>> {
  const docs: SearchDoc[] = [];
  for (const fileName of files) {
    const content = await readTextFile(`${dataDir}/${fileName}`);
    if (content === null) continue; // deleted between walk and read
    const feature = parseFeature(content);
    const featureName = feature.name || titleFromFileName(fileName);
    docs.push({
      id: `F:${fileName}`,
      kind: "feature",
      name: featureName,
      text: feature.description,
      fileName,
      featureName,
    });
    // Every version is its own document: versions are distinct immutable
    // scenarios (specs/crud-feature.spec.md) and rank independently.
    for (const s of feature.scenarios) {
      docs.push({
        id: `S:${fileName}#${s.name}@v${s.version}`,
        kind: "scenario",
        name: s.name,
        text: s.body,
        fileName,
        featureName,
        scenarioName: s.name,
        version: s.version,
      });
    }
  }
  const index = newIndex();
  index.addAll(docs);
  return index;
}

/** One document per page: its heading is the name, the rest the text. */
async function buildPageIndex(
  dataDir: string,
  files: string[],
): Promise<MiniSearch<SearchDoc>> {
  const docs: SearchDoc[] = [];
  for (const fileName of files) {
    const content = await readTextFile(`${dataDir}/${fileName}`);
    if (content === null) continue;
    const page = parsePage(content);
    const name = page.name || titleFromFileName(fileName.replace(/\.md$/, ""));
    docs.push({ id: `P:${fileName}`, kind: "page", name, text: page.body, fileName, featureName: name });
  }
  const index = newIndex();
  index.addAll(docs);
  return index;
}

/**
 * One document per model: its name, and as text the titles of its slices,
 * elements and specifications — what someone remembers of a model.
 */
async function buildModelIndex(
  dataDir: string,
  files: string[],
): Promise<MiniSearch<SearchDoc>> {
  const docs: SearchDoc[] = [];
  for (const fileName of files) {
    const content = await readTextFile(`${dataDir}/${fileName}`);
    if (content === null || modelTextError(content) !== null) continue;
    const file = parseModelFile(content);
    const name = file.name || titleFromFileName(fileName.replace(/\.model\.json$/, ""));
    const words: string[] = [];
    for (const slice of file.model.slices) {
      words.push(slice.title);
      for (const spec of slice.specifications) words.push(spec.title);
    }
    for (const { element } of allElements(file.model)) {
      words.push(element.title);
      if (element.description) words.push(element.description);
    }
    docs.push({
      id: `M:${fileName}`,
      kind: "model",
      name,
      text: words.join(" · "),
      fileName,
      featureName: name,
    });
  }
  const index = newIndex();
  index.addAll(docs);
  return index;
}

async function getIndex(dataDir: string, scope: SearchScope): Promise<MiniSearch<SearchDoc>> {
  const folder = scope === "specs" || scope === MODELS_FOLDER ? null : pageFolderNamed(scope);
  const files = folder
    ? await pageFiles(dataDir, folder.folder)
    : scope === MODELS_FOLDER
      ? await modelFiles(dataDir, MODELS_FOLDER)
      : (await walk(dataDir)).files.sort();
  const fp = await fingerprint(dataDir, files);
  const key = `${scope}:${dataDir}`;
  const cached = cache.get(key);
  if (cached && cached.fingerprint === fp) return cached.index;
  const index = folder
    ? await buildPageIndex(dataDir, files)
    : scope === MODELS_FOLDER
      ? await buildModelIndex(dataDir, files)
      : await buildSpecsIndex(dataDir, files);
  cache.set(key, { fingerprint: fp, index });
  return index;
}

const SNIPPET_LEN = 180;

/**
 * A ~180-char window of `text` around the first occurrence of any matched
 * term, whitespace-collapsed, ellipsized on cut edges, with the left edge
 * snapped forward to a word start. When no term occurs in the text (the
 * match was on the name field), the head of the text serves as context.
 */
export function makeSnippet(text: string, terms: string[]): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const lower = collapsed.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at !== -1 && (hit === -1 || at < hit)) hit = at;
  }
  if (hit === -1) {
    return collapsed.length <= SNIPPET_LEN ? collapsed : `${collapsed.slice(0, SNIPPET_LEN)}…`;
  }
  let start = Math.max(0, hit - Math.floor(SNIPPET_LEN / 3));
  if (start > 0) {
    const space = collapsed.indexOf(" ", start);
    if (space !== -1 && space < hit) start = space + 1;
  }
  const end = Math.min(collapsed.length, start + SNIPPET_LEN);
  const head = start > 0 ? "…" : "";
  const tail = end < collapsed.length ? "…" : "";
  return `${head}${collapsed.slice(start, end).trim()}${tail}`;
}

/**
 * Ranked full-text hits for `query`, best first — MiniSearch TF-IDF with
 * name matches boosted 3×, prefix expansion and light fuzziness (0.2).
 */
export async function searchSpecs(
  dataDir: string,
  query: string,
  limit = 20,
): Promise<SearchResultItem[]> {
  return search(dataDir, "specs", query, limit);
}

/** The same search over the Event Models: one hit per model. */
export async function searchModels(
  dataDir: string,
  query: string,
  limit = 20,
): Promise<SearchResultItem[]> {
  return search(dataDir, MODELS_FOLDER, query, limit);
}

/** The same search over a special folder's pages: one hit per page. */
export async function searchPages(
  dataDir: string,
  kind: PageFolder,
  query: string,
  limit = 20,
): Promise<SearchResultItem[]> {
  return search(dataDir, kind.folder, query, limit);
}

async function search(
  dataDir: string,
  scope: SearchScope,
  query: string,
  limit: number,
): Promise<SearchResultItem[]> {
  const q = query.trim();
  if (!q) return [];
  const index = await getIndex(dataDir, scope);
  return index.search(q).slice(0, limit).map((r) => ({
    kind: r.kind as SearchDoc["kind"],
    fileName: r.fileName as string,
    featureName: r.featureName as string,
    ...(r.kind === "scenario"
      ? { scenario: { name: r.scenarioName as string, version: r.version as number } }
      : {}),
    score: r.score,
    terms: r.terms,
    snippet: makeSnippet(r.text as string, r.terms),
  }));
}

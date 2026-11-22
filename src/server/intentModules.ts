// The module structure of a code project, as folders to propose for its
// specifications (specs/app/extract-specs-from-code.feature.md): the first
// thing "extract specs from a code project" works out, and what the user
// reviews before anything is created.
//
// A project is read in two layers. A *unit* is a directory a build tool
// knows as a module — an npm, pnpm or Lerna workspace, an Nx project, a
// tsconfig reference, a Maven module, a Gradle project, a Python project —
// or simply one with a build file of its own. A unit that is the whole
// project, or a large one, is then split into *parts* by its layout: the
// Java packages below the base package, the folders under `src`, the
// Python packages and Django apps. Units and parts nest by directory, and
// every file belongs to the deepest folder that contains it, so no file is
// proposed twice. Tests never get a folder: they go with the code they
// test.
//
// Java, JavaScript, TypeScript and Python are read; files in other
// languages are counted and reported, not proposed.
//
// Pure: a snapshot of the file list and the build files' text goes in
// (src/server/intentScan.ts reads it), the proposal comes out.

import {
  matchWorkspaceGlobs,
  readGradleSettings,
  readLernaJson,
  readPackageJson,
  readPnpmWorkspace,
  readPom,
  readPyProject,
  readSetupPy,
  readTsconfigReferences,
} from "./intentManifests";
import { displayName, LANGUAGE_LABEL, type Language } from "./intentNames";
import { slugify } from "./parser";

export { LANGUAGE_LABEL };
export type { Language };

export interface SnapshotFile {
  /** Relative to the project, `/` separated. */
  path: string;
  size: number;
}

/** A code project as the analysis sees it: its files and the text of its build files. */
export interface RepoSnapshot {
  /** The project folder's name. */
  name: string;
  files: SnapshotFile[];
  /** Build files by path: package.json, pom.xml, settings.gradle, pyproject.toml and the like. */
  manifests: Record<string, string>;
  /** The file list was cut at the scan's limit. */
  truncated?: boolean;
}

/** Where a proposed folder came from. */
export type ModuleSource =
  | "npm-workspace"
  | "pnpm-workspace"
  | "lerna"
  | "nx"
  | "tsconfig-reference"
  | "npm-package"
  | "maven-module"
  | "gradle-project"
  | "python-project"
  | "java-package"
  | "python-package"
  | "django-app"
  | "source-dir"
  /** A folder that only holds modules: `services/`, `libs/`. */
  | "group"
  /** Files at the top of the project, or the whole of a project with no structure. */
  | "root"
  /** A folder the agent's regrouping made (src/server/intentRefine.ts). */
  | "refined";

export interface ProposedFolder {
  /** The folder's own directory in the project; "." for the project's top. Stable between analyses. */
  id: string;
  /** Where its specs go, under `specs/`: slug segments, its parents' first. */
  folder: string;
  /** What the sidebar shows. */
  name: string;
  /** One line from the build file, when it has one. */
  description: string;
  languages: Language[];
  /** The ids whose files this folder's specs are drafted from — its own, until a regrouping merges several. */
  modules: string[];
  /** Source files of its own, tests and its subfolders' files not counted. */
  files: number;
  /** Test files that go with it. */
  tests: number;
  /** The size of both, in bytes. */
  bytes: number;
  source: ModuleSource;
  /** Why it is proposed, as one phrase: "Maven module listed in pom.xml". */
  reason: string;
  /** Ticked when the review opens. */
  selected: boolean;
  children: ProposedFolder[];
}

export interface ModuleProposal {
  project: string;
  /** The supported languages found, most files first. */
  languages: Language[];
  folders: ProposedFolder[];
  /** Source files in the supported languages, tests included. */
  sourceFiles: number;
  /** Other languages found, and how many files of each: counted, never proposed. */
  skipped: { what: string; files: number }[];
  /** The project was larger than the analysis reads, or had more folders than it proposes. */
  truncated: boolean;
}

/** The files one proposed folder owns. */
export interface ModuleFiles {
  /** Source in the supported languages. */
  source: string[];
  tests: string[];
  /** Everything else it holds: documents, API contracts, configuration. */
  rest: string[];
}

// --- Limits --------------------------------------------------------------------------

/** A unit with more source files than this is split by its layout. */
const SPLIT_MIN_FILES = 40;
/** How deep proposed folders nest. */
export const MAX_FOLDER_DEPTH = 3;
/** How many folders are proposed at most. */
export const MAX_FOLDERS = 60;
/** How deep in the project a build file still makes a unit. */
const MAX_UNIT_DEPTH = 5;
/** Loose files at the top of a project get a folder of their own from this many. */
const MIN_GENERAL_FILES = 3;
/** A folder beside the units starts ticked from this many files. */
const MIN_TICKED_FILES = 5;

/** The id of the folder that stands for the project's top. */
export const ROOT_ID = ".";

// --- Files ---------------------------------------------------------------------------

const LANGUAGE_BY_EXT: Record<string, Language> = {
  java: "java",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  vue: "javascript",
  svelte: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
};

/** Languages the analysis does not read, to say how much of a project that is. */
const OTHER_BY_EXT: Record<string, string> = {
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  cs: "C#",
  kt: "Kotlin",
  php: "PHP",
  swift: "Swift",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  hpp: "C++",
  scala: "Scala",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  groovy: "Groovy",
  m: "Objective-C",
  sql: "SQL",
  sh: "Shell",
};

/** Directories that hold what was installed, built or generated — never a project's own code. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
  "third_party",
  "third-party",
  "generated",
  "__generated__",
  "__pycache__",
  "venv",
  "env",
  "site-packages",
]);

/** Whether a path lies in an installed, built, generated or hidden directory. */
export function isExcludedPath(path: string): boolean {
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.startsWith(".")) return true;
    if (i === segments.length - 1) break;
    if (EXCLUDED_DIRS.has(s) || s.endsWith(".egg-info")) return true;
  }
  return false;
}

/** The supported language a file is written in, by its extension; null for any other file. */
export function languageOf(path: string): Language | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/\.d\.[mc]?ts$/.test(name)) return null;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : (LANGUAGE_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null);
}

const TEST_DIRS = new Set(["__tests__", "__mocks__", "test", "tests", "testing", "e2e", "cypress", "playwright", "spec"]);
const JAVA_TEST_SETS = new Set(["test", "it", "integrationTest", "integration-test", "testFixtures", "functionalTest"]);

/** Whether a file is a test, by the folder it sits in or by its name. */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1]!;
  for (let i = 0; i < segments.length - 1; i++) {
    if (TEST_DIRS.has(segments[i]!)) return true;
    if (segments[i] === "src" && JAVA_TEST_SETS.has(segments[i + 1] ?? "")) return true;
  }
  return (
    /\.(test|spec|e2e|cy)\.[A-Za-z]+$/.test(name) ||
    /^test_.*\.py$/.test(name) ||
    /_test\.py$/.test(name) ||
    name === "conftest.py" ||
    /(Test|Tests|IT|TestCase)\.java$/.test(name)
  );
}

interface FileInfo {
  path: string;
  size: number;
  language: Language | null;
  test: boolean;
}

// --- Paths ---------------------------------------------------------------------------

const dirOf = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
};
const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const joinPath = (a: string, b: string): string => (a && b ? `${a}/${b}` : a || b);
const depthOf = (dir: string): number => (dir === "" ? 0 : dir.split("/").length);
const isUnder = (path: string, dir: string): boolean => dir === "" || path === dir || path.startsWith(`${dir}/`);

/**
 * `rel` as a build file wrote it, resolved against the directory the build
 * file is in: `./a`, `a/`, `../b`. Null when it leaves the project.
 */
function resolveRel(from: string, rel: string): string | null {
  const out = from ? from.split("/") : [];
  for (const segment of rel.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
}

// --- Layout helpers, over paths relative to a unit -----------------------------------

/** The first of `bases` that holds one of the paths; "" always does. */
function firstBase(paths: readonly string[], bases: readonly string[]): string {
  for (const base of bases) if (base === "" || paths.some((p) => p.startsWith(`${base}/`))) return base;
  return "";
}

/** The directories directly under `dir` that hold one of the paths, by name. */
function subdirsOf(paths: readonly string[], dir: string): string[] {
  const prefix = dir ? `${dir}/` : "";
  const names = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash > 0) names.add(rest.slice(0, slash));
  }
  return [...names].sort();
}

const hasDirectFile = (paths: readonly string[], dir: string): boolean => paths.some((p) => dirOf(p) === dir);
const countUnder = (paths: readonly string[], dir: string): number => paths.filter((p) => isUnder(p, dir)).length;

/** `dir`, followed down while it holds nothing but one subdirectory: `src/main/java/com/acme`. */
function descendLone(paths: readonly string[], dir: string): string {
  let cur = dir;
  for (;;) {
    const subs = subdirsOf(paths, cur);
    if (subs.length !== 1 || hasDirectFile(paths, cur)) return cur;
    cur = joinPath(cur, subs[0]!);
  }
}

// --- Candidates ----------------------------------------------------------------------

interface Candidate {
  /** The directory in the project; "" only for the folder standing for the project's top. */
  root: string;
  /** A build file's name for it, or "" to name it after its directory. */
  name: string;
  description: string;
  source: ModuleSource;
  reason: string;
  /** A build tool knows it as a module. */
  unit: boolean;
  /** Shared plumbing — `utils`, `config` — proposed unticked. */
  support?: boolean;
  /** A folder beside the units, ticked only when it holds enough. */
  minor?: boolean;
}

/** Folder names that hold shared plumbing rather than behaviour of their own. */
const SUPPORT_DIRS = new Set([
  "util",
  "utils",
  "helpers",
  "common",
  "shared",
  "types",
  "typings",
  "config",
  "configs",
  "constants",
  "styles",
  "assets",
  "i18n",
  "locales",
  "mocks",
  "fixtures",
  "scripts",
  "tools",
  "migrations",
]);

/** Folders under `src` that only sort modules, so their subfolders are proposed instead. */
const CONTAINER_DIRS = new Set(["features", "modules", "domains", "apps", "services", "packages", "pages", "routes"]);

/**
 * The parts a unit splits into by its layout, as directories in the
 * project. `own` is the unit's source — tests and the files of units inside
 * it left out. Empty when the layout gives fewer than two parts.
 */
function splitUnit(unitRoot: string, own: readonly FileInfo[], where: readonly string[]): Candidate[] {
  const prefix = unitRoot ? `${unitRoot}/` : "";
  const abs = (rel: string) => joinPath(unitRoot, rel);
  const rels = (langs: readonly Language[]) =>
    own.filter((f) => f.language !== null && langs.includes(f.language)).map((f) => f.path.slice(prefix.length));
  const all = own.map((f) => f.path.slice(prefix.length));
  const parts = new Map<string, Candidate>();
  const put = (rel: string, source: ModuleSource, reason: string, extra: Partial<Candidate> = {}) => {
    if (!rel || parts.has(rel)) return;
    parts.set(rel, {
      root: abs(rel),
      name: "",
      description: "",
      source,
      reason,
      unit: false,
      ...(SUPPORT_DIRS.has(baseOf(rel).toLowerCase()) ? { support: true } : {}),
      ...extra,
    });
  };
  const where_ = (rel: string) => abs(rel) || "the project";

  const java = rels(["java"]);
  if (java.length > 0) {
    const base = descendLone(java, firstBase(java, ["src/main/java", "src/java", "src", ""]));
    for (const sub of subdirsOf(java, base)) put(joinPath(base, sub), "java-package", `Java package under ${where_(base)}`);
  }

  const js = rels(["javascript", "typescript"]);
  if (js.length > 0) {
    const base = descendLone(js, firstBase(js, ["src", "lib", "app", "source", ""]));
    for (const sub of subdirsOf(js, base)) {
      const dir = joinPath(base, sub);
      const inner = subdirsOf(js, dir);
      if (CONTAINER_DIRS.has(sub.toLowerCase()) && inner.length >= 2) {
        for (const s of inner) put(joinPath(dir, s), "source-dir", `Folder under ${where_(dir)}`);
      } else put(dir, "source-dir", `Folder under ${where_(base)}`);
    }
    if (base !== "") {
      const top = base.split("/")[0]!;
      for (const sub of subdirsOf(js, "")) {
        if (sub !== top && countUnder(js, sub) >= 2) put(sub, "source-dir", `Folder at the top of ${where_("")}`, { minor: true });
      }
    }
  }

  const py = rels(["python"]);
  if (py.length > 0) {
    const packages = new Set(py.filter((p) => baseOf(p) === "__init__.py").map(dirOf));
    const apps = new Set(py.filter((p) => baseOf(p) === "apps.py").map(dirOf));
    const kind = (dir: string): ModuleSource => (apps.has(dir) ? "django-app" : "python-package");
    const why = (dir: string, parent: string) =>
      apps.has(dir) ? `Django app in ${where_(parent)}` : `Python package in ${where_(parent)}`;
    const inside = (parent: string) => [...packages].filter((d) => d !== parent && dirOf(d) === parent).sort();
    let level: string[];
    if (packages.has("")) level = inside("");
    else {
      const tops = [...packages].filter((d) => !packages.has(dirOf(d))).sort();
      const subs = tops.length === 1 ? inside(tops[0]!) : [];
      level = tops.length === 1 && subs.length >= 2 ? subs : tops;
    }
    for (const app of apps) if (app && !level.some((d) => isUnder(app, d))) level.push(app);
    if (level.length > 0) {
      for (const dir of level) put(dir, kind(dir), why(dir, dirOf(dir)));
    } else {
      const base = descendLone(py, firstBase(py, [...where, "src", ""]));
      for (const sub of subdirsOf(py, base)) {
        if (countUnder(py, joinPath(base, sub)) >= 2) put(joinPath(base, sub), "source-dir", `Folder under ${where_(base)}`);
      }
    }
  }

  // A part that holds another one would take its files twice: the inner ones stay.
  const rootsNow = [...parts.keys()];
  for (const rel of rootsNow) {
    if (rootsNow.some((other) => other !== rel && isUnder(other, rel))) parts.delete(rel);
  }
  const kept = [...parts.entries()].filter(([rel]) => countUnder(all, rel) >= 1).map(([, c]) => c);
  return kept.length >= 2 ? kept : [];
}

/** The parts of a large part: its subfolders that hold a few files each. */
function splitPart(part: Candidate, own: readonly FileInfo[]): Candidate[] {
  const paths = own.filter((f) => isUnder(f.path, part.root)).map((f) => f.path);
  if (paths.length <= SPLIT_MIN_FILES * 2) return [];
  const subs = subdirsOf(paths, part.root).filter((s) => countUnder(paths, joinPath(part.root, s)) >= 3);
  if (subs.length < 2) return [];
  return subs.map((s) => ({
    root: joinPath(part.root, s),
    name: "",
    description: "",
    source: part.source === "java-package" ? "java-package" : "source-dir",
    reason: part.source === "java-package" ? `Java package under ${part.root}` : `Folder under ${part.root}`,
    unit: false,
    ...(SUPPORT_DIRS.has(s.toLowerCase()) ? { support: true } : {}),
  }));
}

// --- Units from the build files ------------------------------------------------------

/** Every directory a build tool knows as a module, by directory. The project's top is never one. */
function findUnits(snapshot: RepoSnapshot, files: readonly FileInfo[]): Map<string, Candidate & { where: string[] }> {
  const manifests = snapshot.manifests;
  const paths = Object.keys(manifests).filter((p) => !isExcludedPath(p)).sort();
  const named = (name: string) => paths.filter((p) => baseOf(p) === name);
  const dirs = new Set<string>();
  for (const f of files) for (let d = dirOf(f.path); d; d = dirOf(d)) dirs.add(d);
  const holdsSource = (dir: string) => files.some((f) => f.language !== null && isUnder(f.path, dir));

  const units = new Map<string, Candidate & { where: string[] }>();
  const add = (root: string | null, source: ModuleSource, reason: string, name = "", description = "") => {
    if (!root || !dirs.has(root) || depthOf(root) > MAX_UNIT_DEPTH || isExcludedPath(`${root}/x`)) return;
    const have = units.get(root);
    if (have) {
      if (!have.name) have.name = name;
      if (!have.description) have.description = description;
      return;
    }
    units.set(root, { root, name, description, source, reason, unit: true, where: [] });
  };
  const at = (dir: string, file: string) => joinPath(dir, file);

  // JavaScript and TypeScript: workspaces, Nx projects, tsconfig references.
  const packageDirs = named("package.json").map(dirOf);
  const pkg = (dir: string) => readPackageJson(manifests[at(dir, "package.json")] ?? "");
  const workspace = (dir: string, globs: readonly string[], source: ModuleSource, listedIn: string) => {
    const prefix = dir ? `${dir}/` : "";
    const candidates = packageDirs.filter((d) => d !== dir && isUnder(d, dir)).map((d) => d.slice(prefix.length));
    for (const rel of matchWorkspaceGlobs(globs, candidates)) {
      const root = joinPath(dir, rel);
      const info = pkg(root);
      add(root, source, `${listedIn} in ${at(dir, baseOf(listedInFile(source)))}`, info?.name, info?.description);
    }
  };
  const listedInFile = (source: ModuleSource) =>
    source === "pnpm-workspace" ? "pnpm-workspace.yaml" : source === "lerna" ? "lerna.json" : "package.json";
  for (const dir of packageDirs) {
    const globs = pkg(dir)?.workspaces ?? [];
    if (globs.length > 0) workspace(dir, globs, "npm-workspace", "npm workspace listed");
  }
  for (const p of named("pnpm-workspace.yaml")) workspace(dirOf(p), readPnpmWorkspace(manifests[p]!), "pnpm-workspace", "pnpm workspace listed");
  for (const p of named("lerna.json")) workspace(dirOf(p), readLernaJson(manifests[p]!), "lerna", "Lerna package listed");
  for (const f of files) {
    if (baseOf(f.path) === "project.json" && dirOf(f.path)) {
      const info = pkg(dirOf(f.path));
      add(dirOf(f.path), "nx", "Nx project (project.json)", info?.name, info?.description);
    }
  }
  if (manifests["tsconfig.json"]) {
    for (const ref of readTsconfigReferences(manifests["tsconfig.json"])) {
      const target = resolveRel("", ref);
      const root = target && /\.json$/.test(target) ? dirOf(target) : target;
      const info = root ? pkg(root) : null;
      add(root, "tsconfig-reference", "Project referenced from tsconfig.json", info?.name, info?.description);
    }
  }

  // Maven: the modules each pom lists, followed through the modules' own poms.
  const seenPoms = new Set<string>();
  const visitPom = (pomPath: string) => {
    if (seenPoms.has(pomPath)) return;
    seenPoms.add(pomPath);
    for (const module of readPom(manifests[pomPath] ?? "").modules) {
      const target = resolveRel(dirOf(pomPath), module);
      if (target === null) continue;
      const childPom = /\.xml$/.test(target) ? target : at(target, "pom.xml");
      const info = manifests[childPom] ? readPom(manifests[childPom]) : null;
      add(dirOf(childPom), "maven-module", `Maven module listed in ${pomPath}`, info?.name || info?.artifactId, info?.description);
      if (info) visitPom(childPom);
    }
  };
  const poms = named("pom.xml").sort((a, b) => depthOf(a) - depthOf(b));
  for (const pomPath of poms) {
    if (!seenPoms.has(pomPath) && dirOf(pomPath)) {
      const info = readPom(manifests[pomPath]!);
      add(dirOf(pomPath), "maven-module", "Has its own pom.xml", info.name || info.artifactId, info.description);
    }
    visitPom(pomPath);
  }

  // Gradle: the projects a settings file includes; else the folders with a build file.
  for (const p of [...named("settings.gradle"), ...named("settings.gradle.kts")]) {
    for (const rel of readGradleSettings(manifests[p]!)) add(resolveRel(dirOf(p), rel), "gradle-project", `Gradle project included in ${p}`);
  }
  for (const f of files) {
    const name = baseOf(f.path);
    if ((name === "build.gradle" || name === "build.gradle.kts") && dirOf(f.path)) {
      add(dirOf(f.path), "gradle-project", `Has its own ${name}`);
    }
  }

  // Python: uv workspace members, and any folder with a project file of its own.
  const pyDirs = [...new Set([...named("pyproject.toml"), ...named("setup.py")].map(dirOf))];
  for (const p of named("pyproject.toml")) {
    const project = readPyProject(manifests[p]!);
    const dir = dirOf(p);
    if (project.members.length > 0) {
      const prefix = dir ? `${dir}/` : "";
      const candidates = pyDirs.filter((d) => d !== dir && isUnder(d, dir)).map((d) => d.slice(prefix.length));
      for (const rel of matchWorkspaceGlobs(project.members, candidates)) {
        const member = readPyProject(manifests[at(joinPath(dir, rel), "pyproject.toml")] ?? "");
        add(joinPath(dir, rel), "python-project", `uv workspace member listed in ${p}`, member.name, member.description);
      }
    }
  }
  for (const dir of pyDirs) {
    if (!dir) continue;
    const project = readPyProject(manifests[at(dir, "pyproject.toml")] ?? "");
    const setup = readSetupPy(manifests[at(dir, "setup.py")] ?? "");
    const file = manifests[at(dir, "pyproject.toml")] !== undefined ? "pyproject.toml" : "setup.py";
    add(dir, "python-project", `Has its own ${file}`, project.name || setup.name, project.description);
  }

  // Any other folder with a package.json of its own.
  for (const dir of packageDirs) {
    if (!dir) continue;
    const info = pkg(dir);
    add(dir, "npm-package", "Has its own package.json", info?.name, info?.description);
  }

  // Where each unit keeps its Python packages, and units that hold no code go.
  for (const [root, unit] of units) {
    if (!holdsSource(root)) {
      units.delete(root);
      continue;
    }
    unit.where = [
      ...readPyProject(manifests[at(root, "pyproject.toml")] ?? "").where,
      ...readSetupPy(`${manifests[at(root, "setup.py")] ?? ""}\n${manifests[at(root, "setup.cfg")] ?? ""}`).where,
    ];
  }
  return units;
}

// --- The analysis --------------------------------------------------------------------

interface Node extends Candidate {
  id: string;
  parent: Node | null;
  children: Node[];
  depth: number;
  owned: ModuleFiles;
  bytes: number;
  languages: Map<Language, number>;
}

/** What a test's file name says it tests: `test_billing.py`, `BillingServiceTest.java`, `billing.test.ts`. */
function testedName(fileName: string): string {
  return fileName
    .replace(/\.[A-Za-z]+$/, "")
    .replace(/\.(test|spec|e2e|cy)$/i, "")
    .replace(/^test_/i, "")
    .replace(/_test$/i, "")
    .replace(/(Tests?|IT|TestCase)$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * The child of `node` (or of the project's top) a test belongs to, when its
 * path mirrors one: a folder of the child's name on the way to the test, or
 * a file name that starts with it. The longest name wins, so `billing-api`
 * is preferred over `billing`.
 */
function mirroredChild(path: string, from: string, children: readonly Node[]): Node | null {
  const rel = from ? path.slice(from.length + 1) : path;
  const segments = rel.toLowerCase().split("/");
  const name = testedName(segments.pop() ?? "");
  let best: Node | null = null;
  let bestKey = "";
  for (const child of children) {
    if (child.id === ROOT_ID) continue;
    const key = baseOf(child.root).toLowerCase();
    const plain = key.replace(/[^a-z0-9]/g, "");
    // `OrderControllerIT` is a test of `orders`: the plural does not have to match.
    const singular = plain.length >= 5 ? plain.replace(/s$/, "") : plain;
    const hit = segments.includes(key) || (plain.length >= 4 && (name.startsWith(plain) || name.startsWith(singular)));
    if (hit && key.length > bestKey.length) {
      best = child;
      bestKey = key;
    }
  }
  return best;
}

interface Analysis {
  proposal: ModuleProposal;
  files: Map<string, ModuleFiles>;
}

function analyse(snapshot: RepoSnapshot): Analysis {
  const files: FileInfo[] = snapshot.files
    .filter((f) => !isExcludedPath(f.path))
    .map((f) => ({ path: f.path, size: f.size, language: languageOf(f.path), test: isTestPath(f.path) }));
  let truncated = snapshot.truncated === true;

  // 1. Units, and the source each owns outright.
  const units = findUnits(snapshot, files);
  const unitRoots = [...units.keys()].sort((a, b) => b.length - a.length);
  const unitOf = (path: string): string => unitRoots.find((root) => isUnder(path, root)) ?? "";
  const ownSource = new Map<string, FileInfo[]>();
  for (const f of files) {
    if (f.language === null || f.test) continue;
    const unit = unitOf(f.path);
    const list = ownSource.get(unit);
    if (list) list.push(f);
    else ownSource.set(unit, [f]);
  }

  // 2. Parts: a unit that is the whole project, or a large one, split by layout.
  const candidates = new Map<string, Candidate>(units);
  const rootWhere = [
    ...readPyProject(snapshot.manifests["pyproject.toml"] ?? "").where,
    ...readSetupPy(`${snapshot.manifests["setup.py"] ?? ""}\n${snapshot.manifests["setup.cfg"] ?? ""}`).where,
  ];
  for (const unit of ["", ...units.keys()]) {
    const own = ownSource.get(unit) ?? [];
    if (!(units.size === 0 || own.length > SPLIT_MIN_FILES)) continue;
    for (const part of splitUnit(unit, own, unit ? units.get(unit)!.where : rootWhere)) {
      if (candidates.has(part.root)) continue;
      candidates.set(part.root, part);
      for (const inner of splitPart(part, own)) if (!candidates.has(inner.root)) candidates.set(inner.root, inner);
    }
  }

  // 3. Groups: `services/` and `libs/` when the units sort into several such folders.
  const topUnits = [...units.keys()].filter((root) => !unitRoots.some((other) => other !== root && isUnder(root, other)));
  const groupDirs = new Map<string, number>();
  for (const root of topUnits) if (depthOf(root) >= 2) groupDirs.set(dirOf(root), (groupDirs.get(dirOf(root)) ?? 0) + 1);
  if (groupDirs.size >= 2) {
    for (const [dir, members] of groupDirs) {
      if (members < 2 || candidates.has(dir)) continue;
      candidates.set(dir, { root: dir, name: "", description: "", source: "group", reason: `Folder holding ${members} modules`, unit: false });
    }
  }

  // 4. The tree, by directory; what nests too deep or is one folder too many goes.
  const build = (): { nodes: Map<string, Node>; top: Node[] } => {
    const nodes = new Map<string, Node>();
    const roots = [...candidates.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));
    const top: Node[] = [];
    for (const root of roots) {
      let parent: Node | null = null;
      for (let d = dirOf(root); d; d = dirOf(d)) {
        const found = nodes.get(d);
        if (found) {
          parent = found;
          break;
        }
      }
      const node: Node = {
        ...candidates.get(root)!,
        id: root,
        parent,
        children: [],
        depth: parent ? parent.depth + 1 : 1,
        owned: { source: [], tests: [], rest: [] },
        bytes: 0,
        languages: new Map(),
      };
      nodes.set(root, node);
      (parent ? parent.children : top).push(node);
    }
    return { nodes, top };
  };
  let tree = build();
  for (;;) {
    const all = [...tree.nodes.values()];
    const deepest = Math.max(0, ...all.map((n) => n.depth));
    if (deepest <= MAX_FOLDER_DEPTH && all.length <= MAX_FOLDERS) break;
    if (deepest <= 1) break;
    if (deepest <= MAX_FOLDER_DEPTH) truncated = true;
    for (const n of all) if (n.depth === deepest) candidates.delete(n.root);
    tree = build();
  }

  // 5. Every file to the deepest folder that holds it; tests then follow the code they mirror.
  const general: Node = {
    root: "",
    name: tree.nodes.size === 0 ? snapshot.name : "General",
    description: "",
    source: "root",
    reason: tree.nodes.size === 0 ? "The whole project" : "Files at the top of the project, outside the other folders",
    unit: false,
    id: ROOT_ID,
    parent: null,
    children: [],
    depth: 1,
    owned: { source: [], tests: [], rest: [] },
    bytes: 0,
    languages: new Map(),
  };
  const nodeRoots = [...tree.nodes.keys()].sort((a, b) => b.length - a.length);
  const others = new Map<string, number>();
  const languages = new Map<Language, number>();
  let sourceFiles = 0;
  for (const f of files) {
    if (f.language === null) {
      const ext = baseOf(f.path).includes(".") ? baseOf(f.path).slice(baseOf(f.path).lastIndexOf(".") + 1).toLowerCase() : "";
      const other = OTHER_BY_EXT[ext];
      if (other) others.set(other, (others.get(other) ?? 0) + 1);
    } else {
      sourceFiles++;
      languages.set(f.language, (languages.get(f.language) ?? 0) + 1);
    }
    const root = nodeRoots.find((r) => isUnder(f.path, r));
    let node = root === undefined ? general : tree.nodes.get(root)!;
    if (f.test && f.language !== null) {
      // From the unit the test sits in — or the project's top — down to the part it mirrors.
      let from = node === general ? "" : node.root;
      let children = node === general ? tree.top : node.children;
      for (;;) {
        const child = mirroredChild(f.path, from, children);
        if (!child) break;
        node = child;
        from = child.root;
        children = child.children;
      }
    }
    if (f.language === null) node.owned.rest.push(f.path);
    else {
      (f.test ? node.owned.tests : node.owned.source).push(f.path);
      node.bytes += f.size;
      node.languages.set(f.language, (node.languages.get(f.language) ?? 0) + 1);
    }
  }

  // 6. The project's top gets a folder when it holds code of its own — or is all there is.
  const top = [...tree.top];
  if (tree.nodes.size === 0 || general.owned.source.length >= MIN_GENERAL_FILES) {
    if (tree.nodes.size > 0) general.minor = true;
    top.push(general);
  }

  // 7. Names, spec folders, ticks.
  const byCount = <K extends string>(counts: Map<K, number>): K[] =>
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const owned = new Map<string, ModuleFiles>();
  const view = (node: Node, parentFolder: string, taken: Set<string>): ProposedFolder => {
    const name = displayName(node.name || baseOf(node.root)) || "Module";
    let slug = slugify(name) || "module";
    for (let n = 2; taken.has(slug); n++) slug = `${slugify(name) || "module"}-${n}`;
    taken.add(slug);
    const folder = joinPath(parentFolder, slug);
    const childSlugs = new Set<string>();
    const children = [...node.children].sort((a, b) => a.root.localeCompare(b.root)).map((c) => view(c, folder, childSlugs));
    owned.set(node.id, { source: node.owned.source.sort(), tests: node.owned.tests.sort(), rest: node.owned.rest.sort() });
    const files = node.owned.source.length;
    const empty = files === 0 && node.owned.tests.length === 0;
    const selected = children.length > 0
      ? children.some((c) => c.selected) || (!empty && !node.support)
      : !empty && !node.support && (!node.minor || files >= MIN_TICKED_FILES);
    return {
      id: node.id,
      folder,
      name,
      description: node.description,
      languages: byCount(node.languages),
      modules: [node.id],
      files,
      tests: node.owned.tests.length,
      bytes: node.bytes,
      source: node.source,
      reason: node.reason,
      selected,
      children,
    };
  };
  const topSlugs = new Set<string>();
  let folders = top
    .sort((a, b) => a.root.localeCompare(b.root))
    .filter((n) => n.children.length > 0 || n.owned.source.length + n.owned.tests.length > 0 || tree.nodes.size === 0)
    .map((n) => view(n, "", topSlugs));

  // 8. Still too many, all at one level: the smallest are proposed unticked.
  const flat = flattenFolders(folders);
  if (flat.length > MAX_FOLDERS) {
    truncated = true;
    const keep = new Set([...flat].sort((a, b) => b.files - a.files).slice(0, MAX_FOLDERS).map((f) => f.id));
    for (const f of flat) if (!keep.has(f.id) && f.children.length === 0) f.selected = false;
  }
  folders = folders.sort((a, b) => Number(a.id === ROOT_ID) - Number(b.id === ROOT_ID));

  return {
    proposal: {
      project: snapshot.name,
      languages: byCount(languages),
      folders,
      sourceFiles,
      skipped: [...others.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([what, n]) => ({ what, files: n })),
      truncated,
    },
    files: owned,
  };
}

/** Every folder of a proposal, parents before their children. */
export function flattenFolders(folders: readonly ProposedFolder[]): ProposedFolder[] {
  const out: ProposedFolder[] = [];
  const visit = (list: readonly ProposedFolder[]) => {
    for (const f of list) {
      out.push(f);
      visit(f.children);
    }
  };
  visit(folders);
  return out;
}

/** The folders to propose for a project's specifications. */
export function analyseModules(snapshot: RepoSnapshot): ModuleProposal {
  return analyse(snapshot).proposal;
}

/**
 * The files each proposed folder owns, by the folder's id — what its specs
 * are drafted from. The same analysis as analyseModules, so an id from one
 * names the same folder in the other while the project has not changed.
 */
export function moduleFiles(snapshot: RepoSnapshot): Map<string, ModuleFiles> {
  return analyse(snapshot).files;
}

// What a build file says about a project's modules (specs/app/extract-specs-
// from-code.feature.md): the readers the module analysis
// (src/server/intentModules.ts) asks, one per build tool. Each takes the
// file's text and answers with plain values; none touches the disk, and a
// file that does not parse answers with nothing rather than throwing — a
// broken build file must not stop the analysis of the rest.
//
// Only what the analysis needs is read. Maven's pom.xml, Gradle's settings
// file and Python's pyproject.toml are read with small text readers, not
// XML, Groovy or TOML parsers: the app ships none, and the few tags and
// keys asked for are regular enough.

import { parse as parseYaml } from "yaml";

/** A JSON object's text read, or null when it is not one. */
function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : [];

// --- JavaScript and TypeScript ---------------------------------------------------

export interface PackageJson {
  /** The package's name, its `@scope/` kept. */
  name: string;
  description: string;
  /** The `workspaces` globs — the array, or the `packages` of the object form. */
  workspaces: string[];
  /** The files the package names as its way in: `main`, `module`, `bin`, `exports`. */
  entries: string[];
}

/** The string values anywhere inside `exports` or `bin`. */
function leafStrings(value: unknown, into: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const v of value) leafStrings(v, into, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) leafStrings(v, into, depth + 1);
}

/** A package.json's name, description, workspaces and entry files. */
export function readPackageJson(text: string): PackageJson | null {
  const pkg = jsonObject(text);
  if (!pkg) return null;
  const ws = pkg.workspaces;
  const workspaces = Array.isArray(ws)
    ? strings(ws)
    : ws && typeof ws === "object"
      ? strings((ws as { packages?: unknown }).packages)
      : [];
  const entries: string[] = [];
  for (const key of ["main", "module", "browser", "bin", "exports"]) leafStrings(pkg[key], entries);
  return {
    name: typeof pkg.name === "string" ? pkg.name.trim() : "",
    description: typeof pkg.description === "string" ? pkg.description.trim() : "",
    workspaces,
    entries: [...new Set(entries.map((e) => e.replace(/^\.\//, "")).filter((e) => e && !e.includes("*")))],
  };
}

/** The `packages` globs of a pnpm-workspace.yaml. */
export function readPnpmWorkspace(text: string): string[] {
  try {
    const doc = parseYaml(text) as { packages?: unknown } | null;
    return strings(doc?.packages);
  } catch {
    return [];
  }
}

/** The `packages` globs of a lerna.json — Lerna's own default when it names none. */
export function readLernaJson(text: string): string[] {
  const doc = jsonObject(text);
  if (!doc) return [];
  const packages = strings(doc.packages);
  return packages.length > 0 ? packages : ["packages/*"];
}

/**
 * JSON with comments and trailing commas, as tsconfig.json allows, made
 * plain JSON: line and block comments outside strings are dropped, and a
 * comma before a closing bracket goes.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The `references[].path` values of a tsconfig.json: the projects it is built from. */
export function readTsconfigReferences(text: string): string[] {
  const doc = jsonObject(stripJsonComments(text));
  if (!doc || !Array.isArray(doc.references)) return [];
  return doc.references
    .map((r) => (r && typeof r === "object" ? (r as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map((p) => p.trim());
}

/**
 * Whether a workspace glob names `dir`, both relative to the workspace's
 * root: `*` is one path segment, `**` any number of them, anything else
 * itself. A trailing slash and a leading `./` do not matter.
 */
export function globMatches(pattern: string, dir: string): boolean {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean) return false;
  const source = clean
    .split("/")
    .map((segment) =>
      segment === "**"
        ? "(?:[^/]+/)*[^/]+"
        : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"),
    )
    .join("/");
  return new RegExp(`^${source}$`).test(dir);
}

/**
 * The directories a list of workspace globs names, out of `candidates`
 * (each relative to the workspace's root). A `!glob` takes directories back
 * out, wherever it stands in the list.
 */
export function matchWorkspaceGlobs(patterns: readonly string[], candidates: readonly string[]): string[] {
  const include = patterns.filter((p) => !p.startsWith("!"));
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  return candidates.filter(
    (dir) => include.some((p) => globMatches(p, dir)) && !exclude.some((p) => globMatches(p, dir)),
  );
}

// --- Java: Maven and Gradle --------------------------------------------------------

export interface PomInfo {
  artifactId: string;
  /** The `<name>`, when it is plain text and not a `${property}`. */
  name: string;
  description: string;
  /** `pom` for a parent that only gathers modules. */
  packaging: string;
  /** Every `<module>`, the ones inside profiles too, as written. */
  modules: string[];
}

const xmlText = (raw: string): string =>
  raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** The text of the first `<tag>` in `xml`, or "". */
function firstTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? xmlText(m[1]!) : "";
}

/**
 * XML text without its comments. Comments are taken out again until none
 * is left — taking one out can join the text around it into another, as
 * `<!<!-- x -->--` does — and one left open runs to the end.
 */
export function stripXmlComments(text: string): string {
  let out = text;
  for (let before = ""; out !== before; ) {
    before = out;
    out = out.replace(/<!--[\s\S]*?-->/g, "");
  }
  const open = out.indexOf("<!--");
  return open === -1 ? out : out.slice(0, open);
}

/**
 * A pom.xml's own coordinates and its modules. The blocks that carry other
 * projects' coordinates — the parent, the dependencies, the build's plugins
 * — are set aside before the artifact id and name are looked for, so the
 * first one found is the project's own.
 */
export function readPom(text: string): PomInfo {
  const xml = stripXmlComments(text);
  const modules = [...xml.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => xmlText(m[1]!)).filter(Boolean);
  let own = xml;
  for (const block of ["parent", "dependencyManagement", "dependencies", "build", "profiles", "reporting", "modules"]) {
    own = own.replace(new RegExp(`<${block}\\b[^>]*>[\\s\\S]*?</${block}>`, "g"), "");
  }
  const name = firstTag(own, "name");
  return {
    artifactId: firstTag(own, "artifactId"),
    name: name.includes("${") ? "" : name,
    description: firstTag(own, "description"),
    packaging: firstTag(own, "packaging"),
    modules: [...new Set(modules)],
  };
}

/** A Gradle settings file without its comments (strings are left whole). */
function stripGradleComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The project directories a settings.gradle or settings.gradle.kts includes,
 * relative to the settings file: `include ':a:b'` is `a/b`, `includeFlat
 * 'x'` is `../x`, and a `project(':a').projectDir = file('y')` moves `a` to
 * `y`. An include whose names are computed is not seen — the analysis then
 * falls back to the folders that hold a build file.
 */
export function readGradleSettings(text: string): string[] {
  const src = stripGradleComments(text);
  const dirs = new Map<string, string>();
  // An include statement runs to the end of its line, and on over lines that
  // end with a comma or sit inside its parentheses.
  const statement = /\b(include(?:Flat)?)\b\s*(\([^)]*\)|(?:[^\n]*,[ \t]*\n)*[^\n]*)/g;
  for (const m of src.matchAll(statement)) {
    const flat = m[1] === "includeFlat";
    for (const q of m[2]!.matchAll(/(['"])([^'"\n]+)\1/g)) {
      const name = q[2]!.trim();
      if (!name || name.includes("$")) continue;
      const path = name.replace(/^:+/, "").split(":").filter(Boolean).join("/");
      if (!path) continue;
      dirs.set(`:${path.split("/").join(":")}`, flat ? `../${path}` : path);
    }
  }
  const moved =
    /project\(\s*(['"])(:[^'"\n]+)\1\s*\)\s*\.\s*projectDir\s*=\s*(?:new\s+)?[Ff]ile\s*\(\s*(?:(?:settingsDir|rootDir|rootProject\.projectDir)\s*,\s*)?(['"])([^'"\n]+)\3/g;
  for (const m of src.matchAll(moved)) {
    if (dirs.has(m[2]!)) dirs.set(m[2]!, m[4]!.trim());
  }
  return [...new Set(dirs.values())];
}

// --- Python ----------------------------------------------------------------------------

/** A TOML file's tables, each key's value kept as written (quotes, brackets and all). */
export type TomlTables = Map<string, Map<string, string>>;

/** A line with what follows an unquoted `#` cut off. */
function withoutTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** How many more `[` or `{` than `]` or `}` a value has outside its strings. */
function openBrackets(value: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return depth;
}

/**
 * A TOML file read into its tables — `[a.b]` headers, and `[[a.b]]` ones
 * under the same name — each holding its `key = value` lines, an array or
 * inline table gathered over the lines it spans. Values stay text:
 * tomlString and tomlStrings pull the quoted strings out.
 */
export function readToml(text: string): TomlTables {
  const tables: TomlTables = new Map();
  let current = new Map<string, string>();
  tables.set("", current);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = withoutTomlComment(lines[i]!).trim();
    if (!line) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header && !line.includes("=")) {
      const name = header[1]!.replace(/["']/g, "").replace(/\s*\.\s*/g, ".");
      current = tables.get(name) ?? new Map();
      tables.set(name, current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    let value = line.slice(eq + 1).trim();
    while (openBrackets(value) > 0 && i + 1 < lines.length) {
      i++;
      value += ` ${withoutTomlComment(lines[i]!).trim()}`;
    }
    if (key) current.set(key, value);
  }
  return tables;
}

/** Every quoted string in a TOML value, in order. */
export function tomlStrings(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] ?? m[2] ?? "").trim()).filter(Boolean);
}

/** A TOML value that is one string, or "". */
function tomlString(value: string | undefined): string {
  return value && /^["']/.test(value.trim()) ? (tomlStrings(value)[0] ?? "") : "";
}

export interface PyProject {
  name: string;
  description: string;
  /** Folders the packages are looked for in — `src` for a src layout. */
  where: string[];
  /** uv workspace members: globs of project folders. */
  members: string[];
}

/** A pyproject.toml's project name, where its packages live, and its workspace members. */
export function readPyProject(text: string): PyProject {
  const toml = readToml(text);
  const table = (name: string) => toml.get(name) ?? new Map<string, string>();
  const project = table("project");
  const poetry = table("tool.poetry");
  const where = new Set<string>(tomlStrings(table("tool.setuptools.packages.find").get("where")));
  // Poetry's `packages = [{ include = "app", from = "src" }]`.
  for (const m of (poetry.get("packages") ?? "").matchAll(/from\s*=\s*["']([^"']+)["']/g)) where.add(m[1]!);
  // setuptools' `package-dir = {"" = "src"}`.
  const packageDir = /["']{2}\s*=\s*["']([^"']+)["']/.exec(table("tool.setuptools").get("package-dir") ?? "");
  if (packageDir) where.add(packageDir[1]!);
  return {
    name: tomlString(project.get("name")) || tomlString(poetry.get("name")),
    description: tomlString(project.get("description")) || tomlString(poetry.get("description")),
    where: [...where].map((w) => w.replace(/^\.\//, "").replace(/\/+$/, "")).filter((w) => w && w !== "."),
    members: tomlStrings(table("tool.uv.workspace").get("members")),
  };
}

/**
 * What a setup.py or setup.cfg says about where the packages live: the
 * `package_dir={"": "src"}` folder and a `find_packages(where="src")`, and
 * the project's name.
 */
export function readSetupPy(text: string): { name: string; where: string[] } {
  const where = new Set<string>();
  const dir = /package_dir\s*=\s*\{\s*["']{2}\s*:\s*["']([^"']+)["']/.exec(text);
  if (dir) where.add(dir[1]!);
  for (const m of text.matchAll(/find(?:_namespace)?_packages\(\s*(?:where\s*=\s*)?["']([^"']+)["']/g)) where.add(m[1]!);
  // setup.cfg: `package_dir =\n    = src` and `[options.packages.find] where = src`.
  const cfgDir = /^package_dir\s*=\s*\n\s*=\s*(\S+)/m.exec(text);
  if (cfgDir) where.add(cfgDir[1]!);
  const cfgWhere = /^\s*where\s*=\s*([^\s"'#]+)\s*$/m.exec(text);
  if (cfgWhere) where.add(cfgWhere[1]!);
  const name = /\bname\s*=\s*["']([^"']+)["']/.exec(text) ?? /^name\s*=\s*([^\s#]+)\s*$/m.exec(text);
  return {
    name: name ? name[1]!.trim() : "",
    where: [...where].map((w) => w.replace(/^\.\//, "").replace(/\/+$/, "")).filter((w) => w && w !== "."),
  };
}

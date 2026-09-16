// Data entities in the code repo (specs/editor/data-model-integration-in-
// editor.feature.md): the classes a project's code declares, and their
// fields, so the scenario editor can offer `@firstName` — or
// `@User.firstName` when two entities share a field name — as the user
// types. Two layouts are read: plain Java classes and records (any
// non-test class with instance fields is a POJO here — no annotation is
// required), and SAP CDS entities (`entity Customers { key ID : UUID; … }`,
// projections included).
//
// Both parsers are deliberately shallow: comments and strings are blanked,
// annotations dropped, and the rest read by brace depth. They aim to be
// right about field *names*, which is all the editor needs, and to never
// throw on odd input. Known gaps, on purpose: a CDS `*` in a projection is
// not expanded (that would need cross-file resolution — the base entity's
// own fields are offered under its own name); CDS `type`, `aspect`,
// `annotate`, `extend`, actions, functions and events contribute nothing;
// Java interfaces and enums contribute nothing.
//
// The scan walks the whole code repo (skipping build output and hidden
// folders), so its result is cached per repo behind a stat fingerprint of
// the source files it read — the same change detector the search index
// uses (src/server/search.ts): any edit, add or delete forces a re-parse,
// and an unchanged tree costs one stat per file.

import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";
import { readTextFile } from "./fsx";

export interface Entity {
  /** The simple class, record or entity name — `Customer`, not `db.Customer`. */
  name: string;
  /** Repo-relative path of the file declaring it. */
  file: string;
  language: "java" | "cds";
  /** Field names, in declaration order, each once. */
  fields: string[];
}

/** One row the editor offers: what it shows, what it inserts, and where it came from. */
export interface FieldChoice {
  /** `@firstName`, or `@User.firstName` when another entity has a `firstName` too. */
  label: string;
  /** The text that replaces the `@…` the user typed — the label, today. */
  insert: string;
  entity: string;
  field: string;
  file: string;
}

// ---------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------

/** Replace every character of `s` except newlines with a space: the text keeps its shape. */
function spaces(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/**
 * Blank comments and string literals. Nothing shifts — every replaced run
 * keeps its length and its newlines — so no field is mistaken for one that
 * lives in a string, and no `;` or `}` in a comment closes a block.
 */
function blankJava(source: string): string {
  return source.replace(
    /"""[\s\S]*?"""|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g,
    spaces,
  );
}

/**
 * As blankJava, for CDS: comments go, and each single-quoted string becomes
 * an empty one — `''` rather than spaces, so an annotation's value stays
 * one token (`@title: ''`) and is dropped whole with the annotation.
 * `![quoted identifiers]` survive.
 */
function blankCds(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, spaces)
    .replace(/'(?:''|[^'\n])*'/g, "''");
}

/** Drop Java annotations, with one level of nested parentheses in their arguments. */
function stripJavaAnnotations(source: string): string {
  return source.replace(/@[A-Za-z_$][\w$.]*(?:\s*\((?:[^()]|\([^()]*\))*\))?/g, spaces);
}

/** Drop CDS annotations: `@(A: 1, B)` and `@name`, `@name: value`, `@name: { … }`, `@name: [ … ]`. */
function stripCdsAnnotations(source: string): string {
  return source
    .replace(/@\(\s*(?:[^()]|\([^()]*\))*\)/g, spaces)
    .replace(/@[A-Za-z_][\w.]*(?:\s*:\s*(?:\{[^}]*\}|\[[^\]]*\]|[\w.'-]+))?/g, spaces);
}

/** The index of the `}` closing the `{` at `open`, or -1 when it never closes. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Split on a separator at nesting depth zero (`<>`, `()`, `[]`, `{}` all nest). */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "<" || c === "(" || c === "[" || c === "{") depth++;
    else if (c === ">" || c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function unique(names: string[]): string[] {
  return Array.from(new Set(names));
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_TYPED_BLOCK = /\b(class|record|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const JAVA_MODIFIERS = /^(?:(?:public|protected|private|final|transient|volatile)\s+)+/;
const JAVA_KEYWORD_TYPES = new Set([
  "return",
  "throw",
  "new",
  "assert",
  "break",
  "continue",
  "case",
  "import",
  "package",
  "yield",
  "goto",
  "do",
  "else",
]);
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Files whose classes are tests or fixtures, never a data model. */
function javaTestFile(fileName: string): boolean {
  return /(^|\/)(src\/test|src\/integrationTest|src\/testFixtures|test|tests)\//.test(fileName);
}

/**
 * The field names one class-body statement declares, or none when it is a
 * method, constant, or anything else. `Type a, b = 1, c[]` gives a, b, c.
 */
function javaFieldsOf(statement: string): string[] {
  const s = statement.trim();
  if (!s || /\bstatic\b/.test(s)) return [];
  const head = splitTop(s, "=")[0]!;
  if (head.includes("(")) return []; // abstract/native method, or a throws clause
  const body = s.replace(JAVA_MODIFIERS, "");
  const declarators = splitTop(body, ",");
  const first = declarators[0]!.trim();
  // `Type name`, `Type[] name`, `Type name[]`, `Map<K, V> name`: the name is
  // the last identifier of the head, the type everything before it.
  const firstHead = splitTop(first, "=")[0]!.trim();
  const m = /^([\s\S]*?)\s*([A-Za-z_$][\w$]*)\s*(?:\[\s*\]\s*)*$/.exec(firstHead);
  if (!m) return [];
  const type = m[1]!.trim();
  const typeToken = /^[A-Za-z_$][\w$.]*/.exec(type)?.[0];
  if (!typeToken || JAVA_KEYWORD_TYPES.has(typeToken)) return [];
  if (!/^[A-Za-z_$][\w$.]*(?:\s*<[\s\S]*>)?(?:\s*\[\s*\])*$/.test(type)) return [];
  const names = [m[2]!];
  for (const later of declarators.slice(1)) {
    const laterHead = splitTop(later, "=")[0]!.trim();
    const n = /^([A-Za-z_$][\w$]*)\s*(?:\[\s*\]\s*)*$/.exec(laterHead);
    if (n) names.push(n[1]!);
  }
  return names;
}

/** The component names of a record header's `(…)`, which starts at `open`. */
function recordComponents(text: string, open: number): { fields: string[]; end: number } {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) {
      const list = text.slice(open + 1, i);
      const fields: string[] = [];
      for (const piece of splitTop(list, ",")) {
        const p = piece.replace(/\.\.\./g, " ").trim();
        const m = /([A-Za-z_$][\w$]*)\s*$/.exec(p);
        if (m && p.includes(" ") && IDENT.test(m[1]!)) fields.push(m[1]!);
      }
      return { fields, end: i };
    }
  }
  return { fields: [], end: text.length };
}

interface JavaBlock {
  kind: "class" | "record" | "interface" | "enum" | "other";
  name: string;
  depth: number;
  fields: string[];
}

/**
 * The entities a Java source file declares: every class or record (nested
 * ones too) with at least one instance field. A test file, or a class
 * named like a test, declares none.
 */
export function parseJavaEntities(source: string, fileName: string): Entity[] {
  if (javaTestFile(fileName) || /(^|\/)(package-info|module-info)\.java$/.test(fileName)) return [];
  const text = stripJavaAnnotations(blankJava(source));
  const entities: Entity[] = [];
  const stack: JavaBlock[] = [];
  let depth = 0;
  let buffer = ""; // the statement or block header being read
  const top = () => stack[stack.length - 1];
  const close = (block: JavaBlock) => {
    if ((block.kind === "class" || block.kind === "record") && block.fields.length > 0) {
      if (!/Tests?$/.test(block.name)) {
        entities.push({ name: block.name, file: fileName, language: "java", fields: unique(block.fields) });
      }
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      const header = buffer;
      const typed = JAVA_TYPED_BLOCK.exec(header);
      const inClassBody = top()?.kind === "class" || top()?.kind === "record";
      if (inClassBody && splitTop(header, "=").length > 1) {
        // An initializer's anonymous class, array initializer or lambda body:
        // skip the block, keep the statement so the field still counts.
        const end = closingBrace(text, i);
        if (end < 0) break;
        buffer = `${header} {}`;
        i = end;
        continue;
      } else if (typed) {
        const kind = typed[1] as JavaBlock["kind"];
        const block: JavaBlock = { kind, name: typed[2]!, depth, fields: [] };
        if (kind === "record") {
          const open = header.indexOf("(", typed.index);
          if (open >= 0) block.fields.push(...recordComponents(header, open).fields);
        }
        stack.push(block);
        buffer = "";
      } else {
        stack.push({ kind: "other", name: "", depth, fields: [] });
        buffer = "";
      }
      depth++;
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      const block = top();
      if (block && block.depth === depth) {
        stack.pop();
        close(block);
      }
      buffer = "";
    } else if (c === ";") {
      const block = top();
      if (block && (block.kind === "class" || block.kind === "record") && depth === block.depth + 1) {
        block.fields.push(...javaFieldsOf(buffer));
      }
      buffer = "";
    } else {
      buffer += c;
    }
  }
  return entities;
}

// ---------------------------------------------------------------------------
// CDS
// ---------------------------------------------------------------------------

const CDS_ENTITY_HEADER =
  /\b(?:define\s+)?(?:abstract\s+)?entity\s+(!\[[^\]]+\]|[A-Za-z_][\w.]*)((?:\s*:\s*[^{;]+?)?)\s*(as\s+(?:projection\s+on|select\s+(?:distinct\s+)?from)\s+[^{;]+?)?\s*([{;])/g;

/** The name a `![quoted]` or plain identifier carries. */
function cdsName(quoted: string | undefined, plain: string | undefined): string | null {
  if (quoted) return quoted;
  if (plain) return plain;
  return null;
}

/** Words that open a block inside an entity body without declaring an element. */
const CDS_BODY_KEYWORDS = new Set(["actions", "extend", "annotate", "excluding"]);

/** Element names of a definition body: each `;`-statement's leading identifier. */
function cdsDefinitionFields(body: string): string[] {
  const fields: string[] = [];
  for (const statement of splitTop(body, ";")) {
    const m = /^\s*(?:(?:key|virtual|masked|localized)\s+)*(?:!\[([^\]]+)\]|([A-Za-z_]\w*))\s*[:{]/.exec(statement);
    const name = m ? cdsName(m[1], m[2]) : null;
    if (name && !(m![2] && CDS_BODY_KEYWORDS.has(name))) fields.push(name);
  }
  return fields;
}

/** Element names of a projection or select column list. */
function cdsProjectionFields(body: string): string[] {
  const fields: string[] = [];
  for (const item of splitTop(body, ",")) {
    const s = item.trim();
    if (!s || s === "*") continue;
    const alias = /\bas\s+(?:!\[([^\]]+)\]|([A-Za-z_]\w*))\s*$/.exec(s);
    if (alias) {
      const name = cdsName(alias[1], alias[2]);
      if (name) fields.push(name);
      continue;
    }
    const brace = s.indexOf("{");
    if (brace >= 0) {
      // An expansion `author { name }` or inline `addr { street }` keeps the path's name.
      const head = s.slice(0, brace).trim().replace(/^key\s+/, "");
      const m = /(?:!\[([^\]]+)\]|([A-Za-z_][\w.]*))\s*$/.exec(head);
      const name = m ? cdsName(m[1], m[2]) : null;
      if (name) fields.push(name.split(".").pop()!);
      continue;
    }
    const plain = /^(?:key\s+)?(?:!\[([^\]]+)\]|([A-Za-z_][\w.]*))$/.exec(s);
    if (plain) {
      const name = cdsName(plain[1], plain[2]);
      // A path without an alias becomes CDS's default `a_b`.
      if (name) fields.push(name.replace(/\./g, "_"));
    }
    // Anything else — an expression, a function call — has no name without an alias.
  }
  return fields;
}

/**
 * The entities a CDS source file declares, projections included, each with
 * its element names. Namespaces and services only prefix the name; the
 * simple name is what a scenario would mention.
 */
export function parseCdsEntities(source: string, fileName: string): Entity[] {
  const text = stripCdsAnnotations(blankCds(source));
  const entities: Entity[] = [];
  CDS_ENTITY_HEADER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CDS_ENTITY_HEADER.exec(text)) !== null) {
    const rawName = m[1]!;
    const name = (rawName.startsWith("![") ? rawName.slice(2, -1) : rawName).split(".").pop()!;
    if (m[4] === ";") continue; // no element list
    if (m[3] && /\bexcluding\s*$/.test(m[3])) continue; // `{` opens the exclusions, not columns
    const open = m.index + m[0].length - 1;
    const end = closingBrace(text, open);
    if (end < 0) break;
    const body = text.slice(open + 1, end);
    const fields = unique(m[3] ? cdsProjectionFields(body) : cdsDefinitionFields(body));
    if (fields.length > 0) entities.push({ name, file: fileName, language: "cds", fields });
    CDS_ENTITY_HEADER.lastIndex = end + 1;
  }
  return entities;
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

/**
 * The rows the editor offers, sorted by label: `@field` where the name is
 * unique across entities, `@Entity.field` for each entity that shares a
 * field name with another (specs/editor/data-model-integration-in-
 * editor.feature.md). Two entities with the same name and field — a Java
 * class beside the CDS entity it maps — give one row.
 */
export function fieldChoices(entities: Entity[]): FieldChoice[] {
  const owners = new Map<string, number>();
  for (const e of entities) {
    for (const f of unique(e.fields)) owners.set(f, (owners.get(f) ?? 0) + 1);
  }
  const byLabel = new Map<string, FieldChoice>();
  for (const e of entities) {
    for (const f of unique(e.fields)) {
      const label = (owners.get(f) ?? 0) > 1 ? `@${e.name}.${f}` : `@${f}`;
      if (!byLabel.has(label)) byLabel.set(label, { label, insert: label, entity: e.name, field: f, file: e.file });
    }
  }
  // Alphabetical regardless of case, so `@amount` sits by `@Claim.email`, not after every capital.
  return Array.from(byLabel.values()).sort((a, b) => a.label.localeCompare(b.label, "en"));
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Folders with no source of their own: build output, dependencies, and anything hidden. */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  "gen",
  "bin",
  "coverage",
  "_out",
  "vendor",
]);
/** Enough for any real project; past this the walk stops rather than crawl a monorepo forever. */
const MAX_FILES = 5000;
/** A source file this large is generated; it is not a data model anyone types against. */
const MAX_FILE_BYTES = 512 * 1024;

function entityFile(name: string): boolean {
  return name.endsWith(".java") || name.endsWith(".cds");
}

/** Repo-relative paths of every `.java` and `.cds` file, forward-slashed. */
async function walkCode(root: string, rel: string, files: string[]): Promise<void> {
  if (files.length >= MAX_FILES) return;
  let entries: Dirent[];
  try {
    entries = await readdir(rel ? `${root}/${rel}` : root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walkCode(root, path, files);
    else if (entry.isFile() && entityFile(entry.name)) files.push(path);
  }
}

const cache = new Map<string, { fingerprint: string; entities: Entity[] }>();

/** Test hook: drop cached scans so a fresh fixture starts clean. */
export function resetEntitiesCache(): void {
  cache.clear();
}

/**
 * The entities declared under `codeRepo`. Cached per repo behind a stat
 * fingerprint of the source files (one stat each, no reads), so an
 * unchanged tree is never parsed twice. A missing repo scans as empty.
 */
export async function scanEntities(codeRepo: string): Promise<Entity[]> {
  const root = resolve(codeRepo);
  const files: string[] = [];
  await walkCode(root, "", files);
  const sizes = new Map<string, number>();
  const parts = await Promise.all(
    files.map(async (f) => {
      try {
        const s = await stat(`${root}/${f}`);
        sizes.set(f, s.size);
        return `${f}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${f}:gone`;
      }
    }),
  );
  const fingerprint = parts.sort().join("|");
  const hit = cache.get(root);
  if (hit && hit.fingerprint === fingerprint) return hit.entities;
  const entities: Entity[] = [];
  for (const f of files) {
    if ((sizes.get(f) ?? 0) > MAX_FILE_BYTES) continue;
    const text = await readTextFile(`${root}/${f}`);
    if (text === null) continue; // deleted between walk and read
    try {
      entities.push(...(f.endsWith(".cds") ? parseCdsEntities(text, f) : parseJavaEntities(text, f)));
    } catch {
      // A file the parser chokes on is left out, never fatal.
    }
  }
  cache.set(root, { fingerprint, entities });
  return entities;
}

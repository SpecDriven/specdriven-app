// Custom attribute definitions (specs/app/custom-attributes.feature.md): the
// data repo's `custom-attributes.txt`, where a team says which attributes its
// features and scenarios carry. Pure — the frontend imports it to check the
// file as it is typed, label chips and drive the attribute editor.
//
// The DSL is pattern-first: the usage is the definition, written the way the
// attribute is written in a feature file, then indented properties.
//
//   # Comments are whole lines.
//   [br:<rule>:on|off|<value>]
//     label: Business rule
//     scope: feature, scenario
//     description: A business rule the spec depends on
//
//   [br-sub:<rule from br>:<sub-rule>:on|off|<value>]
//     label: Business sub-rule
//
// A pattern starts in column 1: `[`, the key, then `:`-separated parts, `]`.
// The last part is the value, the ones before it the names. A part is
// alternatives split by `|`: a word, matched exactly, or at most one slot —
// `<name>` takes any segment, `<name:number>` a number, and `<name from k>`
// the first segment of some `[k:…]` attribute used anywhere in the data
// repo. Properties default: `label` to the key, `scope` to both.
//
// Loading never throws: every problem is a diagnostic with a line and a
// column. A definition whose pattern has a problem is left out, a bad
// property is ignored and the rest of its definition still applies, and a
// second definition of a key is left out.
//
// The definitions never change how a file parses (src/server/parser.ts
// parseMetadataTokens): they only label, check, suggest and filter.

import { isAttributeSegment, type SpecAttribute } from "./parser";

export const CUSTOM_ATTRIBUTES_FILE = "custom-attributes.txt";

export type AttributeScope = "feature" | "scenario";

export interface AttributeSlot {
  /** What the slot stands for, shown as the input's placeholder: "rule". */
  name: string;
  type: "text" | "number";
  /** A key whose attributes' first segments the slot must name. */
  from?: string;
}

/** One `:`-separated part of a pattern: its fixed words and its slot, if any. */
export interface AttributePart {
  words: string[];
  slot?: AttributeSlot;
}

export interface AttributeDefinition {
  key: string;
  /** The pattern as written, for messages and the summary. */
  pattern: string;
  /** The parts before the value: one per name. */
  names: AttributePart[];
  value: AttributePart;
  label: string;
  scope: AttributeScope[];
  description?: string;
  /** The 1-based line the pattern is on. */
  line: number;
}

export interface AttributeDiagnostic {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  message: string;
}

export interface AttributeDefinitions {
  list: AttributeDefinition[];
  byKey: Map<string, AttributeDefinition>;
  diagnostics: AttributeDiagnostic[];
}

/**
 * Keys a definition may not take: `ff` is a feature flag, `test`, `http` and
 * `https` are never attributes (parser.ts), and the status words read as a
 * scenario's status chip.
 */
export const RESERVED_ATTRIBUTE_KEYS = [
  "ff",
  "test",
  "http",
  "https",
  "draft",
  "proposed",
  "published",
  "saved",
] as const;

const KEY_RE = /^[a-z][a-z0-9._-]*$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const PROPERTIES = ["label", "scope", "description"] as const;
const SCOPES: AttributeScope[] = ["feature", "scenario"];

/** The file a team starts from: business rules and their sub-rules. */
export const EXAMPLE_ATTRIBUTE_DEFINITIONS = `# Custom attributes for features and scenarios.
#   <name>          a part you fill in
#   on|off|<value>  alternatives: a fixed word, or a part you fill in
#   <rule from br>  must name a rule already used in a [br:…] attribute
[br:<rule>:on|off|<value>]
  label: Business rule
  scope: feature, scenario
  description: A business rule the spec depends on

[br-sub:<rule from br>:<sub-rule>:on|off|<value>]
  label: Business sub-rule
  scope: feature, scenario
`;

class PatternError extends Error {
  constructor(
    message: string,
    readonly column: number,
  ) {
    super(message);
  }
}

/** Read a slot's inside — `rule`, `n:number`, `rule from br` — starting at `column`. */
function parseSlot(inside: string, column: number): AttributeSlot {
  let rest = inside;
  let from: string | undefined;
  const at = rest.indexOf(" from ");
  if (at !== -1) {
    from = rest.slice(at + " from ".length).trim();
    rest = rest.slice(0, at);
    if (!KEY_RE.test(from)) {
      throw new PatternError(`"${from}" is not a key a slot can refer to`, column + at + 6);
    }
  }
  let type: AttributeSlot["type"] = "text";
  let typed = false;
  const colon = rest.indexOf(":");
  if (colon !== -1) {
    const word = rest.slice(colon + 1).trim();
    if (word !== "text" && word !== "number") {
      throw new PatternError(`Unknown type "${word}" — expected text or number`, column + colon + 1);
    }
    type = word;
    typed = true;
    rest = rest.slice(0, colon);
  }
  const name = rest.trim();
  if (!name) throw new PatternError("A slot needs a name, like <rule>", column);
  if (/[[\]|<>]/.test(name)) throw new PatternError(`"${name}" is not a slot name`, column);
  if (typed && from) throw new PatternError("A slot takes a type or a from, not both", column);
  return { name, type, ...(from ? { from } : {}) };
}

/** Read one part, `on|off|<value>`, from `text` (its columns start at `column`). */
function parsePart(text: string, column: number): AttributePart {
  if (text === "") throw new PatternError("Empty part — expected a word or a <slot>", column);
  const words: string[] = [];
  let slot: AttributeSlot | undefined;
  let at = 0;
  for (const choice of splitTop(text, "|")) {
    const col = column + at;
    at += choice.length + 1;
    if (choice === "") throw new PatternError("Empty alternative — remove the extra |", col);
    if (choice.startsWith("<")) {
      if (!choice.endsWith(">")) throw new PatternError("A slot ends with >", col);
      if (slot) throw new PatternError("A part takes at most one <slot>", col);
      slot = parseSlot(choice.slice(1, -1), col + 1);
    } else if (/[<>]/.test(choice) || !isAttributeSegment(choice)) {
      throw new PatternError(
        `"${choice}" is not a word an attribute can hold — no [ ] : | < >, and no space at either end`,
        col,
      );
    } else if (!words.includes(choice)) {
      words.push(choice);
    }
  }
  return { words, ...(slot ? { slot } : {}) };
}

/** Split on `sep` outside `<…>`. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "<") depth++;
    else if (c === ">") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Read a pattern line, `[key:part:…]`, into its key and parts. */
function parsePattern(line: string): { key: string; parts: AttributePart[] } {
  // The closing bracket: the first `]` outside a slot.
  let close = -1;
  let depth = 0;
  for (let i = 1; i < line.length; i++) {
    const c = line[i];
    if (c === "<") depth++;
    else if (c === ">") depth = Math.max(0, depth - 1);
    else if (c === "]" && depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) throw new PatternError("The pattern has no closing ]", line.length + 1);
  const after = line.slice(close + 1);
  if (after.trim() !== "") {
    throw new PatternError("Nothing may follow the pattern on its line", close + 2 + (after.length - after.trimStart().length));
  }
  const inner = line.slice(1, close);
  const pieces = splitTop(inner, ":");
  const key = pieces[0]!;
  if (!KEY_RE.test(key)) {
    throw new PatternError(
      key === ""
        ? "The pattern needs a key, like [br:…]"
        : `"${key}" is not a key — start with a lower-case letter and use only a-z, 0-9, . _ and -`,
      2,
    );
  }
  if ((RESERVED_ATTRIBUTE_KEYS as readonly string[]).includes(key)) {
    throw new PatternError(
      key === "ff" ? `"ff" is reserved for feature flags` : `"${key}" is reserved and cannot be a key`,
      2,
    );
  }
  if (pieces.length < 2) throw new PatternError("The pattern needs a value after the key, like [line:<value>]", close + 1);
  const parts: AttributePart[] = [];
  let column = 2 + key.length + 1;
  for (const piece of pieces.slice(1)) {
    parts.push(parsePart(piece, column));
    column += piece.length + 1;
  }
  return { key, parts };
}

interface Draft {
  def: AttributeDefinition;
  /** Columns of each `from` reference, to point at it if it does not resolve. */
  refs: { from: string; column: number }[];
  seen: Set<string>;
}

/** Read `custom-attributes.txt`. Never throws. */
export function parseAttributeDefinitions(text: string): AttributeDefinitions {
  const diagnostics: AttributeDiagnostic[] = [];
  const drafts: Draft[] = [];
  /** The definition properties attach to; null after a pattern with a problem. */
  let current: Draft | null = null;
  /** Whether properties have a pattern above them at all. */
  let underPattern = false;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    const lineNo = i + 1;
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    if (line === trimmed) {
      // Column 1: a pattern.
      underPattern = true;
      current = null;
      if (!line.startsWith("[")) {
        diagnostics.push({
          line: lineNo,
          column: 1,
          message: "Expected a pattern like [key:<name>:on|off], or an indented property under one",
        });
        return;
      }
      try {
        const { key, parts } = parsePattern(line);
        const value = parts.at(-1)!;
        const refs = parts.flatMap((p, at) =>
          p.slot?.from ? [{ from: p.slot.from, column: columnOfPart(line, at) }] : [],
        );
        current = {
          def: { key, pattern: line, names: parts.slice(0, -1), value, label: key, scope: [...SCOPES], line: lineNo },
          refs,
          seen: new Set(),
        };
        drafts.push(current);
      } catch (e) {
        if (!(e instanceof PatternError)) throw e;
        diagnostics.push({ line: lineNo, column: e.column, message: e.message });
      }
      return;
    }
    // Indented: a property of the pattern above.
    const indent = line.length - trimmed.length;
    if (!underPattern) {
      diagnostics.push({
        line: lineNo,
        column: indent + 1,
        message: "A property belongs under a pattern — start the pattern in column 1",
      });
      return;
    }
    if (current === null) return; // its pattern was left out, and said so
    const draft: Draft = current;
    const colon = trimmed.indexOf(":");
    const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
    if (!(PROPERTIES as readonly string[]).includes(name)) {
      diagnostics.push({
        line: lineNo,
        column: indent + 1,
        message: `Unknown property "${name}" — expected label, scope or description`,
      });
      return;
    }
    if (colon === -1) {
      diagnostics.push({ line: lineNo, column: indent + name.length + 1, message: `Expected ${name}: <value>` });
      return;
    }
    const value = trimmed.slice(colon + 1).trim();
    const valueColumn = indent + colon + 2 + (trimmed.slice(colon + 1).length - trimmed.slice(colon + 1).trimStart().length);
    if (draft.seen.has(name)) {
      diagnostics.push({ line: lineNo, column: indent + 1, message: `${name} is already given for ${draft.def.key}` });
      return;
    }
    if (value === "") {
      diagnostics.push({ line: lineNo, column: valueColumn, message: `${name} needs a value` });
      return;
    }
    if (name === "label") {
      draft.def.label = value;
    } else if (name === "description") {
      draft.def.description = value;
    } else {
      const scopes = value.split(",").map((s) => s.trim());
      const bad = scopes.find((s) => !(SCOPES as string[]).includes(s));
      if (bad !== undefined) {
        diagnostics.push({
          line: lineNo,
          column: valueColumn + value.indexOf(bad),
          message: bad === "" ? "Empty scope — expected feature, scenario or both" : `Unknown scope "${bad}" — expected feature or scenario`,
        });
        return;
      }
      draft.def.scope = SCOPES.filter((s) => scopes.includes(s));
    }
    draft.seen.add(name);
  });

  // A second definition of a key is left out.
  const firsts = new Map<string, Draft>();
  const kept: Draft[] = [];
  for (const d of drafts) {
    const first = firsts.get(d.def.key);
    if (first) {
      diagnostics.push({
        line: d.def.line,
        column: 2,
        message: `${d.def.key} is already defined on line ${first.def.line}`,
      });
      continue;
    }
    firsts.set(d.def.key, d);
    kept.push(d);
  }
  // A `from` must name another definition that is kept — dropping one may
  // strand another, so settle it until nothing more drops.
  let live = kept;
  for (;;) {
    const keys = new Set(live.map((d) => d.def.key));
    const next = live.filter((d) => {
      const bad = d.refs.find((r) => r.from === d.def.key || !keys.has(r.from));
      if (!bad) return true;
      diagnostics.push({
        line: d.def.line,
        column: bad.column,
        message:
          bad.from === d.def.key
            ? `${d.def.key} cannot refer to itself`
            : `No attribute ${bad.from} is defined for this to refer to`,
      });
      return false;
    });
    if (next.length === live.length) break;
    live = next;
  }
  diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
  const list = live.map((d) => d.def);
  return { list, byKey: new Map(list.map((d) => [d.key, d])), diagnostics };
}

/** The 1-based column a pattern's part number `at` (0 = first after the key) starts at. */
function columnOfPart(line: string, at: number): number {
  const pieces = splitTop(line.slice(1, line.lastIndexOf("]")), ":");
  let column = 2;
  for (let i = 0; i <= at; i++) column += pieces[i]!.length + 1;
  return column;
}

/** A definition's label, else the key: what a chip and a menu call it. */
export function attributeLabel(defs: AttributeDefinitions | undefined, key: string): string {
  return defs?.byKey.get(key)?.label ?? key;
}

/** The definitions an editor offers for a feature, or for a scenario. */
export function definitionsFor(defs: AttributeDefinitions, where: AttributeScope): AttributeDefinition[] {
  return defs.list.filter((d) => d.scope.includes(where));
}

/**
 * What a data repo's attributes use, per key: the segments seen at each
 * position — `known.get("br")?.[0]` is every rule named in a `[br:…]`. A
 * `from` slot is checked against position 0 of the key it names.
 */
export type KnownAttributes = Map<string, Set<string>[]>;

export function knownNames(lists: Iterable<readonly SpecAttribute[] | undefined>): KnownAttributes {
  const known: KnownAttributes = new Map();
  for (const list of lists) {
    for (const a of list ?? []) {
      const segments = [...a.names, a.value];
      const at = known.get(a.key) ?? [];
      segments.forEach((s, i) => (at[i] ??= new Set()).add(s));
      known.set(a.key, at);
    }
  }
  return known;
}

/** The segments seen at one position of a key, sorted, for a `<datalist>`. */
export function attributeSuggestions(
  defs: AttributeDefinitions,
  key: string,
  position: number,
  known: KnownAttributes,
): string[] {
  const def = defs.byKey.get(key);
  const part = def ? [...def.names, def.value][position] : undefined;
  const from = part?.slot?.from;
  const seen = from ? known.get(from)?.[0] : known.get(key)?.[position];
  const words = part?.words ?? [];
  return [...new Set([...words, ...(seen ?? [])])].sort((a, b) => a.localeCompare(b));
}

/** How the editor sets one part: a switch, a select, an input, or a select with "Other…". */
export type PartControl =
  | { kind: "switch" }
  | { kind: "select"; options: string[] }
  | { kind: "input"; slot: AttributeSlot }
  | { kind: "select-other"; options: string[]; slot: AttributeSlot };

export function partControl(part: AttributePart): PartControl {
  if (!part.slot) {
    const [a, b] = part.words;
    if (part.words.length === 2 && a === "on" && b === "off") return { kind: "switch" };
    return { kind: "select", options: [...part.words] };
  }
  if (part.words.length === 0) return { kind: "input", slot: part.slot };
  return { kind: "select-other", options: [...part.words], slot: part.slot };
}

/** The alternatives a part takes, as a message lists them: "on, off or a number". */
export function partAlternatives(part: AttributePart): string {
  const all = [
    ...part.words,
    ...(part.slot ? [part.slot.type === "number" ? "a number" : `a ${part.slot.name}`] : []),
  ];
  return all.length <= 1 ? (all[0] ?? "") : `${all.slice(0, -1).join(", ")} or ${all.at(-1)}`;
}

/**
 * Why one segment does not fit a part, or null when it does. `label` names
 * the attribute a `from` slot points at, for the message.
 */
export function segmentProblem(
  part: AttributePart,
  segment: string,
  known: KnownAttributes,
  defs: AttributeDefinitions,
): string | null {
  if (part.words.includes(segment)) return null;
  const slot = part.slot;
  if (!slot) return `${segment} is not one of ${part.words.join(", ")}`;
  if (slot.type === "number" && !NUMBER_RE.test(segment)) return `${slot.name} must be a number`;
  if (slot.from && !known.get(slot.from)?.[0]?.has(segment)) {
    return `No ${attributeLabel(defs, slot.from).toLowerCase()} named "${segment}" is used yet`;
  }
  return null;
}

/**
 * Why an attribute does not fit its definition where it is used, or null
 * when it does — the warning a chip shows.
 */
export function attributeProblem(
  a: SpecAttribute,
  where: AttributeScope,
  defs: AttributeDefinitions,
  known: KnownAttributes,
): string | null {
  const def = defs.byKey.get(a.key);
  if (!def) return `${a.key} is not defined in Settings → Custom attributes`;
  if (!def.scope.includes(where)) {
    return `${def.label} is for ${def.scope.map((s) => `${s}s`).join(" and ")} only`;
  }
  if (a.names.length !== def.names.length) return `${def.label} is written ${def.pattern}`;
  for (let i = 0; i < def.names.length; i++) {
    const why = segmentProblem(def.names[i]!, a.names[i]!, known, defs);
    if (why) return why;
  }
  return segmentProblem(def.value, a.value, known, defs);
}

/**
 * attributeProblem for every attribute of a list, plus the one a list has
 * on its own: the same attribute given twice with different values.
 */
export function attributeProblems(
  list: readonly SpecAttribute[],
  where: AttributeScope,
  defs: AttributeDefinitions,
  known: KnownAttributes,
): (string | null)[] {
  return list.map((a, i) => {
    const why = attributeProblem(a, where, defs, known);
    if (why) return why;
    const identity = [a.key, ...a.names].join(":");
    const other = list.find((b, j) => j !== i && [b.key, ...b.names].join(":") === identity);
    if (!other) return null;
    return `${[attributeLabel(defs, a.key), ...a.names].join(" ")} is also set to ${other.value}`;
  });
}

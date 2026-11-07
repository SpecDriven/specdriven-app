// The name of the test a `[test: … ]` reference points at (specs/external-
// links/test-traceability.feature.md). A reference names a line in a file on
// GitHub — `…/QuoteHomeownersPolicyTest.java#L32` — and the editor stores
// the test function declared there as `[test: <name> : <url> ]`, so readers
// of the feature file (and GitHub, which shows the token verbatim) see which
// test it is without opening the code.
//
// The code is read through the GitHub REST API with the app's sign-in token
// (src/server/issues.ts), never from a local checkout — the test may live in
// any repository the token can see. The function name is found with a
// per-language line pattern, no parser: from the anchored line downward
// over annotations, decorators and comments to the declaration they
// precede, else upward to the nearest declaration the line sits inside.

import { GitHubError, githubText } from "./issues";

/** A GitHub file url with a line anchor, taken apart. */
export interface TestUrl {
  owner: string;
  repo: string;
  /**
   * Everything between `blob/` and the anchor: the ref and the path, which
   * a url does not tell apart — a branch name may hold slashes.
   */
  segments: string[];
  line: number;
}

/**
 * The url a test reference must be: a github.com `blob` url naming a line.
 * A url without `#L<n>` has no test to name, so the editor turns it away.
 */
export function parseTestUrl(url: string): TestUrl | null {
  const m = url
    .trim()
    .match(/^https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/([^#?\s]+?)\/?(?:\?[^#\s]*)?#L(\d+)(?:-L\d+)?$/);
  if (!m) return null;
  const segments = m[3]!.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return { owner: m[1]!, repo: m[2]!, segments, line: Number(m[4]) };
}

export type TestLanguage = "java" | "kotlin" | "javascript" | "python" | "go";

/** The language a test file is in, by its extension; null for one not covered. */
export function languageOf(path: string): TestLanguage | null {
  const ext = path.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  switch (ext) {
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "go":
      return "go";
    default:
      return null;
  }
}

/** Words that can stand in front of `(` without declaring anything. */
const JS_KEYWORDS = /^(?:if|for|while|switch|catch|function|return|await|typeof|new|else|do|with|yield)$/;

/** The functions a JavaScript/TypeScript test is declared through, before a file's own aliases. */
const JS_TEST_FUNCTIONS: ReadonlySet<string> = new Set(["test", "it", "Deno.test"]);

/**
 * How many lines a test call's head may span: formatters move a long title
 * onto the line under `test(`, and long modifier arguments onto lines of
 * their own.
 */
const HEAD_SPAN = 6;

/** Index of the first character at or after `i` that is not white space or a comment. */
function skipBlank(s: string, i: number): number {
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s.startsWith("//", i)) {
      const end = s.indexOf("\n", i);
      i = end < 0 ? s.length : end;
    } else if (s.startsWith("/*", i)) {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
    } else return i;
  }
}

/** Index just past the string literal opening at `i`, or -1 when it does not close. */
function skipString(s: string, i: number): number {
  const quote = s[i]!;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === quote) return j + 1;
    else if (s[j] === "\n" && quote !== "`") return -1;
  }
  return -1;
}

/** Index of the `)` that closes the `(` at `i` — strings and comments skipped — or -1. */
function closingParen(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; ) {
    const c = s[j]!;
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(s, j);
      if (j < 0) return -1;
    } else if (s.startsWith("//", j) || s.startsWith("/*", j)) {
      j = skipBlank(s, j);
    } else {
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j;
      j++;
    }
  }
  return -1;
}

/**
 * The title a call's first argument spells, when that argument is a string
 * literal ending at `,`, `)` or the text's end (so `"key" in obj` is no
 * title). Literals joined with `+` are joined; one joined with anything
 * else (`"adds " + n`) gives its literal part. The raw text between the
 * quotes, escapes kept, and the index the title starts at.
 */
function titleAt(s: string, i: number): { title: string; index: number } | null {
  i = skipBlank(s, i);
  const index = i;
  if (!/['"`]/.test(s[i] ?? "")) return null;
  let title = "";
  for (;;) {
    const end = skipString(s, i);
    if (end < 0) return null;
    title += s.slice(i + 1, end - 1);
    i = skipBlank(s, end);
    if (s[i] !== "+") {
      if (i < s.length && s[i] !== "," && s[i] !== ")") return null;
      break;
    }
    i = skipBlank(s, i + 1);
    if (!/['"`]/.test(s[i] ?? "")) break;
  }
  return title.trim() ? { title: title.trim(), index } : null;
}

/** The test function a text opens with — `test`, `it`, `Deno.test` or one of `aliases` — and where it ends. */
function testFunctionAt(s: string, aliases: ReadonlySet<string>): number {
  const m = s.match(/^\s*(Deno\s*\.\s*test|[A-Za-z_$][\w$]*)(?![\w$])/);
  if (!m) return -1;
  const name = m[1]!.replace(/\s+/g, "");
  return JS_TEST_FUNCTIONS.has(name) || aliases.has(name) ? m[0].length : -1;
}

/**
 * Walks a test function's chain of modifiers — `.only`, `.each(rows)`,
 * `.if(cond)` — from `i`. A parenthesised group followed by another `(`
 * is a modifier's arguments; any other is the call itself. Returns where
 * the call's `(` is, or, when the text ends without a call (`test.only;`),
 * -1 with `end` past the last modifier.
 */
function chainCall(s: string, i: number): { call: number; end: number } {
  for (;;) {
    i = skipBlank(s, i);
    if (s[i] === ".") {
      const m = s.slice(i + 1).match(/^\s*[A-Za-z_$][\w$]*/);
      if (!m) return { call: -1, end: i };
      i += 1 + m[0].length;
    } else if (s[i] === "(") {
      const close = closingParen(s, i);
      if (close < 0 || s[skipBlank(s, close + 1)] !== "(") return { call: i, end: close < 0 ? s.length : close + 1 };
      i = close + 1;
    } else return { call: -1, end: i };
  }
}

/**
 * The title of the test a text opens with — `test(…)`, `it(…)`, `Deno.test(…)`
 * or a call through one of the file's `aliases`, through any chain of
 * modifiers — with the index it starts at. The text may run over several
 * lines, so a title wrapped onto the line under `test(` is found.
 */
function jsTestTitle(s: string, aliases: ReadonlySet<string>): { title: string; index: number } | null {
  const start = testFunctionAt(s, aliases);
  if (start < 0) return null;
  const { call } = chainCall(s, start);
  return call < 0 ? null : titleAt(s, call + 1);
}

/**
 * Names a file binds to a test function, so `withImages("…", …)` declares a
 * test after `const withImages = test.if(…)`: a `const`/`let`/`var` whose
 * value is a test function — or another alias — with modifiers and no
 * title (`test.skipIf(cond)`, `it.only`, `test.each(rows)`), or a choice
 * of two (`cond ? test : test.skip`).
 */
export function jsTestAliases(source: string): Set<string> {
  const lines = source.split("\n");
  const declarations: { name: string; value: string }[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?!=)/);
    if (!m) return;
    let value = line.slice(m[0].length);
    for (let j = i + 1; j < Math.min(lines.length, i + HEAD_SPAN) && unbalanced(value); j++) value += "\n" + lines[j];
    declarations.push({ name: m[1]!, value });
  });
  const aliases = new Set<string>();
  // Aliases of aliases: until a pass finds no new one.
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, value } of declarations) {
      if (aliases.has(name) || JS_TEST_FUNCTIONS.has(name)) continue;
      if (isTestFunction(value, aliases)) {
        aliases.add(name);
        grew = true;
      }
    }
  }
  return aliases;
}

/** Whether a text opens more parentheses than it closes, strings and comments skipped. */
function unbalanced(s: string): boolean {
  let depth = 0;
  for (let j = 0; j < s.length; ) {
    const c = s[j]!;
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(s, j);
      if (j < 0) return false;
    } else if (s.startsWith("//", j) || s.startsWith("/*", j)) {
      j = skipBlank(s, j);
    } else {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    }
  }
  return depth > 0;
}

/** Whether an expression is a test function: on its own with modifiers, or either side of a `?:` choice. */
function isTestFunction(value: string, aliases: ReadonlySet<string>): boolean {
  const whole = (s: string): boolean => {
    const start = testFunctionAt(s, aliases);
    if (start < 0) return false;
    const { call, end } = chainCall(s, start);
    // A final group whose first argument is a title is a test, not a modifier.
    const last = call < 0 ? end : closingParen(s, call);
    if (last < 0 || (call >= 0 && titleAt(s, call + 1))) return false;
    let rest = skipBlank(s, call < 0 ? end : last + 1);
    if (s[rest] === ";") rest = skipBlank(s, rest + 1);
    return rest >= s.length;
  };
  if (whole(value)) return true;
  // `cond ? a : b` within one statement: no `;` before the second branch.
  const choice = value.match(/^[^?;]*?[^?.;]\?(?![?.])([^:;]*):(.*)$/s);
  return !!choice && whole(choice[1]!) && whole(choice[2]!);
}

/** The function or class method a JavaScript/TypeScript line declares, by name. */
function jsDeclaredFunction(line: string): string | null {
  const fn = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
  if (fn) return fn[1]!;
  const method = line.match(
    /^\s*(?:(?:public|private|protected|static|override|async)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[^{;]+)?\{\s*$/,
  );
  if (method && !JS_KEYWORDS.test(method[1]!)) return method[1]!;
  return null;
}

/**
 * The test a single line declares, or null. Per language:
 * - Java: a method — modifiers, then `void` or a capitalised type, then the name.
 * - Kotlin: `fun name(` or `fun \`a name with spaces\`(`.
 * - JavaScript/TypeScript: a `test(…)` / `it(…)` call's title (the test's
 *   name in those frameworks) — through any chain of modifiers, with or
 *   without their own arguments: `test.only(…)`, `test.each(rows)(…)`,
 *   `test.skipIf(cond)(…)`, and through the file's `aliases` of them
 *   (jsTestAliases) — else a `function name(` declaration or a class
 *   method `name(…) {`. A title on the next line is testNameAt's to find.
 * - Python: `def name(`.
 * - Go: `func Name(` or `func (r) Name(`.
 */
export function declaredTest(line: string, language: TestLanguage, aliases: ReadonlySet<string> = new Set()): string | null {
  switch (language) {
    case "java": {
      const m = line.match(
        /^\s*(?:(?:public|protected|private|static|final|synchronized|default|abstract)\s+)*(?:void|[A-Z][\w.<>\[\],?\s]*?)\s+([A-Za-z_$][\w$]*)\s*\(/,
      );
      return m?.[1] ?? null;
    }
    case "kotlin": {
      const m = line.match(
        /^\s*(?:(?:public|private|internal|protected|override|suspend|inline|open|operator|infix)\s+)*fun\s+(?:<[^>]*>\s*)?(?:`([^`]+)`|([A-Za-z_][\w]*))\s*\(/,
      );
      return m ? (m[1] ?? m[2] ?? null) : null;
    }
    case "javascript":
      return jsTestTitle(line, aliases)?.title ?? jsDeclaredFunction(line);
    case "python": {
      const m = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      return m?.[1] ?? null;
    }
    case "go": {
      const m = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/);
      return m?.[1] ?? null;
    }
  }
}

/**
 * A line that may stand between an anchor and the declaration it belongs
 * to: blank, a Java/Kotlin annotation or Python decorator, a comment, or
 * the opening of the group the test sits in — a `describe(` block or a
 * test class — so an anchor on the group names its first test.
 */
function precedesDeclaration(line: string): boolean {
  return (
    /^\s*(?:$|@|\/\/|\/\*|\*|#)/.test(line) ||
    /^\s*(?:describe|context|suite)(?:\.\w+)*\s*\(/.test(line) ||
    /^\s*(?:(?:public|final|abstract|open|internal|private|export|default)\s+)*class\s+[A-Za-z_]/.test(line)
  );
}

/** How far below the anchor a declaration is still taken to be the anchored one. */
const LOOKAHEAD = 12;

/**
 * The test declared at line `i` (0-based) of `lines`. A JavaScript test
 * call's head may run over the lines under it — `test(` with the title on
 * the next line, as formatters wrap a long one — and a line holding such a
 * title names that test as well as the `test(` line does.
 */
function declarationAt(lines: string[], i: number, language: TestLanguage, aliases: ReadonlySet<string>): string | null {
  if (language !== "javascript") return declaredTest(lines[i]!, language);
  const head = (from: number) => {
    if (testFunctionAt(lines[from]!, aliases) < 0) return null;
    const text = lines.slice(from, from + HEAD_SPAN).join("\n");
    const call = jsTestTitle(text, aliases);
    return call && { title: call.title, line: from + (text.slice(0, call.index).match(/\n/g)?.length ?? 0) };
  };
  const here = head(i);
  if (here) return here.title;
  for (let from = i - 1; from >= 0 && from > i - HEAD_SPAN; from--) {
    const call = head(from);
    if (call?.line === i) return call.title;
  }
  return jsDeclaredFunction(lines[i]!);
}

/**
 * The test declared at `line` (1-based) of `source`: on that line, or on the
 * first declaring line below it that only annotations, decorators, comments
 * and blank lines lead to — an anchor on `@Test` names the method under it
 * — else the nearest declaration above, for an anchor inside a test's body.
 * Null when the line is out of range or no declaration is near.
 */
export function testNameAt(source: string, line: number, language: TestLanguage): string | null {
  const lines = source.split("\n");
  const at = line - 1;
  if (!Number.isInteger(at) || at < 0 || at >= lines.length) return null;
  const aliases = language === "javascript" ? jsTestAliases(source) : new Set<string>();
  for (let i = at; i < lines.length && i <= at + LOOKAHEAD; i++) {
    const name = declarationAt(lines, i, language, aliases);
    if (name) return name;
    if (!precedesDeclaration(lines[i]!)) break;
  }
  for (let i = at - 1; i >= 0; i--) {
    const name = declarationAt(lines, i, language, aliases);
    if (name) return name;
  }
  return null;
}

/**
 * The file's text from GitHub. The url's ref and path are told apart by
 * trying: the first segment as the ref, then the first two, and so on —
 * the first split GitHub knows is the one. The last "not found" is
 * reported when none is.
 */
export async function fetchTestSource(target: TestUrl): Promise<string> {
  for (let split = 1; split < target.segments.length; split++) {
    const ref = target.segments.slice(0, split).join("/");
    const path = target.segments.slice(split).map(encodeURIComponent).join("/");
    try {
      return await githubText(
        `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      );
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) continue;
      throw e;
    }
  }
  // Worded for a file: the issues module's "no such repository or issue"
  // would mislead here.
  throw new GitHubError(
    `GitHub reports no such file, or the sign-in cannot see it: ${target.owner}/${target.repo} ${target.segments.join("/")}`,
    404,
  );
}

/** What a lookup answers: the name, or why there is none. */
export interface TestNameResult {
  name: string | null;
  /** One sentence for the editor's hint when `name` is null. */
  reason?: string;
}

/**
 * The name of the test a reference url points at. Every expected failure —
 * a url of the wrong shape, a language the patterns don't cover, no
 * declaration near the line, GitHub refusing or not finding the file —
 * comes back as a reason rather than an error: the editor keeps the link
 * and shows the reason under the field.
 */
export async function resolveTestName(url: string): Promise<TestNameResult> {
  const target = parseTestUrl(url);
  if (!target) return { name: null, reason: "Not a GitHub file url with a #L<line> anchor." };
  const file = target.segments[target.segments.length - 1]!;
  const language = languageOf(file);
  if (!language) {
    return { name: null, reason: `Test names are read from Java, Kotlin, TypeScript, JavaScript, Python and Go files, not ${file}.` };
  }
  let source: string;
  try {
    source = await fetchTestSource(target);
  } catch (e) {
    if (e instanceof GitHubError) return { name: null, reason: e.message };
    return { name: null, reason: `Could not read ${file} from GitHub: ${e instanceof Error ? e.message : String(e)}` };
  }
  const name = testNameAt(source, target.line, language);
  if (!name) return { name: null, reason: `No test declared at or around line ${target.line} of ${file}.` };
  return { name };
}

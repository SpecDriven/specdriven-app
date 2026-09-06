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

/**
 * The test a single line declares, or null. Per language:
 * - Java: a method — modifiers, then `void` or a capitalised type, then the name.
 * - Kotlin: `fun name(` or `fun \`a name with spaces\`(`.
 * - JavaScript/TypeScript: a `test(…)` / `it(…)` call's title (the test's
 *   name in those frameworks), else a `function name(` declaration or a
 *   class method `name(…) {`.
 * - Python: `def name(`.
 * - Go: `func Name(` or `func (r) Name(`.
 */
export function declaredTest(line: string, language: TestLanguage): string | null {
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
    case "javascript": {
      const call = line.match(
        /^\s*(?:test|it|Deno\.test)(?:\.(?:only|skip|todo|concurrent|serial|failing|each))*\s*(?:\([^()]*\))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/,
      );
      if (call) return call[2]!.trim() || null;
      const fn = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
      if (fn) return fn[1]!;
      const method = line.match(
        /^\s*(?:(?:public|private|protected|static|override|async)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[^{;]+)?\{\s*$/,
      );
      if (method && !JS_KEYWORDS.test(method[1]!)) return method[1]!;
      return null;
    }
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
  for (let i = at; i < lines.length && i <= at + LOOKAHEAD; i++) {
    const name = declaredTest(lines[i]!, language);
    if (name) return name;
    if (!precedesDeclaration(lines[i]!)) break;
  }
  for (let i = at - 1; i >= 0; i--) {
    const name = declaredTest(lines[i]!, language);
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

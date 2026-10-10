import { test, expect } from "bun:test";
import {
  formatTestRef,
  isTestLink,
  isTestName,
  parseFeature,
  parseTestRef,
  serializeFeature,
  splitTests,
  testLine,
} from "../src/server/parser";
import { normalizeShowTestLinks } from "../src/server/state";
import {
  addTestLink,
  canSetTestLink,
  removeTestLink,
  resolvePendingTests,
  testDraftOf,
  testLinkFile,
  testLinkHint,
  testLinkLabel,
  testLinkProblem,
  testLinkUrl,
  updateTestLink,
} from "../src/frontend/testlinks";

// specs/traceability.feature.md and specs/external-links/test-traceability
// .feature.md: links to automated tests are stored per scenario as GitHub
// urls — `[test: <url> ]` or `[test: <name> : <url> ]` lines — displayed at
// the end of each scenario, and toggled by a user setting that defaults to ON.

const URL_A =
  "https://github.com/vydra/GatlingGen/blob/main/app/src/test/java/ggen/GatlingCodeGeneratorTest.java#L12";
const URL_B = "https://github.com/vydra/GatlingGen/blob/main/app/src/test/java/ggen/OtherTest.java#L7";
const NAMED_A = `generatesGatlingCode : ${URL_A}`;

test("only GitHub urls are test links", () => {
  expect(isTestLink(URL_A)).toBe(true);
  expect(isTestLink("  https://github.com/o/r/blob/main/T.java  ")).toBe(true);
  expect(isTestLink("https://gitlab.com/o/r/blob/main/T.java")).toBe(false);
  expect(isTestLink("http://github.com/o/r")).toBe(false);
  expect(isTestLink("github.com/o/r")).toBe(false);
  expect(isTestLink("")).toBe(false);
});

test("the line anchor is read off the url", () => {
  expect(testLine(URL_A)).toBe(12);
  expect(testLine(`${URL_B}-L9`)).toBe(7);
  expect(testLine("https://github.com/o/r/blob/main/T.java")).toBeNull();
  expect(testLine("https://github.com/o/r/blob/main/T.java#readme")).toBeNull();
});

// A reference is `<name> : <url>` or a bare url; the name may hold anything
// but the separator and the token's closing bracket.

test("a reference is taken apart into name and url, and put back the same way", () => {
  expect(parseTestRef(URL_A)).toEqual({ url: URL_A });
  expect(parseTestRef(NAMED_A)).toEqual({ url: URL_A, name: "generatesGatlingCode" });
  expect(parseTestRef(`generatesGatlingCode:${URL_A}`)).toEqual({ url: URL_A, name: "generatesGatlingCode" });
  expect(parseTestRef(`  a test name  :  ${URL_A}  `)).toEqual({ url: URL_A, name: "a test name" });
  expect(formatTestRef({ url: URL_A })).toBe(URL_A);
  expect(formatTestRef({ url: URL_A, name: " generatesGatlingCode " })).toBe(NAMED_A);
  expect(formatTestRef({ url: URL_A, name: "" })).toBe(URL_A);
});

test("a url's own scheme is never read as a name", () => {
  expect(parseTestRef(`  ${URL_A}  `)).toEqual({ url: URL_A });
  expect(parseTestRef("http://github.com/o/r/T.java#L1")).toEqual({ url: "http://github.com/o/r/T.java#L1" });
});

test("a test name has no colon, bracket or line break", () => {
  expect(isTestName("generatesGatlingCode")).toBe(true);
  expect(isTestName("generates gatling code")).toBe(true);
  expect(isTestName("  x  ")).toBe(true);
  expect(isTestName("")).toBe(false);
  expect(isTestName("   ")).toBe(false);
  expect(isTestName("a:b")).toBe(false);
  expect(isTestName("a]b")).toBe(false);
  expect(isTestName("a\nb")).toBe(false);
});

// Test links are written as `[test: … ]` lines at the end of the scenario
// (specs/external-links/test-traceability.feature.md); the older `### Tests`
// table is still read so existing files keep their links.

test("a legacy trailing Tests table is lifted out of the scenario body", () => {
  const feature = parseFeature(
    `# F\n\n## S @v1\n\n- **Given** a thing\n\n### Tests\n\n| Test |\n| --- |\n| ${URL_A} |\n| ${URL_B} |\n`,
  );
  expect(feature.scenarios[0]!.tests).toEqual([URL_A, URL_B]);
  expect(feature.scenarios[0]!.body).toBe("- **Given** a thing");
});

test("test lines are lifted out of the scenario body", () => {
  const feature = parseFeature(
    `# F\n\n## S @v1\n\n- **Given** a thing\n\n[test: ${URL_A} ]\n[test:${URL_B}]\n`,
  );
  expect(feature.scenarios[0]!.tests).toEqual([URL_A, URL_B]);
  expect(feature.scenarios[0]!.body).toBe("- **Given** a thing");
});

test("a named test line is lifted in its canonical spelling", () => {
  const feature = parseFeature(
    `# F\n\n## S @v1\n\nbody\n\n[test: generatesGatlingCode : ${URL_A} ]\n[test:other:${URL_B}]\n`,
  );
  expect(feature.scenarios[0]!.tests).toEqual([NAMED_A, `other : ${URL_B}`]);
  expect(feature.scenarios[0]!.body).toBe("body");
});

test("a url without a scheme is not a test line", () => {
  const src = "body\n\n[test: not-a-url ]";
  const { body, tests } = splitTests(src);
  expect(tests).toEqual([]);
  expect(body).toBe(src);
});

test("test links are written as test lines and survive a round trip", () => {
  const feature = parseFeature(`# F\n\n## S @v1 [published]\n\nbody\n`);
  feature.scenarios[0]!.tests = [NAMED_A, URL_B];
  const text = serializeFeature(feature);
  expect(text).toBe(`# F\n\n## S @v1 [published]\n\nbody\n\n[test: ${NAMED_A} ]\n[test: ${URL_B} ]\n`);
  expect(text).not.toContain("### Tests");
  expect(parseFeature(text)).toEqual(feature);
});

test("a legacy table moves to test lines the first time the file is written", () => {
  const legacy = `# F\n\n## S @v1 [published]\n\nbody\n\n### Tests\n\n| Test |\n| --- |\n| ${URL_A} |\n`;
  const feature = parseFeature(legacy);
  const text = serializeFeature(feature);
  expect(text).toBe(`# F\n\n## S @v1 [published]\n\nbody\n\n[test: ${URL_A} ]\n`);
  expect(parseFeature(text)).toEqual(feature);
});

test("a test line anywhere in the body counts, and the body closes up around it", () => {
  const { body, tests } = splitTests(`step one\n\n[test: ${URL_A} ]\n\nstep two`);
  expect(tests).toEqual([URL_A]);
  expect(body).toBe("step one\n\nstep two");
});

test("a token inside a rule's line traces that rule and stays in the body", () => {
  const src = `- **Then** it is priced [test: generatesGatlingCode : ${URL_A} ]\n- **And** it is logged`;
  const { body, tests } = splitTests(src);
  expect(tests).toEqual([]);
  expect(body).toBe(src);
});

test("test lines and a legacy table combine without repeats, the first mention of a url winning", () => {
  const { tests } = splitTests(
    `body\n\n[test: ${NAMED_A} ]\n\n### Tests\n\n| Test |\n| --- |\n| ${URL_A} |\n| ${URL_B} |`,
  );
  expect(tests).toEqual([NAMED_A, URL_B]);
  expect(splitTests(`[test: ${URL_A} ]\n[test: ${NAMED_A} ]`).tests).toEqual([URL_A]);
});

test("a test line inside a code fence is ordinary content", () => {
  const src = "```\n[test: https://github.com/o/r ]\n```";
  const { body, tests } = splitTests(src);
  expect(tests).toEqual([]);
  expect(body).toBe(src);
});

test("scenarios without test links serialize without test lines", () => {
  const feature = parseFeature("# F\n\n## S @v1\n\nbody\n");
  expect(feature.scenarios[0]!.tests).toEqual([]);
  expect(serializeFeature(feature)).not.toContain("[test:");
});

test("list items and bare urls under the heading also count", () => {
  const { body, tests } = splitTests(`step one\n\n### Tests\n\n- ${URL_A}\n${URL_B}`);
  expect(body).toBe("step one");
  expect(tests).toEqual([URL_A, URL_B]);
});

test("a Tests heading inside a code fence is ordinary content", () => {
  const src = "```\n### Tests\n| https://github.com/o/r |\n```";
  const { body, tests } = splitTests(src);
  expect(tests).toEqual([]);
  expect(body).toBe(src);
});

test("the Tests table only affects its own scenario", () => {
  const feature = parseFeature(
    `# F\n\n## A @v1\n\na-body\n\n### Tests\n\n| Test |\n| --- |\n| ${URL_A} |\n\n## B @v1\n\nb-body\n`,
  );
  expect(feature.scenarios[0]!.tests).toEqual([URL_A]);
  expect(feature.scenarios[0]!.body).toBe("a-body");
  expect(feature.scenarios[1]!.tests).toEqual([]);
  expect(feature.scenarios[1]!.body).toBe("b-body");
});

// The dialog's Automated tests field — add, ✎ update, ✕ remove — applies the
// same rules to every row: GitHub urls with a line anchor only, a name the
// token can carry, no duplicate urls within a scenario.

const draft = (url: string, name = "") => ({ url, name });

test("a link is addable when it is an anchored GitHub url the scenario doesn't list", () => {
  expect(canSetTestLink([], null, draft(URL_A))).toBe(true);
  expect(canSetTestLink([], null, draft(URL_A, "generatesGatlingCode"))).toBe(true);
  expect(canSetTestLink([], null, draft("https://gitlab.com/o/r/T.java#L1"))).toBe(false);
  expect(canSetTestLink([URL_A], null, draft(URL_A))).toBe(false);
  expect(canSetTestLink([NAMED_A], null, draft(`  ${URL_A}  `, "other"))).toBe(false);
});

test("a url without a #L line anchor is turned away, with a message saying so", () => {
  const bare = "https://github.com/o/r/blob/main/T.java";
  expect(canSetTestLink([], null, draft(bare))).toBe(false);
  expect(testLinkProblem([], null, draft(bare))).toContain("line anchor");
  expect(testLinkProblem([], null, draft("https://gitlab.com/o/r/T.java#L1"))).toContain("Not a GitHub url");
  expect(testLinkProblem([URL_A], null, draft(URL_A))).toContain("Already listed");
  expect(testLinkProblem([], null, draft(URL_A))).toBeNull();
});

test("while typing, only a GitHub url missing its anchor gets a hint", () => {
  expect(testLinkHint("https://github.com/o/r/blob/main/T.java")).toContain("line anchor");
  expect(testLinkHint(URL_A)).toBeNull();
  expect(testLinkHint("https://gith")).toBeNull();
  expect(testLinkHint("")).toBeNull();
});

test("a name the token cannot carry is turned away", () => {
  expect(canSetTestLink([], null, draft(URL_A, "a:b"))).toBe(false);
  expect(testLinkProblem([], null, draft(URL_A, "a]b"))).toContain('":" or "]"');
  expect(canSetTestLink([], null, draft(URL_A, "   "))).toBe(true);
});

test("adding appends the entry, trimmed and named, and ignores a rejected one", () => {
  expect(addTestLink([], draft(`  ${URL_A}  `))).toEqual([URL_A]);
  expect(addTestLink([], draft(URL_A, " generatesGatlingCode "))).toEqual([NAMED_A]);
  expect(addTestLink([URL_A], draft(URL_B))).toEqual([URL_A, URL_B]);
  expect(addTestLink([URL_A], draft(URL_A, "x"))).toEqual([URL_A]);
  expect(addTestLink([URL_A], draft("not a url"))).toEqual([URL_A]);
});

test("a row may keep its own url while editing, but not take another's", () => {
  expect(canSetTestLink([URL_A, URL_B], 0, draft(URL_A))).toBe(true);
  expect(canSetTestLink([NAMED_A, URL_B], 0, draft(URL_A, "renamed"))).toBe(true);
  expect(canSetTestLink([URL_A, URL_B], 0, draft(URL_B))).toBe(false);
  expect(canSetTestLink([URL_A, URL_B], 0, draft("http://github.com/o/r#L1"))).toBe(false);
});

test("updating replaces just that row", () => {
  expect(updateTestLink([URL_A, URL_B], 0, draft(`${URL_B}0`))).toEqual([`${URL_B}0`, URL_B]);
  expect(updateTestLink([URL_A, URL_B], 1, draft(`  ${URL_A}2  `))).toEqual([URL_A, `${URL_A}2`]);
  expect(updateTestLink([URL_A, URL_B], 0, draft(URL_A, "generatesGatlingCode"))).toEqual([NAMED_A, URL_B]);
  expect(updateTestLink([NAMED_A, URL_B], 0, draft(URL_A, ""))).toEqual([URL_A, URL_B]);
});

test("an invalid, duplicate or out-of-range update changes nothing", () => {
  const tests = [URL_A, URL_B];
  expect(updateTestLink(tests, 0, draft(URL_B))).toEqual(tests);
  expect(updateTestLink(tests, 0, draft("nope"))).toEqual(tests);
  expect(updateTestLink(tests, 0, draft(URL_A, "a:b"))).toEqual(tests);
  expect(updateTestLink(tests, 2, draft(URL_A))).toEqual(tests);
  expect(updateTestLink(tests, -1, draft(URL_A))).toEqual(tests);
});

test("removing drops the row at the index", () => {
  expect(removeTestLink([URL_A, URL_B], 0)).toEqual([URL_B]);
  expect(removeTestLink([URL_A, URL_B], 1)).toEqual([URL_A]);
  expect(removeTestLink([URL_A], 3)).toEqual([URL_A]);
});

test("an ✎ row opens with the entry's url and name", () => {
  expect(testDraftOf(NAMED_A)).toEqual({ url: URL_A, name: "generatesGatlingCode" });
  expect(testDraftOf(URL_B)).toEqual({ url: URL_B, name: "" });
});

// Save folds in what is still sitting in the tests widgets — a url left in
// the add field or an open ✎ row is never silently dropped, and one that
// can't join the list blocks the save (specs/traceability.feature.md "the add
// field still holds a url when Save is pressed").

test("a url left in the add field rides along with the save, name included", () => {
  expect(resolvePendingTests([URL_A], null, draft(`  ${URL_B}  `))).toEqual({
    tests: [URL_A, URL_B],
  });
  expect(resolvePendingTests([URL_B], null, draft(URL_A, "generatesGatlingCode"))).toEqual({
    tests: [URL_B, NAMED_A],
  });
});

test("an empty add field and no open row change nothing", () => {
  expect(resolvePendingTests([URL_A], null, draft(""))).toEqual({ tests: [URL_A] });
  expect(resolvePendingTests([URL_A], null, draft("   "))).toEqual({ tests: [URL_A] });
  // A name with no url is nothing to save.
  expect(resolvePendingTests([URL_A], null, draft("", "orphan"))).toEqual({ tests: [URL_A] });
});

test("an invalid or duplicate pending url blocks the save", () => {
  const bad = resolvePendingTests([URL_A], null, draft("https://gitlab.com/o/r/T.java#L1"));
  expect(bad.tests).toEqual([URL_A]);
  expect(bad.error).toContain("Not a GitHub url");
  const dup = resolvePendingTests([URL_A], null, draft(URL_A));
  expect(dup.tests).toEqual([URL_A]);
  expect(dup.error).toContain("Already listed");
  const unanchored = resolvePendingTests([], null, draft("https://github.com/o/r/blob/main/T.java"));
  expect(unanchored.tests).toEqual([]);
  expect(unanchored.error).toContain("line anchor");
});

test("an open ✎ row is committed by the save", () => {
  expect(resolvePendingTests([URL_A, URL_B], { index: 0, ...draft(`${URL_A}2`) }, draft(""))).toEqual({
    tests: [`${URL_A}2`, URL_B],
  });
  // Untouched row (Save pressed right after ✎): a no-op, not an error.
  expect(resolvePendingTests([URL_A], { index: 0, ...draft(URL_A) }, draft(""))).toEqual({
    tests: [URL_A],
  });
  // A name typed into the row is saved with it.
  expect(resolvePendingTests([URL_A], { index: 0, ...draft(URL_A, "generatesGatlingCode") }, draft(""))).toEqual({
    tests: [NAMED_A],
  });
});

test("an open row and a filled add field both ride along", () => {
  expect(resolvePendingTests([URL_A], { index: 0, ...draft(`${URL_A}2`) }, draft(URL_B))).toEqual({
    tests: [`${URL_A}2`, URL_B],
  });
  // The add field is checked against the row's new url: a draft duplicating
  // it blocks the save.
  const dup = resolvePendingTests([URL_A], { index: 0, ...draft(URL_B) }, draft(URL_B));
  expect(dup.tests).toEqual([URL_A]);
  expect(dup.error).toContain("Already listed");
});

test("a cleared or invalid ✎ row blocks the save", () => {
  const cleared = resolvePendingTests([URL_A], { index: 0, ...draft("") }, draft(""));
  expect(cleared.tests).toEqual([URL_A]);
  expect(cleared.error).toContain("Not a GitHub url");
  const badName = resolvePendingTests([URL_A], { index: 0, ...draft(URL_A, "a:b") }, draft(""));
  expect(badName.tests).toEqual([URL_A]);
  expect(badName.error).toContain('":" or "]"');
});

test("the label is the test's name, else its file name without repo path or line anchor", () => {
  expect(testLinkLabel(URL_A)).toBe("GatlingCodeGeneratorTest.java");
  expect(testLinkLabel(NAMED_A)).toBe("generatesGatlingCode");
  expect(testLinkLabel("https://www.github.com/o/r")).toBe("r");
  expect(testLinkFile(NAMED_A)).toBe("GatlingCodeGeneratorTest.java");
  expect(testLinkFile(URL_A)).toBe("GatlingCodeGeneratorTest.java");
  expect(testLinkUrl(NAMED_A)).toBe(URL_A);
  expect(testLinkUrl(URL_A)).toBe(URL_A);
});

// The display setting is optional with default ON
// (specs/traceability.feature.md).
test("showTestLinks defaults to ON and only an explicit false turns it off", () => {
  expect(normalizeShowTestLinks(undefined)).toBe(true);
  expect(normalizeShowTestLinks(true)).toBe(true);
  expect(normalizeShowTestLinks(null)).toBe(true);
  expect(normalizeShowTestLinks("no")).toBe(true);
  expect(normalizeShowTestLinks(false)).toBe(false);
});

import { test, expect } from "bun:test";
import { isTestLink, parseFeature, serializeFeature, splitTests } from "../src/server/parser";
import { normalizeShowTestLinks } from "../src/server/state";
import {
  addTestLink,
  canSetTestLink,
  removeTestLink,
  resolvePendingTests,
  testLinkLabel,
  updateTestLink,
} from "../src/frontend/testlinks";

// specs/traceability.spec.md: links to automated tests are stored per
// scenario as GitHub urls in a trailing `### Tests` table, displayed at the
// end of each scenario, and toggled by a user setting that defaults to ON.

const URL_A =
  "https://github.com/vydra/GatlingGen/blob/main/app/src/test/java/ggen/GatlingCodeGeneratorTest.java";
const URL_B = "https://github.com/vydra/GatlingGen/blob/main/app/src/test/java/ggen/OtherTest.java";

test("only GitHub urls are test links", () => {
  expect(isTestLink(URL_A)).toBe(true);
  expect(isTestLink("  https://github.com/o/r/blob/main/T.java  ")).toBe(true);
  expect(isTestLink("https://gitlab.com/o/r/blob/main/T.java")).toBe(false);
  expect(isTestLink("http://github.com/o/r")).toBe(false);
  expect(isTestLink("github.com/o/r")).toBe(false);
  expect(isTestLink("")).toBe(false);
});

test("a trailing Tests table is lifted out of the scenario body", () => {
  const feature = parseFeature(
    `# F\n\n## S @v1\n\n- **Given** a thing\n\n### Tests\n\n| Test |\n| --- |\n| ${URL_A} |\n| ${URL_B} |\n`,
  );
  expect(feature.scenarios[0]!.tests).toEqual([URL_A, URL_B]);
  expect(feature.scenarios[0]!.body).toBe("- **Given** a thing");
});

test("test links survive a parse/serialize round trip", () => {
  const feature = parseFeature(`# F\n\n## S @v1 [published]\n\nbody\n`);
  feature.scenarios[0]!.tests = [URL_A];
  const text = serializeFeature(feature);
  expect(text).toContain("### Tests");
  expect(text).toContain(`| ${URL_A} |`);
  expect(parseFeature(text)).toEqual(feature);
});

test("scenarios without test links serialize without a Tests section", () => {
  const feature = parseFeature("# F\n\n## S @v1\n\nbody\n");
  expect(feature.scenarios[0]!.tests).toEqual([]);
  expect(serializeFeature(feature)).not.toContain("### Tests");
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
// same rules to every row: GitHub urls only, no duplicates within a scenario
// (specs/traceability.spec.md "correct a test link").

test("a link is addable when it is a GitHub url the scenario doesn't list", () => {
  expect(canSetTestLink([], null, URL_A)).toBe(true);
  expect(canSetTestLink([], null, "https://gitlab.com/o/r/T.java")).toBe(false);
  expect(canSetTestLink([URL_A], null, URL_A)).toBe(false);
  expect(canSetTestLink([URL_A], null, `  ${URL_A}  `)).toBe(false);
});

test("adding appends the trimmed url and ignores a rejected one", () => {
  expect(addTestLink([], `  ${URL_A}  `)).toEqual([URL_A]);
  expect(addTestLink([URL_A], URL_B)).toEqual([URL_A, URL_B]);
  expect(addTestLink([URL_A], URL_A)).toEqual([URL_A]);
  expect(addTestLink([URL_A], "not a url")).toEqual([URL_A]);
});

test("a row may keep its own url while editing, but not take another's", () => {
  expect(canSetTestLink([URL_A, URL_B], 0, URL_A)).toBe(true);
  expect(canSetTestLink([URL_A, URL_B], 0, URL_B)).toBe(false);
  expect(canSetTestLink([URL_A, URL_B], 0, "http://github.com/o/r")).toBe(false);
});

test("updating replaces just that row", () => {
  expect(updateTestLink([URL_A, URL_B], 0, `${URL_B}x`)).toEqual([`${URL_B}x`, URL_B]);
  expect(updateTestLink([URL_A, URL_B], 1, `  ${URL_A}2  `)).toEqual([URL_A, `${URL_A}2`]);
});

test("an invalid, duplicate or out-of-range update changes nothing", () => {
  const tests = [URL_A, URL_B];
  expect(updateTestLink(tests, 0, URL_B)).toEqual(tests);
  expect(updateTestLink(tests, 0, "nope")).toEqual(tests);
  expect(updateTestLink(tests, 2, URL_A)).toEqual(tests);
  expect(updateTestLink(tests, -1, URL_A)).toEqual(tests);
});

test("removing drops the row at the index", () => {
  expect(removeTestLink([URL_A, URL_B], 0)).toEqual([URL_B]);
  expect(removeTestLink([URL_A, URL_B], 1)).toEqual([URL_A]);
  expect(removeTestLink([URL_A], 3)).toEqual([URL_A]);
});

// Save folds in what is still sitting in the tests widgets — a url left in
// the add field or an open ✎ row is never silently dropped, and one that
// can't join the list blocks the save (specs/traceability.spec.md "the add
// field still holds a url when Save is pressed").

test("a url left in the add field rides along with the save", () => {
  expect(resolvePendingTests([URL_A], null, `  ${URL_B}  `)).toEqual({
    tests: [URL_A, URL_B],
  });
});

test("an empty add field and no open row change nothing", () => {
  expect(resolvePendingTests([URL_A], null, "")).toEqual({ tests: [URL_A] });
  expect(resolvePendingTests([URL_A], null, "   ")).toEqual({ tests: [URL_A] });
});

test("an invalid or duplicate pending url blocks the save", () => {
  const bad = resolvePendingTests([URL_A], null, "https://gitlab.com/o/r/T.java");
  expect(bad.tests).toEqual([URL_A]);
  expect(bad.error).toContain("Not a GitHub url");
  const dup = resolvePendingTests([URL_A], null, URL_A);
  expect(dup.tests).toEqual([URL_A]);
  expect(dup.error).toContain("Already listed");
});

test("an open ✎ row is committed by the save", () => {
  expect(resolvePendingTests([URL_A, URL_B], { index: 0, url: `${URL_A}2` }, "")).toEqual({
    tests: [`${URL_A}2`, URL_B],
  });
  // Untouched row (Save pressed right after ✎): a no-op, not an error.
  expect(resolvePendingTests([URL_A], { index: 0, url: URL_A }, "")).toEqual({
    tests: [URL_A],
  });
});

test("an open row and a filled add field both ride along", () => {
  expect(resolvePendingTests([URL_A], { index: 0, url: `${URL_A}2` }, URL_B)).toEqual({
    tests: [`${URL_A}2`, URL_B],
  });
  // The add field is checked against the row's new url: a draft duplicating
  // it blocks the save.
  const dup = resolvePendingTests([URL_A], { index: 0, url: URL_B }, URL_B);
  expect(dup.tests).toEqual([URL_A]);
  expect(dup.error).toContain("Already listed");
});

test("a cleared or invalid ✎ row blocks the save", () => {
  const cleared = resolvePendingTests([URL_A], { index: 0, url: "" }, "");
  expect(cleared.tests).toEqual([URL_A]);
  expect(cleared.error).toContain("Not a GitHub url");
});

test("the label drops the github.com prefix", () => {
  expect(testLinkLabel(URL_A)).toBe(
    "vydra/GatlingGen/blob/main/app/src/test/java/ggen/GatlingCodeGeneratorTest.java",
  );
  expect(testLinkLabel("https://www.github.com/o/r")).toBe("o/r");
});

// The display setting is optional with default ON (specs/traceability.spec.md).
test("showTestLinks defaults to ON and only an explicit false turns it off", () => {
  expect(normalizeShowTestLinks(undefined)).toBe(true);
  expect(normalizeShowTestLinks(true)).toBe(true);
  expect(normalizeShowTestLinks(null)).toBe(true);
  expect(normalizeShowTestLinks("no")).toBe(true);
  expect(normalizeShowTestLinks(false)).toBe(false);
});

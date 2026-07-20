import { test, expect } from "bun:test";
import { isTestLink, parseFeature, serializeFeature, splitTests } from "../src/server/parser";
import { normalizeShowTestLinks } from "../src/server/state";

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
    `# F\n\n## S v1\n\n- **Given** a thing\n\n### Tests\n\n| Test |\n| --- |\n| ${URL_A} |\n| ${URL_B} |\n`,
  );
  expect(feature.scenarios[0]!.tests).toEqual([URL_A, URL_B]);
  expect(feature.scenarios[0]!.body).toBe("- **Given** a thing");
});

test("test links survive a parse/serialize round trip", () => {
  const feature = parseFeature(`# F\n\n## S v1 [published]\n\nbody\n`);
  feature.scenarios[0]!.tests = [URL_A];
  const text = serializeFeature(feature);
  expect(text).toContain("### Tests");
  expect(text).toContain(`| ${URL_A} |`);
  expect(parseFeature(text)).toEqual(feature);
});

test("scenarios without test links serialize without a Tests section", () => {
  const feature = parseFeature("# F\n\n## S v1\n\nbody\n");
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
    `# F\n\n## A v1\n\na-body\n\n### Tests\n\n| Test |\n| --- |\n| ${URL_A} |\n\n## B v1\n\nb-body\n`,
  );
  expect(feature.scenarios[0]!.tests).toEqual([URL_A]);
  expect(feature.scenarios[0]!.body).toBe("a-body");
  expect(feature.scenarios[1]!.tests).toEqual([]);
  expect(feature.scenarios[1]!.body).toBe("b-body");
});

// The display setting is optional with default ON (specs/traceability.spec.md).
test("showTestLinks defaults to ON and only an explicit false turns it off", () => {
  expect(normalizeShowTestLinks(undefined)).toBe(true);
  expect(normalizeShowTestLinks(true)).toBe(true);
  expect(normalizeShowTestLinks(null)).toBe(true);
  expect(normalizeShowTestLinks("no")).toBe(true);
  expect(normalizeShowTestLinks(false)).toBe(false);
});

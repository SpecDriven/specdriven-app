// Automates specs/app/custom-attributes.feature.md "Custom attributes are
// defined in Settings" and "Attributes are checked against their
// definitions": the pattern-first DSL of custom-attributes.txt
// (src/server/customAttributes.ts) — what it defines, what it reports, and
// how an attribute in a feature file is checked against it.

import { test, expect } from "bun:test";
import {
  EXAMPLE_ATTRIBUTE_DEFINITIONS,
  attributeLabel,
  attributeProblem,
  attributeProblems,
  attributeSuggestions,
  definitionsFor,
  knownNames,
  parseAttributeDefinitions,
  partControl,
} from "../src/server/customAttributes";
import type { SpecAttribute } from "../src/server/parser";

const messages = (text: string) =>
  parseAttributeDefinitions(text).diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`);

test("the example defines business rules and sub-rules with no problems", () => {
  const defs = parseAttributeDefinitions(EXAMPLE_ATTRIBUTE_DEFINITIONS);
  expect(defs.diagnostics).toEqual([]);
  expect(defs.list.map((d) => d.key)).toEqual(["br", "br-sub"]);
  const br = defs.byKey.get("br")!;
  expect(br.label).toBe("Business rule");
  expect(br.description).toBe("A business rule the spec depends on");
  expect(br.names).toEqual([{ words: [], slot: { name: "rule", type: "text" } }]);
  expect(br.value).toEqual({ words: ["on", "off"], slot: { name: "value", type: "text" } });
  expect(defs.byKey.get("br-sub")!.names[0]!.slot).toEqual({ name: "rule", type: "text", from: "br" });
});

test("a pattern holds words and slots, and the properties default", () => {
  const defs = parseAttributeDefinitions(
    "# lines of business\n[line:auto|home|boat]\n\n[claims:<n:number>]\n  scope: scenario\n",
  );
  expect(defs.diagnostics).toEqual([]);
  const line = defs.byKey.get("line")!;
  expect(line.names).toEqual([]);
  expect(line.value.words).toEqual(["auto", "home", "boat"]);
  expect(line.label).toBe("line");
  expect(line.scope).toEqual(["feature", "scenario"]);
  expect(defs.byKey.get("claims")!.value.slot).toEqual({ name: "n", type: "number" });
  expect(definitionsFor(defs, "feature").map((d) => d.key)).toEqual(["line"]);
  expect(attributeLabel(defs, "line")).toBe("line");
  expect(attributeLabel(defs, "nope")).toBe("nope");
});

test("every problem has its line and column, and says what was expected", () => {
  expect(
    messages(`  label: orphan
[br:<rule>:on|off|<value>]
  color: red
  scope: feature, thing
[ff:<x>]
[Up:<x>]
[n:<x:number>:<y:int>]
[s:<a>|<b>]
[v:<r:number from br>]
[w:on||off]
[y:<a>] trailing
[z:<a>
nonsense
`),
  ).toEqual([
    "1:3 A property belongs under a pattern — start the pattern in column 1",
    '3:3 Unknown property "color" — expected label, scope or description',
    '4:19 Unknown scope "thing" — expected feature or scenario',
    '5:2 "ff" is reserved for feature flags',
    '6:2 "Up" is not a key — start with a lower-case letter and use only a-z, 0-9, . _ and -',
    '7:18 Unknown type "int" — expected text or number',
    "8:8 A part takes at most one <slot>",
    "9:5 A slot takes a type or a from, not both",
    "10:7 Empty alternative — remove the extra |",
    "11:9 Nothing may follow the pattern on its line",
    "12:7 The pattern has no closing ]",
    "13:1 Expected a pattern like [key:<name>:on|off], or an indented property under one",
  ]);
  for (const key of ["test", "http", "https", "draft", "proposed", "published", "saved"]) {
    expect(messages(`[${key}:<x>]`)).toEqual([`1:2 "${key}" is reserved and cannot be a key`]);
  }
});

test("a reference must name another defined attribute", () => {
  expect(messages("[t:<r from nope>:on]\n[u:<r from u>:on]\n")).toEqual([
    "1:4 No attribute nope is defined for this to refer to",
    "2:4 u cannot refer to itself",
  ]);
  // Leaving one out strands what refers to it.
  const defs = parseAttributeDefinitions("[a:<x from b>]\n[b:<y from c>]\n[c:<z from zz>]\n");
  expect(defs.list).toEqual([]);
  expect(defs.diagnostics.length).toBe(3);
});

test("a definition with a problem is left out, a bad property is ignored, a second definition is left out", () => {
  const defs = parseAttributeDefinitions(`[br:<rule>:on|off]
  label: Business rule
  scope: everywhere
  label: Again
[bad:on||off]
  label: Never seen
[br:<x>]
[ok:yes|no]
`);
  expect(defs.list.map((d) => d.key)).toEqual(["br", "ok"]);
  const br = defs.byKey.get("br")!;
  expect(br.label).toBe("Business rule");
  expect(br.scope).toEqual(["feature", "scenario"]);
  expect(defs.diagnostics.map((d) => d.message)).toEqual([
    'Unknown scope "everywhere" — expected feature or scenario',
    "label is already given for br",
    "Empty alternative — remove the extra |",
    "br is already defined on line 1",
  ]);
  // Never throws, whatever it is given.
  for (const junk of ["", "]", "[", "[:]", "[a:]", "[a:<>]", "\t\t#", "[a:<x from >]"]) {
    expect(() => parseAttributeDefinitions(junk)).not.toThrow();
  }
});

test("each part gets the control that fits it", () => {
  const defs = parseAttributeDefinitions(
    "[br:<rule>:on|off|<value>]\n[t:on|off]\n[line:auto|home]\n[n:<k:number>]\n",
  );
  expect(partControl(defs.byKey.get("t")!.value)).toEqual({ kind: "switch" });
  expect(partControl(defs.byKey.get("line")!.value)).toEqual({ kind: "select", options: ["auto", "home"] });
  expect(partControl(defs.byKey.get("n")!.value)).toEqual({
    kind: "input",
    slot: { name: "k", type: "number" },
  });
  expect(partControl(defs.byKey.get("br")!.value)).toEqual({
    kind: "select-other",
    options: ["on", "off"],
    slot: { name: "value", type: "text" },
  });
  expect(partControl(defs.byKey.get("br")!.names[0]!)).toEqual({
    kind: "input",
    slot: { name: "rule", type: "text" },
  });
});

test("an attribute is checked against its definition, and the names used are suggested", () => {
  const defs = parseAttributeDefinitions(
    `${EXAMPLE_ATTRIBUTE_DEFINITIONS}\n[line:auto|home]\n  scope: feature\n[claims:<n:number>]\n`,
  );
  const used: SpecAttribute[] = [
    { key: "br", names: ["young-driver-surcharge"], value: "on" },
    { key: "br", names: ["max-claims"], value: "3" },
  ];
  const known = knownNames([used, undefined]);
  const problem = (a: SpecAttribute, where: "feature" | "scenario" = "scenario") =>
    attributeProblem(a, where, defs, known);
  expect(problem({ key: "br", names: ["x"], value: "on" })).toBeNull();
  expect(problem({ key: "br-sub", names: ["young-driver-surcharge", "under-21"], value: "1.5" })).toBeNull();
  expect(problem({ key: "nope", names: [], value: "x" })).toBe("nope is not defined in Settings → Custom attributes");
  expect(problem({ key: "line", names: [], value: "auto" })).toBe("line is for features only");
  expect(problem({ key: "line", names: [], value: "boat" }, "feature")).toBe("boat is not one of auto, home");
  expect(problem({ key: "claims", names: [], value: "many" })).toBe("n must be a number");
  expect(problem({ key: "br", names: [], value: "on" })).toBe("Business rule is written [br:<rule>:on|off|<value>]");
  expect(problem({ key: "br-sub", names: ["unknown", "x"], value: "on" })).toBe(
    'No business rule named "unknown" is used yet',
  );
  // The same attribute twice, with two values.
  expect(
    attributeProblems(
      [
        { key: "br", names: ["a"], value: "on" },
        { key: "br", names: ["a"], value: "off" },
      ],
      "feature",
      defs,
      known,
    ),
  ).toEqual(["Business rule a is also set to off", "Business rule a is also set to on"]);
  // Suggestions: the names used at that place, and for a reference the names of what it refers to.
  expect(attributeSuggestions(defs, "br", 0, known)).toEqual(["max-claims", "young-driver-surcharge"]);
  expect(attributeSuggestions(defs, "br-sub", 0, known)).toEqual(["max-claims", "young-driver-surcharge"]);
  expect(attributeSuggestions(defs, "br", 1, known)).toEqual(["3", "off", "on"]);
});

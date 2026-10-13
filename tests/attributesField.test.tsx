// Automates specs/app/custom-attributes.feature.md in the browser: the
// attribute chips on a feature header and a scenario card, checked against
// the data repo's definitions, and the field that adds, changes and removes
// attributes.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttributeChips,
  AttributesField,
  addAttribute,
  attributeAddError,
  removeAttribute,
  setAttributeValue,
} from "../src/frontend/AttributesField";
import { scenarioSignature } from "../src/frontend/App";
import {
  EXAMPLE_ATTRIBUTE_DEFINITIONS,
  knownNames,
  parseAttributeDefinitions,
} from "../src/server/customAttributes";
import type { Scenario, SpecAttribute } from "../src/server/parser";

const DEFS = parseAttributeDefinitions(
  `${EXAMPLE_ATTRIBUTE_DEFINITIONS}\n[line:auto|home]\n  label: Line of business\n  scope: feature\n[claims:<max-claims:number>]\n`,
);
const ATTRS: SpecAttribute[] = [
  { key: "br", names: ["young-driver-surcharge"], value: "on" },
  { key: "br", names: ["good-driver-discount"], value: "off" },
  { key: "br-sub", names: ["young-driver-surcharge", "under-21"], value: "1.5" },
];
const KNOWN = knownNames([ATTRS]);

describe("the attribute chips", () => {
  test("labelled by their definition, an on value green and an off one red", () => {
    const html = renderToStaticMarkup(<AttributeChips attributes={ATTRS} where="scenario" defs={DEFS} known={KNOWN} />);
    expect(html).toContain('data-attribute="[br:young-driver-surcharge:on]"');
    expect(html).toContain('class="chip static attribute on"');
    expect(html).toContain('class="chip static attribute off"');
    expect(html).toContain('<span class="attribute-label">Business sub-rule</span>');
    expect(html).toContain(
      'title="Business rule young-driver-surcharge = on — A business rule the spec depends on"',
    );
  });

  test("one that does not fit is amber and says why", () => {
    const html = renderToStaticMarkup(
      <AttributeChips
        attributes={[
          { key: "nope", names: [], value: "x" },
          { key: "line", names: [], value: "boat" },
          { key: "br-sub", names: ["unknown", "x"], value: "on" },
        ]}
        where="scenario"
        defs={DEFS}
        known={KNOWN}
      />,
    );
    expect(html.match(/class="chip static attribute warning"/g)?.length).toBe(3);
    expect(html).toContain("nope is not defined in Settings → Custom attributes");
    expect(html).toContain("Line of business is for features only");
    expect(html).toContain("No business rule named &quot;unknown&quot; is used yet");
  });

  test("labelled by key and warning about nothing when the repo defines none, and nothing when there are none", () => {
    const html = renderToStaticMarkup(<AttributeChips attributes={ATTRS} where="scenario" />);
    expect(html).toContain('<span class="attribute-label">br</span>');
    expect(html).not.toContain("warning");
    expect(renderToStaticMarkup(<AttributeChips attributes={undefined} where="feature" />)).toBe("");
    expect(renderToStaticMarkup(<AttributeChips attributes={[]} where="feature" />)).toBe("");
  });
});

describe("the attributes field", () => {
  test("a row per attribute with a control for its value and a remove button, and an add row", () => {
    const html = renderToStaticMarkup(
      <AttributesField
        attributes={[...ATTRS, { key: "nope", names: [], value: "x" }]}
        where="scenario"
        defs={DEFS}
        known={KNOWN}
        onChange={() => {}}
      />,
    );
    // on|off|<value> is a select with "Other…"; a value off the list shows in its input.
    expect(html).toContain('aria-label="Value of br young-driver-surcharge"');
    expect(html).toContain('<option value="on" selected="">on</option>');
    expect(html).toContain("Other…");
    expect(html).toContain('<option value="&lt;other&gt;" selected="">Other…</option>');
    expect(html).toMatch(/<input placeholder="value" aria-label="Value of br-sub young-driver-surcharge under-21, other value"[^>]*value="1\.5"/);
    // An attribute the definitions do not cover shows as written, with its ✕.
    expect(html).toContain('<code class="attribute-value">x</code>');
    expect(html).toContain('aria-label="Remove [nope:x]"');
    // The add row offers what scenarios may carry, not the feature-only kinds.
    expect(html).toContain('aria-label="Kind of attribute"');
    expect(html).toContain('<option value="br" selected="">Business rule</option>');
    expect(html).toContain('<option value="claims">claims</option>');
    expect(html).not.toContain("Line of business</option>");
    // Names the repo already uses are suggested.
    expect(html).toContain('<option value="good-driver-discount"></option>');
  });

  test("with no definitions for that scope, it says where to add them", () => {
    const html = renderToStaticMarkup(
      <AttributesField
        attributes={[]}
        where="feature"
        defs={parseAttributeDefinitions("[n:<x>]\n  scope: scenario\n")}
        known={new Map()}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Define attributes for features in Settings → Custom attributes");
  });

  test("adding puts it after the others of its key; changing and removing touch only that one", () => {
    const added = addAttribute(ATTRS, { key: "br", names: ["max-claims"], value: "3" });
    expect(added.map((a) => a.names[0])).toEqual([
      "young-driver-surcharge",
      "good-driver-discount",
      "max-claims",
      "young-driver-surcharge",
    ]);
    expect(addAttribute([], { key: "line", names: [], value: "auto" })).toEqual([
      { key: "line", names: [], value: "auto" },
    ]);
    expect(setAttributeValue(ATTRS, 1, "on")[1]!.value).toBe("on");
    expect(setAttributeValue(ATTRS, 1, "on")[0]).toBe(ATTRS[0]!);
    expect(removeAttribute(ATTRS, 0).map((a) => a.names[0])).toEqual([
      "good-driver-discount",
      "young-driver-surcharge",
    ]);
  });

  test("an empty part, a name not used yet, one already there or a value that is not a number is refused", () => {
    const why = (a: SpecAttribute) => attributeAddError(ATTRS, a, DEFS, KNOWN);
    expect(why({ key: "br", names: [""], value: "on" })).toBe("Fill in the rule.");
    expect(why({ key: "br-sub", names: ["x", "y"], value: "on" })).toBe('No business rule named "x" is used yet.');
    expect(why({ key: "br", names: ["young-driver-surcharge"], value: "off" })).toBe(
      "There is already a business rule young-driver-surcharge.",
    );
    expect(why({ key: "claims", names: [], value: "lots" })).toBe("max-claims must be a number.");
    expect(why({ key: "br", names: ["a:b"], value: "on" })).toBe(
      "The rule cannot hold [ ] or :, or start or end with a space.",
    );
    expect(why({ key: "br-sub", names: ["good-driver-discount", "percent"], value: "15" })).toBeNull();
  });

  test("an attribute change is something for the editor's autosave to save", () => {
    const s: Scenario = { name: "S", version: 1, status: "published", body: "b", tests: [] };
    expect(scenarioSignature({ ...s, attributes: ATTRS }, 1)).not.toBe(scenarioSignature(s, 1));
  });
});

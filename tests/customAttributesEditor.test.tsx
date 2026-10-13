// Automates specs/app/custom-attributes.feature.md "Custom attributes are
// defined in Settings" in the browser: the editor for custom-attributes.txt,
// its problems and its summary.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CustomAttributesEditor,
  CustomAttributesView,
  problemCount,
} from "../src/frontend/CustomAttributesEditor";
import { EXAMPLE_ATTRIBUTE_DEFINITIONS, parseAttributeDefinitions } from "../src/server/customAttributes";

const view = (text: string) =>
  renderToStaticMarkup(
    <CustomAttributesView text={text} defs={parseAttributeDefinitions(text)} onChange={() => {}} />,
  );

describe("the Custom attributes editor", () => {
  test("the example has no problems and its definitions are summed up", () => {
    const html = view(EXAMPLE_ATTRIBUTE_DEFINITIONS);
    expect(html).toContain('aria-label="Custom attribute definitions"');
    expect(html).toContain("No problems · 2 attributes defined");
    expect(html).toContain("<strong>Business rule</strong> <code>[br:&lt;rule&gt;:on|off|&lt;value&gt;]</code>");
    expect(html).toContain("on features and scenarios — A business rule the spec depends on");
    expect(html).not.toContain("custom-attributes-problems");
    expect(html).not.toContain("Start from the example");
  });

  test("each problem is listed by line and described by the text box", () => {
    const html = view("[br:<rule>:on|off]\n  color: red\n");
    expect(html).toContain('aria-describedby="custom-attributes-problems"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("1 problem · 1 attribute defined");
    expect(html).toContain(
      '<li title="Line 2, column 3">Line 2: Unknown property &quot;color&quot; — expected label, scope or description</li>',
    );
    expect(problemCount(3)).toBe("3 problems");
  });

  test("an empty file offers the example", () => {
    expect(view("")).toContain("Start from the example");
    expect(
      renderToStaticMarkup(
        <CustomAttributesEditor content="" autosaveSeconds={5} onSaved={() => {}} save={async (c) => c} />,
      ),
    ).toContain("Start from the example");
  });
});

// Automates specs/external-links/aha-and-figma-links.feature.md in the
// browser: the Aha! and Figma fields and the card's lists — what they show,
// what may be added, what the hint warns about — and the Settings switches
// the page reads.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceLinkField, ResourceLinkList, resourceUrlHint } from "../src/frontend/ResourceLinkField";
import { resourceLinkSwitches, scenarioSignature } from "../src/frontend/App";
import type { Scenario } from "../src/server/parser";

const AHA = { url: "https://acme.aha.io/features/APP-123", title: "" };
const FIG = { url: "https://www.figma.com/design/abc123/Quote-flow", title: "Quote screens" };

describe("the scenario card lists its Aha! and Figma links", () => {
  test("each by its title or the name in its url, linking to it in a new tab", () => {
    const aha = renderToStaticMarkup(<ResourceLinkList kind="aha" links={[AHA]} />);
    expect(aha).toContain(">APP-123</a>");
    expect(aha).toContain(`href="${AHA.url}"`);
    expect(aha).toContain('target="_blank"');
    expect(aha).toContain('rel="noreferrer"');
    const figma = renderToStaticMarkup(<ResourceLinkList kind="figma" links={[FIG]} />);
    expect(figma).toContain(">Quote screens</a>");
  });

  test("a scenario with none shows no list", () => {
    expect(renderToStaticMarkup(<ResourceLinkList kind="figma" links={[]} />)).toBe("");
  });
});

describe("the Aha! and Figma fields", () => {
  test("list the links with a remove button each, and an add row named for the tool", () => {
    const html = renderToStaticMarkup(<ResourceLinkField kind="aha" links={[AHA]} onChange={() => {}} />);
    expect(html).toContain(">APP-123</a>");
    expect(html).toContain(`aria-label="Remove ${AHA.url}"`);
    expect(html).toContain('aria-label="Aha! url"');
    expect(html).toContain('aria-label="Aha! title"');
    expect(html).toContain('placeholder="https://acme.aha.io/features/APP-123"');
    // Nothing typed yet: Add is disabled.
    expect(html).toMatch(/<button type="submit" class="link" disabled="">Add<\/button>/);
    const figma = renderToStaticMarkup(<ResourceLinkField kind="figma" links={[]} onChange={() => {}} />);
    expect(figma).toContain('aria-label="Figma url"');
  });

  test("before the scenario is in the document the field waits, and says so", () => {
    const html = renderToStaticMarkup(
      <ResourceLinkField
        kind="figma"
        links={[]}
        onChange={() => {}}
        disabled
        disabledHint="Figma links can be added once the scenario has been saved."
      />,
    );
    expect(html).toContain("once the scenario has been saved");
    expect(html).toMatch(/<input[^>]*aria-label="Figma url"[^>]*disabled=""/);
  });

  test("the hint warns about a url on another site, a repeat, or something that is no url", () => {
    expect(resourceUrlHint("aha", [], "")).toBeNull();
    expect(resourceUrlHint("aha", [], AHA.url)).toBeNull();
    expect(resourceUrlHint("figma", [], FIG.url)).toBeNull();
    expect(resourceUrlHint("figma", [], AHA.url)).toBe("Not a Figma url — it is added as it stands.");
    expect(resourceUrlHint("aha", [AHA], AHA.url)).toBe("This Aha! link is already in the list.");
    expect(resourceUrlHint("aha", [], "APP-123")).toBe("Paste an http or https url.");
  });
});

describe("the Settings switches", () => {
  test("each tool is on only when /api/state says true", () => {
    expect(resourceLinkSwitches({})).toEqual({ aha: false, figma: false });
    expect(resourceLinkSwitches({ ahaLinks: true, figmaLinks: "yes" })).toEqual({ aha: true, figma: false });
    expect(resourceLinkSwitches({ ahaLinks: false, figmaLinks: true })).toEqual({ aha: false, figma: true });
  });
});

test("linking Aha! or Figma is not an edit autosave has to write", () => {
  const s: Scenario = { name: "Basic", version: 1, status: "proposed", body: "b", tests: [] };
  expect(scenarioSignature({ ...s, aha: [AHA], figma: [FIG] }, 1)).toBe(scenarioSignature(s, 1));
});

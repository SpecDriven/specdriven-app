// StatusCounts (src/frontend/StatusIcon.tsx): the project-wide draft /
// proposed / published rollup shown in the Specs section head. Static markup
// only — it is a pure presentational component.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusCounts } from "../src/frontend/StatusIcon";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("StatusCounts", () => {
  test("shows each status count with a glyph and names the triplet", () => {
    const markup = html(<StatusCounts draft={3} proposed={5} published={12} />);
    // The wrapper names the whole triplet for screen readers.
    expect(markup).toContain('aria-label="3 draft, 5 proposed, 12 published"');
    // One count per status, in order, each paired with its StatusIcon glyph.
    const counts = [...markup.matchAll(/class="status-icon ([a-z]+)"[\s\S]*?<\/svg>(\d+)/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(counts).toEqual([
      ["draft", "3"],
      ["proposed", "5"],
      ["published", "12"],
    ]);
  });

  test("renders nothing when there are no scenarios", () => {
    expect(html(<StatusCounts draft={0} proposed={0} published={0} />)).toBe("");
  });

  test("counts zero in a status without hiding the others", () => {
    const markup = html(<StatusCounts draft={0} proposed={2} published={0} />);
    expect(markup).toContain('aria-label="0 draft, 2 proposed, 0 published"');
  });
});

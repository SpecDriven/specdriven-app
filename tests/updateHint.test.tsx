// specs/app/app-updates.feature.md "checks once a day" on the client: the
// version chip marks a newer release with a dot that names it on hover, and
// on the desktop app it is the button to the Updates page. Pure markup — no DOM.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateDot, updateTitle, VersionChip } from "../src/frontend/updateHint";

describe("the version chip", () => {
  test("a newer release puts a dot on the version, saying which version is out", () => {
    const html = renderToStaticMarkup(<VersionChip version="0.1.220" notesUnseen={false} updateAvailable="0.1.221" />);
    expect(html).toContain("v0.1.220");
    expect(html).toContain('class="update-dot"');
    expect(html).toContain('title="SpecDriven 0.1.221 is available"');
    expect(updateTitle("0.1.221")).toBe("SpecDriven 0.1.221 is available");
  });

  test("no newer release known, no dot — the release-notes dot is its own", () => {
    const plain = renderToStaticMarkup(<VersionChip version="0.1.220" notesUnseen={false} updateAvailable={null} />);
    expect(plain).toContain("v0.1.220");
    expect(plain).not.toContain("update-dot");
    expect(plain).not.toContain("title=");
    const notes = renderToStaticMarkup(<VersionChip version="0.1.220" notesUnseen={true} updateAvailable={null} />);
    expect(notes).toContain('class="unseen-dot"');
    expect(notes).not.toContain("update-dot");
    expect(renderToStaticMarkup(<UpdateDot version={null} />)).toBe("");
  });
});

describe("Check for Updates… from the version", () => {
  test("on the desktop app the version is a button to the Updates page, carrying the same dot and hint", () => {
    let opened = 0;
    const open = () => void opened++;
    const marked = renderToStaticMarkup(
      <VersionChip version="0.1.220" notesUnseen={false} updateAvailable="0.1.221" onOpen={open} />,
    );
    expect(marked).toStartWith('<button type="button" class="app-version" title="SpecDriven 0.1.221 is available">');
    expect(marked).toContain("v0.1.220");
    expect(marked).toContain('class="update-dot"');

    const quiet = renderToStaticMarkup(<VersionChip version="0.1.220" notesUnseen={false} updateAvailable={null} onOpen={open} />);
    expect(quiet).toContain('title="Check for Updates…"');
    expect(quiet).not.toContain("update-dot");

    const chip = VersionChip({ version: "0.1.220", notesUnseen: false, updateAvailable: null, onOpen: open }) as {
      props: { onClick: () => void };
    };
    chip.props.onClick();
    expect(opened).toBe(1);
  });

  test("elsewhere the version is plain text, no way to the Updates page", () => {
    const html = renderToStaticMarkup(<VersionChip version="0.1.220" notesUnseen={false} updateAvailable={null} />);
    expect(html).toStartWith('<span class="app-version">');
    expect(html).not.toContain("<button");
  });
});

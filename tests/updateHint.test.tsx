// specs/app/app-updates.feature.md "checks once a day" on the client: the
// version chip and the Check for Updates… menu item mark a newer release
// with a dot that names it on hover. Pure markup — no DOM.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { checkForUpdatesMenuItem, UpdateDot, updateTitle, VersionChip } from "../src/frontend/updateHint";

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

describe("Check for Updates… on the user menu", () => {
  test("carries the same dot and hint, and opens the Updates page", () => {
    let opened = 0;
    const item = checkForUpdatesMenuItem("0.1.221", () => void opened++);
    expect(item.id).toBe("updates");
    expect(item.title).toBe("SpecDriven 0.1.221 is available");
    const label = renderToStaticMarkup(<>{item.label}</>);
    expect(label).toContain("Check for Updates…");
    expect(label).toContain('class="update-dot"');
    item.onSelect?.();
    expect(opened).toBe(1);

    const quiet = checkForUpdatesMenuItem(null, () => {});
    expect(quiet.title).toBeUndefined();
    expect(renderToStaticMarkup(<>{quiet.label}</>)).not.toContain("update-dot");
  });
});

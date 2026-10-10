// Automates specs/editor/store-associated-files.feature.md in the browser:
// the editor pane's "Files" field and the scenario card's list — each file
// a download under its listed name, with rename, replace and remove, and an
// Upload button over the system's file picker.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ScenarioFileList,
  ScenarioFilesField,
  renameError,
  scenarioFileUrl,
} from "../src/frontend/ScenarioFilesField";
import { scenarioSignature } from "../src/frontend/App";
import type { Scenario } from "../src/server/parser";

const XML = { name: "policy holder.xml", file: "policy-holder-0123456789abcdef.xml", size: 3500 };
const CSV = { name: "people.csv", file: "people-fedcba9876543210.csv", size: 12 };

describe("the scenario card lists its files", () => {
  test("each as a download under its listed name, with its size", () => {
    const html = renderToStaticMarkup(<ScenarioFileList files={[XML, CSV]} />);
    expect(html).toContain(
      `href="/api/scenario-files/${XML.file}?name=policy%20holder.xml" download="policy holder.xml"`,
    );
    expect(html).toContain(">policy holder.xml</a>");
    expect(html).toContain(">3.4 KB</span>");
    expect(html).toContain(">12 B</span>");
  });

  test("a scenario with none shows no list", () => {
    expect(renderToStaticMarkup(<ScenarioFileList files={[]} />)).toBe("");
  });
});

describe("the Files field", () => {
  test("lists the files with rename, replace and remove, and an Upload button", () => {
    const html = renderToStaticMarkup(
      <ScenarioFilesField files={[XML]} onUpload={() => {}} onChange={() => {}} />,
    );
    expect(html).toContain(">policy holder.xml</a>");
    expect(html).toContain('aria-label="Download policy holder.xml"');
    expect(html).toContain('aria-label="Rename policy holder.xml"');
    expect(html).toContain('aria-label="Replace policy holder.xml"');
    expect(html).toContain('aria-label="Remove policy holder.xml"');
    expect(html).toContain("Upload files");
    // The standard system file picker, several files at once.
    expect(html).toMatch(/<input type="file" multiple="" hidden="" aria-label="Files to upload"/);
  });

  test("before the scenario is in the document the field waits, and says so", () => {
    const html = renderToStaticMarkup(
      <ScenarioFilesField
        files={[]}
        onUpload={() => {}}
        onChange={() => {}}
        disabled
        disabledHint="Files can be uploaded once the scenario has been saved."
      />,
    );
    expect(html).toContain("once the scenario has been saved");
    expect(html).toMatch(/<button type="button" class="link file-upload" disabled="">/);
  });

  test("a rename needs a name no other listed file has", () => {
    expect(renameError([XML, CSV], CSV.name, "holders.csv")).toBeNull();
    expect(renameError([XML, CSV], CSV.name, ` ${CSV.name} `)).toBeNull();
    expect(renameError([XML, CSV], CSV.name, XML.name)).toContain("already listed");
    expect(renameError([XML, CSV], CSV.name, "  ")).toBe("The file needs a name.");
  });

  test("the download url escapes the stored and the listed name", () => {
    expect(scenarioFileUrl({ ...CSV, name: "a&b.csv" })).toBe(`/api/scenario-files/${CSV.file}?name=a%26b.csv`);
  });

  test("a change to the files is nothing for autosave to save", () => {
    const s: Scenario = { name: "Basic", version: 1, status: "proposed", body: "b", tests: [] };
    expect(scenarioSignature({ ...s, files: [XML] }, 1)).toBe(scenarioSignature(s, 1));
  });
});

// Automates specs/app/custom-attributes.feature.md: `[<key>:<name>…:<value>]`
// lines under a feature's or a scenario's heading are lifted into
// `attributes`, written back right after the flag line, carried by the
// Automerge document like the flags, and editable on a published scenario
// without a new version.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, reloader } from "../src/server/api";
import {
  CUSTOM_ATTRIBUTES_FILE,
  EXAMPLE_ATTRIBUTE_DEFINITIONS,
  parseAttributeDefinitions,
} from "../src/server/customAttributes";
import { readCustomAttributes, writeCustomAttributes } from "../src/server/customAttributesFile";
import { conflictedFiles } from "../src/server/git";
import { syncDataDir } from "../src/server/reload";
import { writeState } from "../src/server/state";
import { twoClones } from "./helpers/fixtures";
import {
  createFeature,
  listFeatures,
  publishFeature,
  readFeature,
  readFeatureView,
  saveFeature,
} from "../src/server/features";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { importFeatureDoc, reconcile } from "../src/server/automerge/reconcile";
import { docToFeature, projectFeature } from "../src/server/automerge/project";
import { threeWayFeature } from "../src/server/automerge/merge";
import {
  formatAttribute,
  formatAttributeLines,
  isAttribute,
  parseAttributeToken,
  parseFeature,
  parseMetadataTokens,
  serializeFeature,
  type Feature,
} from "../src/server/parser";

const RULED = `# Quote

[br:young-driver-surcharge:on] [br:max-claims:3]
[line:auto]

Price a policy.

## Young driver pays a surcharge @v1 [published]

[ff:new-quote:on]

[br:young-driver-surcharge:on]
[br-sub:young-driver-surcharge:under-21:1.5]

- Given: a driver under 21
- Then: the premium carries a surcharge
`;

// What the app writes: the scenario numbered by its position (parser.ts
// `S<n>:`); parsing either form gives the same feature.
const WRITTEN = RULED.replace("## Young driver", "## S1: Young driver");

test("attribute lines under the headings are lifted into attributes and written back as they were", () => {
  const feature = parseFeature(RULED);
  expect(feature.attributes).toEqual([
    { key: "br", names: ["young-driver-surcharge"], value: "on" },
    { key: "br", names: ["max-claims"], value: "3" },
    { key: "line", names: [], value: "auto" },
  ]);
  expect(feature.description).toBe("Price a policy.");
  const s = feature.scenarios[0]!;
  expect(s.flags).toEqual([{ name: "new-quote", on: true }]);
  expect(s.attributes).toEqual([
    { key: "br", names: ["young-driver-surcharge"], value: "on" },
    { key: "br-sub", names: ["young-driver-surcharge", "under-21"], value: "1.5" },
  ]);
  expect(s.body).toBe("- Given: a driver under 21\n- Then: the premium carries a surcharge");
  expect(serializeFeature(feature)).toBe(WRITTEN);
});

test("a line may mix flag and attribute tokens, among the link and authorship lines in any order", () => {
  const feature = parseFeature(
    "# F\n\n## S @v1 [proposed]\n\n**Created by:** ada\n[ff:a:ON] [br:Young driver:on]\n[Jira:X-1](https://x.test/X-1)\n[line:boat]\n\nbody\n",
  );
  const s = feature.scenarios[0]!;
  expect(s.flags).toEqual([{ name: "a", on: true }]);
  // Inner spaces are part of a segment.
  expect(s.attributes).toEqual([
    { key: "br", names: ["Young driver"], value: "on" },
    { key: "line", names: [], value: "boat" },
  ]);
  expect(s.link?.ticket).toBe("X-1");
  expect(s.createdBy).toBe("ada");
  expect(s.body).toBe("body");
  // Flags on their line, then the attributes, a new line wherever the key changes.
  expect(serializeFeature(feature)).toBe(
    "# F\n\n## S1: S @v1 [proposed]\n\n[ff:a:on]\n\n[br:Young driver:on]\n[line:boat]\n\n[Jira:X-1](https://x.test/X-1)\n\n**Created by:** ada\n\nbody\n",
  );
});

test("text that only looks like a token stays text", () => {
  for (const line of [
    "[note: x]",
    "[test: https://github.com/a/b/blob/main/t.ts#L1 ]",
    "- [x] done",
    "[^1]: a footnote",
    "[TODO:fix]",
    "[Jira:ABC-1](https://x.test/ABC-1)",
    "[https://example.com]",
    "[br:a:on] and more",
    "[br::on]",
    "[br:a :on]",
    "    [br:a:on]",
    // A malformed flag makes the whole line text, attributes and all.
    "[ff:a:maybe] [br:a:on]",
  ]) {
    expect(parseMetadataTokens(line)).toBeNull();
  }
  const feature = parseFeature("# F\n\nRuled by [br:a:on] today.\n\n## S @v1 [proposed]\n\nbody\n\n[br:late:on]\n");
  expect(feature.attributes).toBeUndefined();
  expect(feature.description).toBe("Ruled by [br:a:on] today.");
  expect(feature.scenarios[0]!.attributes).toBeUndefined();
  expect(feature.scenarios[0]!.body).toBe("body\n\n[br:late:on]");
  // An upper-case FF is still a flag.
  expect(parseMetadataTokens("[FF:x:ON] [br:a:on]")).toEqual({
    flags: [{ name: "x", on: true }],
    attributes: [{ key: "br", names: ["a"], value: "on" }],
  });
});

test("an exact duplicate is dropped, the same attribute with another value is kept", () => {
  const feature = parseFeature("# F\n\n[br:a:on] [br:a:on]\n[br:a:on] [br:a:off]\n");
  expect(feature.attributes).toEqual([
    { key: "br", names: ["a"], value: "on" },
    { key: "br", names: ["a"], value: "off" },
  ]);
});

test("only attributes the token can carry are written", () => {
  expect(parseAttributeToken("[br-sub:a:b:1.5]")).toEqual({ key: "br-sub", names: ["a", "b"], value: "1.5" });
  expect(parseAttributeToken("[test:a]")).toBeNull();
  expect(isAttribute({ key: "br", names: ["a"], value: "on" })).toBe(true);
  for (const bad of [
    { key: "Br", names: [], value: "x" },
    { key: "ff", names: ["a"], value: "on" },
    { key: "br", names: ["a:b"], value: "on" },
    { key: "br", names: [" a"], value: "on" },
    { key: "br", names: [], value: "" },
  ]) {
    expect(isAttribute(bad)).toBe(false);
  }
  expect(formatAttribute({ key: "line", names: [], value: "auto" })).toBe("[line:auto]");
  expect(
    formatAttributeLines([
      { key: "br", names: ["a"], value: "on" },
      { key: "br", names: ["a]"], value: "on" },
      { key: "line", names: [], value: "auto" },
      { key: "br", names: ["b"], value: "off" },
    ]),
  ).toBe("[br:a:on]\n[line:auto]\n[br:b:off]");
});

test("the document carries the attributes and projects them back", () => {
  const doc = importFeatureDoc(parseFeature(RULED));
  expect(doc.attributes?.map(formatAttribute)).toEqual([
    "[br:young-driver-surcharge:on]",
    "[br:max-claims:3]",
    "[line:auto]",
  ]);
  expect(docToFeature(doc).scenarios[0]!.attributes?.map((a) => a.key)).toEqual(["br", "br-sub"]);
  expect(projectFeature(doc, { publishExternalLinks: true })).toBe(WRITTEN);
  // Changing them is an edit the document records.
  const edited = parseFeature(RULED.replace("[br:max-claims:3]", "[br:max-claims:4]"));
  const next = reconcile(doc, edited);
  expect(next.attributes?.[1]).toEqual({ key: "br", names: ["max-claims"], value: "4" });
});

test("a three-way merge keeps the side that changed the attributes", () => {
  const base = parseFeature(RULED);
  const change = (f: Feature): Feature => ({
    ...f,
    scenarios: f.scenarios.map((s) => ({
      ...s,
      attributes: [{ key: "br", names: ["young-driver-surcharge"], value: "off" }],
    })),
  });
  const theirs = change(base);
  const merged = threeWayFeature(base, base, theirs);
  expect(merged.ok).toBe(true);
  if (merged.ok) {
    expect(merged.feature.scenarios[0]!.attributes).toEqual([
      { key: "br", names: ["young-driver-surcharge"], value: "off" },
    ]);
    expect(merged.feature.attributes).toEqual(base.attributes);
  }
  // Ours wins when both changed them.
  const ours = { ...base, attributes: [{ key: "line", names: [], value: "boat" }] };
  const both = threeWayFeature(base, ours, { ...base, attributes: [{ key: "line", names: [], value: "home" }] });
  expect(both.ok && both.feature.attributes).toEqual([{ key: "line", names: [], value: "boat" }]);
  // An attribute change is an edit: the other side deleting that scenario is a conflict.
  expect(threeWayFeature(base, theirs, { ...base, scenarios: [] }).ok).toBe(false);
});

test("a published body recorded with its attribute line still in it does not block a save", () => {
  // An older build kept the token line as text, so the document recorded it in the body.
  const old = parseFeature(RULED);
  const s = old.scenarios[0]!;
  const recorded: Feature = {
    ...old,
    scenarios: [{ ...s, attributes: undefined, flags: undefined, body: `[ff:new-quote:on]\n\n[br:young-driver-surcharge:on]\n\n${s.body}` }],
  };
  const doc = importFeatureDoc(recorded);
  // Today's parse lifts the lines off; the gate takes that as the same body.
  const next = reconcile(doc, old);
  expect(next.specs[0]!.body).toBe(s.body);
  expect(next.specs[0]!.attributes?.length).toBe(2);
  // A real change to the text is still refused.
  expect(() => reconcile(doc, { ...old, scenarios: [{ ...s, body: "tampered" }] })).toThrow(
    /published and immutable/,
  );
});

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-custom-attributes-"));
  // An empty home keeps the developer's own settings file out of the test.
  home = await mkdtemp(join(tmpdir(), "specdriven-custom-attributes-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
});

afterEach(async () => {
  reloader.stop();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("an attribute on a published scenario changes without a new version", async () => {
  const file = "specs/quote.feature.md";
  await createFeature(data, "Quote");
  await saveFeature(data, file, "# Quote\n\n## Basic @v1\n\nbody\n");
  await publishFeature(data, file, (await readFeature(data, file))!, { name: "Basic", version: 1 });

  const ruled = (await readFeature(data, file))!.replace(
    "## S1: Basic @v1 [published]\n",
    "## S1: Basic @v1 [published]\n\n[br:max-claims:3]\n",
  );
  await saveFeature(data, file, ruled);
  const text = (await readFeature(data, file))!;
  expect(text).toContain("## S1: Basic @v1 [published]\n\n[br:max-claims:3]\n\nbody");
  const doc = (await loadFeatureDoc(data, file))!.doc;
  expect(doc.specs[0]!.attributes).toEqual([{ key: "br", names: ["max-claims"], value: "3" }]);
  expect(doc.specs[0]!.version).toBe(1);
  expect(doc.specs[0]!.status).toBe("published");

  await saveFeature(data, file, text.replace("[br:max-claims:3]", "[br:max-claims:4]"));
  expect(await readFeature(data, file)).toContain("[br:max-claims:4]");
  // The body still may not change.
  await expect(
    saveFeature(data, file, (await readFeature(data, file))!.replace("body", "other")),
  ).rejects.toThrow(/published and immutable/);
});

test("a draft's attributes reach the editor from the document", async () => {
  const file = "specs/quote.feature.md";
  await createFeature(data, "Quote");
  await saveFeature(data, file, "# Quote\n\n## Basic @v1 [draft]\n\n[line:boat]\n\nbody\n");
  const view = (await readFeatureView(data, file))!;
  expect(view.parsed.scenarios[0]!.attributes).toEqual([{ key: "line", names: [], value: "boat" }]);
});

const put = async (body: unknown) =>
  (await handleApi(
    new Request("http://localhost/api/custom-attributes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  ))!;

test("the definitions are read with the listing and written by Settings", async () => {
  await mkdir(data, { recursive: true });
  await writeState({ dataRepo: data }, root);
  const listing = async () =>
    (await (await handleApi(new Request("http://localhost/api/features")))!.json()) as {
      customAttributes: string;
    };
  expect((await listing()).customAttributes).toBe("");
  const res = await put({ content: EXAMPLE_ATTRIBUTE_DEFINITIONS });
  expect(res.status).toBe(200);
  expect(await readFile(join(data, CUSTOM_ATTRIBUTES_FILE), "utf8")).toBe(EXAMPLE_ATTRIBUTE_DEFINITIONS);
  expect((await listing()).customAttributes).toBe(EXAMPLE_ATTRIBUTE_DEFINITIONS);
  // Saved even with problems: a broken definition is only left out where it is read.
  expect((await put({ content: "[br:on||off]\n" })).status).toBe(200);
  expect((await put({})).status).toBe(400);
  expect((await put({ content: "#".repeat(64 * 1024 + 1) })).status).toBe(400);
});

test("a save folds in a disk edit Settings has not shown", async () => {
  await mkdir(data, { recursive: true });
  const base = "[br:<rule>:on|off]\n";
  await writeCustomAttributes(data, base);
  // A teammate's definition arrives on disk; Settings, still on the base, adds its own.
  await writeFile(join(data, CUSTOM_ATTRIBUTES_FILE), `# from a teammate\n${base}`);
  const written = await writeCustomAttributes(data, `${base}[line:auto|home]\n`, base);
  expect(written).toBe(`# from a teammate\n${base}[line:auto|home]\n`);
  expect(await readCustomAttributes(data)).toBe(written);
});

test("the listing carries the feature's and the scenarios' attributes", async () => {
  await createFeature(data, "Quote");
  await saveFeature(data, "specs/quote.feature.md", RULED);
  const [listed] = await listFeatures(data);
  expect(listed!.attributes?.map(formatAttribute)).toEqual([
    "[br:young-driver-surcharge:on]",
    "[br:max-claims:3]",
    "[line:auto]",
  ]);
  expect(listed!.scenarios[0]!.attributes?.map(formatAttribute)).toEqual([
    "[br:young-driver-surcharge:on]",
    "[br-sub:young-driver-surcharge:under-21:1.5]",
  ]);
});

test("two teammates adding definitions at once merge on the next sync", async () => {
  const base = "[br:<rule>:on|off]\n";
  const { a, b } = await twoClones(join(root, "clones"), { [CUSTOM_ATTRIBUTES_FILE]: base });
  // Both append at the end, so git cannot merge the two lines on its own.
  await writeFile(join(a, CUSTOM_ATTRIBUTES_FILE), `${base}[line:auto|home]\n`);
  await writeFile(join(b, CUSTOM_ATTRIBUTES_FILE), `${base}[claims:<n:number>]\n`);
  await syncDataDir(a);
  // The first tick commits b's edit, the second pulls a's and merges the two.
  await syncDataDir(b);
  await syncDataDir(b);
  expect(await conflictedFiles(b)).toEqual([]);
  const merged = await readFile(join(b, CUSTOM_ATTRIBUTES_FILE), "utf8");
  expect(merged).not.toContain("<<<<<<<");
  expect(parseAttributeDefinitions(merged).list.map((d) => d.key).sort()).toEqual(["br", "claims", "line"]);
  // And a gets the same file back.
  await syncDataDir(a);
  expect(await readFile(join(a, CUSTOM_ATTRIBUTES_FILE), "utf8")).toBe(merged);
});

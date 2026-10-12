// Automates specs/external-links/aha-and-figma-links.feature.md on the
// server: Aha! and Figma links live on the feature's Automerge document — at
// the feature level and per scenario, each tool in its own list — and never
// in the `.feature.md`; the editor's view folds them in; every
// markdown-driven write leaves them alone; Settings switches each tool on.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "@automerge/automerge";
import { handleApi, reloader } from "../src/server/api";
import {
  createFeature,
  moveScenario,
  publishFeature,
  readFeature,
  readFeatureView,
  saveFeature,
  savePullRequests,
  saveResourceLinks,
} from "../src/server/features";
import { loadFeatureDoc } from "../src/server/automerge/store";
import { docToFeature, projectFeature } from "../src/server/automerge/project";
import { importFeatureDoc, setPullRequests, setResourceLinks } from "../src/server/automerge/reconcile";
import { importDrift } from "../src/server/automerge/driftSync";
import { parseFeature, serializeFeature } from "../src/server/parser";
import {
  canAddResourceLink,
  isOwnResourceUrl,
  isResourceLinkKind,
  resourceChipLabel,
  resourceLinkLabel,
  resourceNameFromUrl,
} from "../src/server/resourceLinks";
import { normalizeResourceLinks, readState, writeState } from "../src/server/state";

const AHA1 = { url: "https://acme.aha.io/features/APP-123", title: "Quote engine" };
const AHA2 = { url: "https://acme.ideas.aha.io/ideas/APP-I-7", title: "" };
const FIG1 = { url: "https://www.figma.com/design/abc123/Quote-flow?node-id=1-2", title: "" };
const FIG2 = { url: "https://www.figma.com/proto/def456/Emails", title: "Quote emails" };
const FILE = "specs/quote-policy.feature.md";

const SAMPLE = `# Quote Policy

Quotes for potential customers.

## Basic Quote @v1 [proposed]

- **Given** a potential customer has an account
- **Then** a quote is provided

## Declined Quote @v2 [proposed]

- **Given** the customer has no account
`;

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-resources-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-resources-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  await createFeature(data, "Quote Policy");
  await saveFeature(data, FILE, SAMPLE);
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

const BASIC = { name: "Basic Quote", version: 1 };

// --- the url ----------------------------------------------------------------

describe("an Aha! or Figma url", () => {
  test("the name an Aha! url gives away is its reference number", () => {
    expect(resourceNameFromUrl("aha", AHA1.url)).toBe("APP-123");
    expect(resourceNameFromUrl("aha", AHA2.url)).toBe("APP-I-7");
    expect(resourceNameFromUrl("aha", "https://acme.aha.io/epics/APP-E-12")).toBe("APP-E-12");
    expect(resourceNameFromUrl("aha", "https://acme.aha.io/requirements/APP-123-1")).toBe("APP-123-1");
    expect(resourceNameFromUrl("aha", "https://acme.aha.io/roadmaps")).toBeNull();
  });

  test("the name a Figma url gives away is the file's", () => {
    expect(resourceNameFromUrl("figma", FIG1.url)).toBe("Quote flow");
    expect(resourceNameFromUrl("figma", "https://www.figma.com/file/k3y/Checkout%20v2")).toBe("Checkout v2");
    expect(resourceNameFromUrl("figma", "https://www.figma.com/board/k3y")).toBeNull();
    expect(resourceNameFromUrl("figma", "not a url")).toBeNull();
  });

  test("the label is the title, else the name from the url, and never empty", () => {
    expect(resourceLinkLabel("aha", AHA1)).toBe("Quote engine");
    expect(resourceLinkLabel("aha", AHA2)).toBe("APP-I-7");
    expect(resourceLinkLabel("figma", FIG1)).toBe("Quote flow");
    expect(resourceLinkLabel("figma", { url: "https://example.com/specs/a", title: "" })).toBe(
      "example.com/specs/a",
    );
    expect(resourceLinkLabel("aha", { url: "not a url", title: "" })).toBe("not a url");
  });

  test("a url on another site is still a link, but not the tool's own", () => {
    expect(isOwnResourceUrl("aha", AHA1.url)).toBe(true);
    expect(isOwnResourceUrl("aha", AHA2.url)).toBe(true);
    expect(isOwnResourceUrl("figma", FIG1.url)).toBe(true);
    expect(isOwnResourceUrl("figma", AHA1.url)).toBe(false);
    expect(isOwnResourceUrl("aha", "https://ideas.acme.com/ideas/APP-I-7")).toBe(false);
    expect(canAddResourceLink([], "https://ideas.acme.com/ideas/APP-I-7")).toBe(true);
  });

  test("only an http(s) url the list does not already hold can be added", () => {
    expect(canAddResourceLink([AHA1], AHA2.url)).toBe(true);
    expect(canAddResourceLink([AHA1], ` ${AHA1.url} `)).toBe(false);
    expect(canAddResourceLink([], "javascript:alert(1)")).toBe(false);
    expect(canAddResourceLink([], "APP-123")).toBe(false);
    expect(canAddResourceLink([], "")).toBe(false);
  });

  test("the chip counts the links, or offers to link one", () => {
    expect(resourceChipLabel("aha", 0)).toBe("Link Aha!");
    expect(resourceChipLabel("aha", 1)).toBe("1 Aha! link");
    expect(resourceChipLabel("figma", 2)).toBe("2 Figma links");
  });

  test("only aha and figma are kinds", () => {
    expect(isResourceLinkKind("aha")).toBe(true);
    expect(isResourceLinkKind("figma")).toBe(true);
    expect(isResourceLinkKind("prs")).toBe(false);
    expect(isResourceLinkKind(undefined)).toBe(false);
  });
});

// --- the document operation ---------------------------------------------------

describe("setResourceLinks on the document", () => {
  const fresh = () => importFeatureDoc(parseFeature(SAMPLE));

  test("each tool is its own list, beside the pull requests", () => {
    let doc = setResourceLinks(fresh(), BASIC, "aha", [AHA1])!;
    doc = setResourceLinks(doc, BASIC, "figma", [FIG1])!;
    doc = setPullRequests(doc, BASIC, [{ url: "https://github.com/a/b/pull/1", title: "" }])!;
    const basic = docToFeature(doc).scenarios[0]!;
    expect(basic.aha).toEqual([AHA1]);
    expect(basic.figma).toEqual([FIG1]);
    expect(basic.prs).toHaveLength(1);
    doc = setResourceLinks(doc, BASIC, "aha", [])!;
    const after = docToFeature(doc).scenarios[0]!;
    expect(after.aha).toBeUndefined();
    expect(after.figma).toEqual([FIG1]);
  });

  test("a scenario by its document id; the feature itself is target null; a missing one is null", () => {
    const doc = fresh();
    const id = doc.specs[1]!.id;
    const byId = setResourceLinks(doc, { name: "renamed", version: 9, id }, "figma", [FIG2])!;
    expect(docToFeature(byId).scenarios[1]!.figma).toEqual([FIG2]);
    const feature = setResourceLinks(fresh(), null, "aha", [AHA1])!;
    expect(docToFeature(feature).aha).toEqual([AHA1]);
    expect(docToFeature(feature).scenarios.every((s) => s.aha === undefined)).toBe(true);
    expect(setResourceLinks(fresh(), { name: "Nope", version: 1 }, "aha", [AHA1])).toBeNull();
  });

  test("two peers linking different records concurrently end with both", () => {
    const base = setResourceLinks(fresh(), BASIC, "aha", [])!;
    const a = setResourceLinks(A.clone(base), BASIC, "aha", [AHA1])!;
    const b = setResourceLinks(A.clone(base), BASIC, "aha", [AHA2])!;
    const urls = A.merge(a, b).specs[0]!.aha!.map((l) => l.url).sort();
    expect(urls).toEqual([AHA1.url, AHA2.url].sort());
  });

  test("the projection never carries them", () => {
    let doc = setResourceLinks(fresh(), BASIC, "aha", [AHA1])!;
    doc = setResourceLinks(doc, null, "figma", [FIG1])!;
    expect(projectFeature(doc)).toBe(projectFeature(fresh()));
    expect(serializeFeature(docToFeature(doc))).not.toContain("aha.io");
    expect(serializeFeature(docToFeature(doc))).not.toContain("figma.com");
  });
});

// --- through the feature module -----------------------------------------------

describe("saveResourceLinks", () => {
  test("the document holds the links, the file does not, the editor sees them", async () => {
    const before = (await readFeature(data, FILE))!;
    const saved = await saveResourceLinks(data, FILE, BASIC, "aha", [AHA1, AHA2]);
    expect(saved.status).toBe("saved");
    expect(saved.message).toBe("Aha! links saved locally");
    expect(saved.parsed.scenarios[0]!.aha).toEqual([AHA1, AHA2]);
    expect(saved.content).toBe(before);
    await saveResourceLinks(data, FILE, null, "figma", [FIG1]);
    const view = (await readFeatureView(data, FILE))!;
    expect(view.parsed.scenarios[0]!.aha).toEqual([AHA1, AHA2]);
    expect(view.parsed.scenarios[1]!.aha).toBeUndefined();
    expect(view.parsed.figma).toEqual([FIG1]);
    expect(await readFeature(data, FILE)).toBe(before);
  });

  test("a draft scenario can carry links too", async () => {
    await saveFeature(data, FILE, SAMPLE + "\n## Sketch @v1 [draft]\n\nsoon\n");
    await saveResourceLinks(data, FILE, { name: "Sketch", version: 1 }, "figma", [FIG2]);
    const sketch = (await readFeatureView(data, FILE))!.parsed.scenarios.find((s) => s.name === "Sketch")!;
    expect(sketch.figma).toEqual([FIG2]);
  });

  test("a scenario the document lacks is refused", async () => {
    await expect(
      saveResourceLinks(data, FILE, { name: "Nope", version: 1 }, "aha", [AHA1]),
    ).rejects.toThrow('Scenario "Nope" @v1 not found');
  });
});

describe("the links survive everything the markdown does", () => {
  beforeEach(async () => {
    await saveResourceLinks(data, FILE, BASIC, "aha", [AHA1]);
    await saveResourceLinks(data, FILE, BASIC, "figma", [FIG1]);
    await saveResourceLinks(data, FILE, null, "figma", [FIG2]);
  });

  test("a save that edits the body", async () => {
    const saved = await saveFeature(data, FILE, SAMPLE.replace("is provided", "is emailed"));
    expect(saved.parsed.scenarios[0]!.aha).toEqual([AHA1]);
    expect(saved.parsed.scenarios[0]!.figma).toEqual([FIG1]);
    expect(saved.parsed.figma).toEqual([FIG2]);
  });

  test("publishing", async () => {
    await publishFeature(data, FILE, (await readFeature(data, FILE))!, BASIC);
    const view = (await readFeatureView(data, FILE))!;
    expect(view.parsed.scenarios[0]!.status).toBe("published");
    expect(view.parsed.scenarios[0]!.aha).toEqual([AHA1]);
    expect(view.parsed.figma).toEqual([FIG2]);
  });

  test("an outside edit absorbed as drift", async () => {
    const edited = SAMPLE.replace("is provided", "is mailed");
    await Bun.write(join(data, FILE), edited);
    expect(await importDrift(data)).toContain("absorbed 1");
    const view = (await readFeatureView(data, FILE))!;
    expect(view.parsed.scenarios[0]!.figma).toEqual([FIG1]);
    expect(view.parsed.figma).toEqual([FIG2]);
  });

  test("a scenario moved to another feature takes them along", async () => {
    await createFeature(data, "Order");
    const ORDER = "specs/order.feature.md";
    await savePullRequests(data, FILE, BASIC, [{ url: "https://github.com/a/b/pull/1", title: "" }]);
    await moveScenario(data, FILE, BASIC, ORDER);
    const moved = (await readFeatureView(data, ORDER))!.parsed.scenarios.find(
      (s) => s.name === "Basic Quote",
    )!;
    expect(moved.aha).toEqual([AHA1]);
    expect(moved.figma).toEqual([FIG1]);
    expect(moved.prs).toHaveLength(1);
    expect(await readFeature(data, ORDER)).not.toContain("aha.io");
  });
});

// --- the routes ---------------------------------------------------------------

describe("PUT /api/features/:file/links/:kind", () => {
  const put = (kind: string, body: unknown) =>
    handleApi(
      new Request(`http://localhost/api/features/${encodeURIComponent(FILE)}/links/${kind}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  beforeEach(async () => {
    await writeState({ dataRepo: data }, root);
  });

  test("links a scenario, then the feature, answering with the editor's view", async () => {
    const res = (await put("aha", { scenario: { ...BASIC }, links: [AHA1] }))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parsed: { scenarios: { aha?: unknown }[] } };
    expect(body.parsed.scenarios[0]!.aha).toEqual([AHA1]);
    const feature = (await put("figma", { links: [FIG1] }))!;
    expect(feature.status).toBe(200);
    expect(((await feature.json()) as { parsed: { figma?: unknown } }).parsed.figma).toEqual([FIG1]);
  });

  test("an unknown tool, a bad url and an unknown scenario are refused", async () => {
    expect((await put("jira", { links: [AHA1] }))!.status).toBe(404);
    expect((await put("aha", { links: [{ url: "javascript:alert(1)", title: "" }] }))!.status).toBe(400);
    expect((await put("aha", { links: "nope" }))!.status).toBe(400);
    const missing = (await put("aha", { scenario: { name: "Nope", version: 1 }, links: [AHA1] }))!;
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain("not found");
  });
});

describe("the Aha! and Figma settings", () => {
  test("are off unless explicitly turned on", () => {
    expect(normalizeResourceLinks(undefined)).toBe(false);
    expect(normalizeResourceLinks(false)).toBe(false);
    expect(normalizeResourceLinks("yes")).toBe(false);
    expect(normalizeResourceLinks(true)).toBe(true);
  });

  test("each switch round-trips through the settings file", async () => {
    await writeState({ dataRepo: data }, root);
    const settings = async (patch: Record<string, unknown>) =>
      (await handleApi(
        new Request("http://localhost/api/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }),
      ))!;
    const on = await settings({ ahaLinks: true });
    expect(on.status).toBe(200);
    const state = (await on.json()) as { ahaLinks: boolean; figmaLinks: boolean };
    expect(state.ahaLinks).toBe(true);
    expect(state.figmaLinks).toBe(false);
    expect((await readState(root)).ahaLinks).toBe(true);
    await settings({ figmaLinks: true });
    expect((await readState(root)).figmaLinks).toBe(true);
    // Off is the default, stored as an absent key.
    const off = await settings({ ahaLinks: false });
    expect(((await off.json()) as { ahaLinks: boolean }).ahaLinks).toBe(false);
    expect((await readState(root)).ahaLinks).toBeUndefined();
    expect((await settings({ figmaLinks: "yes" })).status).toBe(400);
  });

  test("turning a tool off keeps the links already recorded", async () => {
    await writeState({ dataRepo: data, ahaLinks: true }, root);
    await saveResourceLinks(data, FILE, BASIC, "aha", [AHA1]);
    await writeState({ dataRepo: data }, root);
    expect((await readFeatureView(data, FILE))!.parsed.scenarios[0]!.aha).toEqual([AHA1]);
  });
});

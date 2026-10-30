// Automates specs/external-links/project-management-jira-linear-etc.feature.md
// "Several tickets on a feature" on the server: the tickets route takes the
// whole list — at most five, no repeats, tickets only — and saves it the way
// the editor saves, so the file carries one line per ticket while links are
// published and none while they are not, and the editor's view has them
// either way.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "@automerge/automerge";
import { handleApi, reloader } from "../src/server/api";
import { createFeature, readFeature, readFeatureView, saveFeature, saveFeatureTickets } from "../src/server/features";
import { loadFeatureDoc, saveFeatureDoc } from "../src/server/automerge/store";
import { docToFeature, projectionOptions, setProjectionOptions } from "../src/server/automerge/project";
import { formatExternalLink, MAX_FEATURE_TICKETS, parseFeature } from "../src/server/parser";
import { writeState } from "../src/server/state";

const FILE = "specs/quote-policy.feature.md";
const ticket = (n: number) => ({ program: "Jira", ticket: `ABC-${n}`, url: `https://acme.atlassian.net/browse/ABC-${n}` });
const T1 = ticket(1);
const T2 = ticket(2);

const SAMPLE = `# Quote Policy

Quotes for potential customers.

## Basic Quote @v1 [proposed]

- **Given** a potential customer has an account
- **Then** a quote is provided
`;
const WRITTEN = SAMPLE.replace("## Basic Quote", "## S1: Basic Quote");
const withTickets = (text: string, tickets: { program: string; ticket: string; url: string }[]) =>
  text.replace("# Quote Policy\n\n", `# Quote Policy\n\n${tickets.map(formatExternalLink).join("\n")}\n\n`);

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;
const defaults = projectionOptions();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-tickets-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-tickets-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  data = join(root, "data");
  await createFeature(data, "Quote Policy");
  await saveFeature(data, FILE, SAMPLE);
  await writeState({ dataRepo: data }, root);
});

afterEach(async () => {
  reloader.stop();
  setProjectionOptions(defaults);
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

const docLinks = async () => docToFeature((await loadFeatureDoc(data, FILE))!.doc).links;

describe("saveFeatureTickets", () => {
  test("sets the list — the document holds it, the file one line each, the view has them", async () => {
    const saved = await saveFeatureTickets(data, FILE, [T1, T2]);
    expect(saved.status).toBe("saved");
    expect(saved.message).toBe("tickets saved locally");
    expect(saved.parsed.links).toEqual([T1, T2]);
    expect(await docLinks()).toEqual([T1, T2]);
    expect(await readFeature(data, FILE)).toBe(withTickets(WRITTEN, [T1, T2]));
    // Removing one, then all, through the same door.
    expect((await saveFeatureTickets(data, FILE, [T2])).parsed.links).toEqual([T2]);
    expect(await readFeature(data, FILE)).toBe(withTickets(WRITTEN, [T2]));
    expect((await saveFeatureTickets(data, FILE, [])).parsed.links).toBeUndefined();
    expect(await docLinks()).toBeUndefined();
    expect(await readFeature(data, FILE)).toBe(WRITTEN);
  });

  test("with Publish external links off the file stays bare and the view still has them", async () => {
    setProjectionOptions({ publishExternalLinks: false });
    const saved = await saveFeatureTickets(data, FILE, [T1, T2]);
    expect(saved.parsed.links).toEqual([T1, T2]);
    expect(await readFeature(data, FILE)).toBe(WRITTEN);
    expect(await docLinks()).toEqual([T1, T2]);
    expect((await readFeatureView(data, FILE))!.parsed.links).toEqual([T1, T2]);
  });

  test("the description and the rest of the feature survive, since the server's fresh view is what is saved", async () => {
    // A hand edit on disk between saves is folded in like any save folds it.
    await Bun.write(join(data, FILE), WRITTEN.replace("potential customers", "every customer"));
    const saved = await saveFeatureTickets(data, FILE, [T1]);
    expect(saved.parsed.description).toBe("Quotes for every customer.");
    expect(saved.parsed.links).toEqual([T1]);
    expect(saved.parsed.scenarios.map((s) => s.name)).toEqual(["Basic Quote"]);
  });

  test("refuses a sixth, a repeat, a malformed ticket and a qTest or Confluence link", async () => {
    const six = [1, 2, 3, 4, 5, 6].map(ticket);
    await expect(saveFeatureTickets(data, FILE, six)).rejects.toThrow(`up to ${MAX_FEATURE_TICKETS}`);
    await expect(saveFeatureTickets(data, FILE, six.slice(0, 5))).resolves.toBeDefined();
    await expect(saveFeatureTickets(data, FILE, [T1, { ...T1, ticket: "abc-1" }])).rejects.toThrow("twice");
    await expect(saveFeatureTickets(data, FILE, [{ ...T1, ticket: "a]b" }])).rejects.toThrow("Not a ticket");
    await expect(saveFeatureTickets(data, FILE, [{ ...T1, program: "qTest" }])).rejects.toThrow("not tickets");
    await expect(saveFeatureTickets(data, FILE, [{ ...T1, program: "Confluence" }])).rejects.toThrow("not tickets");
    // The five stayed.
    expect((await docLinks())!.length).toBe(5);
  });

  test("a document from before the list is migrated by the first change", async () => {
    const loaded = (await loadFeatureDoc(data, FILE))!;
    const legacy = A.change(loaded.doc, (d) => {
      d.link = { ...T1 };
    });
    await saveFeatureDoc(data, FILE, legacy, loaded.heads);
    expect((await readFeatureView(data, FILE))!.parsed.links).toEqual([T1]);
    await saveFeatureTickets(data, FILE, [T1, T2]);
    const after = (await loadFeatureDoc(data, FILE))!.doc;
    expect(after.link).toBeUndefined();
    expect(docToFeature(after).links).toEqual([T1, T2]);
  });
});

describe("PUT /api/features/:file/tickets", () => {
  const put = (body: unknown) =>
    handleApi(
      new Request(`http://localhost/api/features/${encodeURIComponent(FILE)}/tickets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("sets the tickets, answering with the editor's view", async () => {
    const res = (await put({ links: [{ ...T1, url: ` ${T1.url} ` }, T2] }))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parsed: { links?: unknown }; content: string; message: string };
    expect(body.parsed.links).toEqual([T1, T2]);
    expect(parseFeature(body.content).links).toEqual([T1, T2]);
    expect(body.message).toBe("tickets saved locally");
    expect(await readFeature(data, FILE)).toBe(withTickets(WRITTEN, [T1, T2]));
  });

  test("a malformed body, a non-http url, a sixth and a repeat are 400s with a reason", async () => {
    expect((await put({ links: "no" }))!.status).toBe(400);
    expect((await put({}))!.status).toBe(400);
    expect((await put({ links: [{ program: "Jira", ticket: "X-1", url: "javascript:alert(1)" }] }))!.status).toBe(400);
    const six = (await put({ links: [1, 2, 3, 4, 5, 6].map(ticket) }))!;
    expect(six.status).toBe(400);
    expect(((await six.json()) as { error: string }).error).toContain("up to 5");
    const twice = (await put({ links: [T1, T1] }))!;
    expect(twice.status).toBe(400);
    expect(((await twice.json()) as { error: string }).error).toContain("twice");
    expect(await docLinks()).toBeUndefined();
  });
});

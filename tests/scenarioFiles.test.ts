// Automates specs/editor/store-associated-files.feature.md on the server
// ("CRUD on files for each scenario"): uploaded files land as
// content-addressed files under `.files/` in the data repo; each scenario's
// list of them — names, stored files, sizes — lives on the feature's
// Automerge document and never in the `.feature.md`; the routes create,
// read, rename, replace and delete them.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  saveScenarioFiles,
} from "../src/server/features";
import { projectFeature, docToFeature } from "../src/server/automerge/project";
import { importFeatureDoc, setScenarioFiles } from "../src/server/automerge/reconcile";
import { importDrift } from "../src/server/automerge/driftSync";
import { parseFeature, serializeFeature } from "../src/server/parser";
import type { ScenarioFile } from "../src/server/parser";
import {
  FILES_DIR,
  MAX_FILE_BYTES,
  readScenarioFile,
  storeScenarioFile,
} from "../src/server/scenarioFiles";
import {
  fileDisplayName,
  formatFileSize,
  isStoredFileName,
  validScenarioFiles,
} from "../src/server/scenarioFileList";
import { writeState } from "../src/server/state";

const FILE = "specs/quote-policy.feature.md";
const SAMPLE = `# Quote Policy

Quotes for potential customers.

## Basic Quote @v1 [proposed]

- **Given** a potential customer has an account
- **Then** a quote is provided

## Declined Quote @v2 [proposed]

- **Given** the customer has no account
`;
// What the app writes: the same text with each scenario numbered by its
// position (parser.ts `S<n>:`); parsing either form gives the same feature.
const WRITTEN = SAMPLE.replace("## Basic Quote", "## S1: Basic Quote").replace(
  "## Declined Quote",
  "## S2: Declined Quote",
);
const BASIC = { name: "Basic Quote", version: 1 };
const XML = new TextEncoder().encode("<policy><holder>Ann</holder></policy>\n");
const CSV = new TextEncoder().encode("name,age\nAnn,41\n");

let root: string;
let home: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-files-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-files-home-"));
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

/** A listed file over bytes stored for real in the data repo. */
async function stored(name: string, bytes: Uint8Array): Promise<ScenarioFile> {
  return { name, file: await storeScenarioFile(data, name, bytes), size: bytes.byteLength };
}

// --- the stored bytes -----------------------------------------------------------

describe("storeScenarioFile", () => {
  test("stores under .files/ with a slug and content hash name", async () => {
    const name = await storeScenarioFile(data, "Policy Holder.XML", XML);
    expect(name).toMatch(/^policy-holder-[0-9a-f]{16}\.xml$/);
    expect(isStoredFileName(name)).toBe(true);
    expect(await readScenarioFile(data, name)).toEqual(XML);
    expect(await readdir(join(data, FILES_DIR))).toEqual([name]);
  });

  test("the same bytes are stored once, different bytes side by side", async () => {
    const a = await storeScenarioFile(data, "data.csv", CSV);
    expect(await storeScenarioFile(data, "data.csv", CSV)).toBe(a);
    const b = await storeScenarioFile(data, "data.csv", XML);
    expect(b).not.toBe(a);
    expect((await readdir(join(data, FILES_DIR))).sort()).toEqual([a, b].sort());
  });

  test("any kind of file is taken, binary and extensionless ones too", async () => {
    const bin = await storeScenarioFile(data, "payload.bin", new Uint8Array([0, 255, 7]));
    expect(bin).toMatch(/^payload-[0-9a-f]{16}\.bin$/);
    expect(await storeScenarioFile(data, "Makefile", CSV)).toMatch(/^makefile-[0-9a-f]{16}$/);
    expect(await storeScenarioFile(data, "データ.json", CSV)).toMatch(/^file-[0-9a-f]{16}\.json$/);
    expect(await storeScenarioFile(data, "odd.ex t", CSV)).toMatch(/^odd-[0-9a-f]{16}$/);
  });

  test("empty and oversized files are refused", async () => {
    expect(storeScenarioFile(data, "empty.csv", new Uint8Array())).rejects.toThrow("File is empty");
    expect(storeScenarioFile(data, "big.bin", new Uint8Array(MAX_FILE_BYTES + 1))).rejects.toThrow(
      "too large",
    );
  });

  test("only names storeScenarioFile generates can be read back", async () => {
    await writeFile(join(data, "secret.txt"), "secret");
    for (const name of [
      "../secret.txt",
      "..%2Fsecret.txt",
      "sub/x-0123456789abcdef.txt",
      ".hidden-0123456789abcdef",
      "UPPER-0123456789ABCDEF.TXT",
      "short-01234567.txt",
      "secret.txt",
    ]) {
      expect(await readScenarioFile(data, name)).toBeNull();
    }
    expect(await readScenarioFile(data, "missing-0123456789abcdef.txt")).toBeNull();
  });
});

describe("the file list", () => {
  test("a listed name is the base name on one line", () => {
    expect(fileDisplayName("  policy.xml ")).toBe("policy.xml");
    expect(fileDisplayName("C:\\fakepath\\policy.xml")).toBe("policy.xml");
    expect(fileDisplayName("dir/sub/policy  holder.xml")).toBe("policy holder.xml");
    expect(fileDisplayName("")).toBeNull();
    expect(fileDisplayName("..")).toBeNull();
    expect(fileDisplayName("dir/")).toBeNull();
  });

  test("the route takes only rows over stored names, first name wins", () => {
    const row = { name: "a.csv", file: "a-0123456789abcdef.csv", size: 3 };
    expect(validScenarioFiles([row, { ...row, size: 9 }])).toEqual([row]);
    expect(validScenarioFiles([{ ...row, name: " b.csv " }])).toEqual([{ ...row, name: "b.csv" }]);
    expect(validScenarioFiles([{ ...row, file: "../a.csv" }])).toBeNull();
    expect(validScenarioFiles([{ ...row, size: -1 }])).toBeNull();
    expect(validScenarioFiles([{ ...row, name: "" }])).toBeNull();
    expect(validScenarioFiles("nope")).toBeNull();
    expect(validScenarioFiles([])).toEqual([]);
  });

  test("sizes read in bytes, KB and MB", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(3500)).toBe("3.4 KB");
    expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
  });
});

// --- the document operation ---------------------------------------------------

describe("setScenarioFiles on the document", () => {
  const fresh = () => importFeatureDoc(parseFeature(SAMPLE));
  const A1 = { name: "policy.xml", file: "policy-0123456789abcdef.xml", size: 10 };
  const B1 = { name: "people.csv", file: "people-fedcba9876543210.csv", size: 20 };

  test("lists files on a scenario by name and version, and by its document id", () => {
    const byName = setScenarioFiles(fresh(), BASIC, [A1])!;
    expect(byName.specs[0]!.files).toEqual([A1]);
    const id = byName.specs[0]!.id;
    const byId = setScenarioFiles(byName, { name: "renamed", version: 9, id }, [A1, B1])!;
    expect(byId.specs[0]!.files).toEqual([A1, B1]);
    expect(byId.specs[1]!.files).toBeUndefined();
    expect(setScenarioFiles(fresh(), { name: "Nope", version: 1 }, [A1])).toBeNull();
  });

  test("the list is brought to the target by name — removed, replaced, renamed, appended", () => {
    let doc = setScenarioFiles(fresh(), BASIC, [A1, B1])!;
    const replaced = { ...A1, file: "policy-1111111111111111.xml", size: 11 };
    doc = setScenarioFiles(doc, BASIC, [replaced, { ...B1, name: "holders.csv" }])!;
    expect(doc.specs[0]!.files).toEqual([replaced, { ...B1, name: "holders.csv" }]);
    // A rename keeps the file's place in the list.
    doc = setScenarioFiles(doc, BASIC, [{ ...replaced, name: "policy-v2.xml" }, { ...B1, name: "holders.csv" }])!;
    expect(doc.specs[0]!.files!.map((f) => f.name)).toEqual(["policy-v2.xml", "holders.csv"]);
    doc = setScenarioFiles(doc, BASIC, [])!;
    expect(doc.specs[0]!.files).toEqual([]);
    expect(docToFeature(doc).scenarios[0]!.files).toBeUndefined();
  });

  test("two peers uploading different files concurrently end with both", () => {
    const base = setScenarioFiles(fresh(), BASIC, [])!;
    const a = setScenarioFiles(A.clone(base), BASIC, [A1])!;
    const b = setScenarioFiles(A.clone(base), BASIC, [B1])!;
    const names = A.merge(a, b).specs[0]!.files!.map((f) => f.name).sort();
    expect(names).toEqual([A1.name, B1.name].sort());
    expect(A.merge(A.clone(b), a).specs[0]!.files!.map((f) => f.name).sort()).toEqual(names);
  });

  test("the projection never carries them", () => {
    const doc = setScenarioFiles(fresh(), BASIC, [A1])!;
    expect(projectFeature(doc)).toBe(projectFeature(fresh()));
    expect(serializeFeature(docToFeature(doc))).not.toContain("policy");
  });
});

// --- through the feature module -----------------------------------------------

describe("saveScenarioFiles", () => {
  test("the document holds the list, the file does not, the editor sees it", async () => {
    const files = [await stored("policy.xml", XML), await stored("people.csv", CSV)];
    const saved = await saveScenarioFiles(data, FILE, BASIC, files);
    expect(saved.status).toBe("saved");
    expect(saved.parsed.scenarios[0]!.files).toEqual(files);
    expect(saved.content).toBe(WRITTEN);
    expect(await readFeature(data, FILE)).toBe(WRITTEN);
    const view = (await readFeatureView(data, FILE))!;
    expect(view.parsed.scenarios[0]!.files).toEqual(files);
    expect(view.parsed.scenarios[1]!.files).toBeUndefined();
  });

  test("a scenario the document lacks is refused", async () => {
    await expect(saveScenarioFiles(data, FILE, { name: "Nope", version: 1 }, [])).rejects.toThrow(
      'Scenario "Nope" @v1 not found',
    );
  });

  test("a draft scenario can carry files", async () => {
    await saveFeature(data, FILE, SAMPLE + "\n## Sketch @v1 [draft]\n\nsoon\n");
    const files = [await stored("policy.xml", XML)];
    await saveScenarioFiles(data, FILE, { name: "Sketch", version: 1 }, files);
    const sketch = (await readFeatureView(data, FILE))!.parsed.scenarios.find((s) => s.name === "Sketch")!;
    expect(sketch.status).toBe("draft");
    expect(sketch.files).toEqual(files);
  });

  test("the files survive body edits, renames, publishing and drift", async () => {
    const files = [await stored("policy.xml", XML)];
    await saveScenarioFiles(data, FILE, BASIC, files);
    const edited = SAMPLE.replace("is provided", "is emailed");
    const saved = await saveFeature(data, FILE, edited);
    expect(saved.parsed.scenarios[0]!.files).toEqual(files);
    const id = saved.parsed.scenarios[0]!.id!;
    const renamed = edited.replace("## Basic Quote @v1", "## Simple Quote @v1");
    const again = await saveFeature(data, FILE, renamed, { name: "Simple Quote", version: 1, id });
    expect(again.parsed.scenarios.find((s) => s.name === "Simple Quote")!.files).toEqual(files);
    await publishFeature(data, FILE, renamed, { name: "Simple Quote", version: 1 });
    await Bun.write(join(data, FILE), (await readFeature(data, FILE))!.replace("no account", "no account yet"));
    await importDrift(data);
    const view = (await readFeatureView(data, FILE))!;
    const simple = view.parsed.scenarios.find((s) => s.name === "Simple Quote")!;
    expect(simple.status).toBe("published");
    expect(simple.files).toEqual(files);
  });

  test("a scenario moved to another feature takes its files along", async () => {
    const files = [await stored("policy.xml", XML)];
    await saveScenarioFiles(data, FILE, BASIC, files);
    await createFeature(data, "Orders");
    const orders = "specs/orders.feature.md";
    await moveScenario(data, FILE, BASIC, orders);
    const moved = (await readFeatureView(data, orders))!.parsed.scenarios.find((s) => s.name === "Basic Quote")!;
    expect(moved.files).toEqual(files);
  });
});

// --- the routes ---------------------------------------------------------------

describe("the scenario files routes", () => {
  const url = `http://localhost/api/features/${encodeURIComponent(FILE)}/scenario-files`;
  const upload = (bytes: Uint8Array<ArrayBuffer>, fileName: string, scenario: unknown, name?: string) => {
    const form = new FormData();
    form.append("file", new File([bytes], fileName));
    form.append("scenario", JSON.stringify(scenario));
    if (name !== undefined) form.append("name", name);
    return handleApi(new Request(url, { method: "POST", body: form }));
  };
  const put = (body: unknown) =>
    handleApi(
      new Request(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  type View = { parsed: { scenarios: { name: string; files?: ScenarioFile[] }[] } };
  const filesOf = async (res: Response) =>
    ((await res.json()) as View).parsed.scenarios.find((s) => s.name === BASIC.name)!.files ?? [];

  beforeEach(async () => {
    await writeState({ dataRepo: data }, root);
  });

  test("create, read, update and delete a scenario's files", async () => {
    // Create.
    const created = (await upload(XML, "policy.xml", BASIC))!;
    expect(created.status).toBe(201);
    let files = await filesOf(created);
    expect(files).toEqual([{ name: "policy.xml", file: expect.stringMatching(/^policy-[0-9a-f]{16}\.xml$/), size: XML.byteLength }]);
    files = await filesOf((await upload(CSV, "people.csv", BASIC))!);
    expect(files.map((f) => f.name)).toEqual(["policy.xml", "people.csv"]);
    expect(await readFeature(data, FILE)).toBe(WRITTEN);

    // Read — downloaded as an attachment under its listed name.
    const download = (await handleApi(
      new Request(`http://localhost/api/scenario-files/${files[0]!.file}?name=${encodeURIComponent("policy.xml")}`),
    ))!;
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(XML);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain('attachment; filename="policy.xml"');
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");

    // Update — rename, and replace the contents.
    const renamed = files.map((f) => (f.name === "people.csv" ? { ...f, name: "holders.csv" } : f));
    files = await filesOf((await put({ scenario: BASIC, files: renamed }))!);
    expect(files.map((f) => f.name)).toEqual(["policy.xml", "holders.csv"]);
    const newer = new TextEncoder().encode("name,age\nAnn,42\n");
    files = await filesOf((await upload(newer, "anything.csv", BASIC, "holders.csv"))!);
    expect(files.map((f) => f.name)).toEqual(["policy.xml", "holders.csv"]);
    expect(await readScenarioFile(data, files[1]!.file)).toEqual(newer);
    // Uploading a file under a name already listed replaces it too.
    files = await filesOf((await upload(CSV, "policy.xml", BASIC))!);
    expect(files.map((f) => f.name)).toEqual(["policy.xml", "holders.csv"]);
    expect(await readScenarioFile(data, files[0]!.file)).toEqual(CSV);

    // Delete.
    files = await filesOf((await put({ scenario: BASIC, files: files.slice(1) }))!);
    expect(files.map((f) => f.name)).toEqual(["holders.csv"]);
    expect(await readFeature(data, FILE)).toBe(WRITTEN);
  });

  test("a non-ASCII name downloads under its UTF-8 name", async () => {
    const [up] = await filesOf((await upload(XML, "policy.xml", BASIC))!);
    // Renamed rather than uploaded so: a browser escapes quotes in an
    // uploaded file's name.
    const [f] = await filesOf((await put({ scenario: BASIC, files: [{ ...up!, name: 'Pólicy "1".xml' }] }))!);
    const res = (await handleApi(
      new Request(`http://localhost/api/scenario-files/${f!.file}?name=${encodeURIComponent(f!.name)}`),
    ))!;
    const disposition = res.headers.get("content-disposition")!;
    expect(disposition).toContain('filename="P_licy _1_.xml"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('Pólicy "1".xml')}`);
  });

  test("bad requests are refused", async () => {
    expect((await upload(XML, "policy.xml", { name: "Nope", version: 1 }))!.status).toBe(400);
    expect((await upload(XML, "policy.xml", { name: "Basic Quote" }))!.status).toBe(400);
    expect((await upload(new Uint8Array(), "empty.xml", BASIC))!.status).toBe(400);
    const noFile = new FormData();
    noFile.append("scenario", JSON.stringify(BASIC));
    expect((await handleApi(new Request(url, { method: "POST", body: noFile })))!.status).toBe(400);
    // A list naming bytes the repo doesn't hold, or a path out of .files/.
    const phantom = { name: "x.csv", file: "x-0123456789abcdef.csv", size: 1 };
    expect((await put({ scenario: BASIC, files: [phantom] }))!.status).toBe(400);
    expect((await put({ scenario: BASIC, files: [{ ...phantom, file: "../SAMPLE" }] }))!.status).toBe(400);
    expect((await put({ files: [] }))!.status).toBe(400);
    // Nothing stored under a name, or a name no upload makes.
    expect((await handleApi(new Request("http://localhost/api/scenario-files/x-0123456789abcdef.csv")))!.status).toBe(404);
    expect((await handleApi(new Request("http://localhost/api/scenario-files/..%2Fsecret")))!.status).toBe(404);
  });
});

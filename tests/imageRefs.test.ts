// A stored image's two names (src/server/imageRefs.ts,
// specs/editor/images.feature.md "an image shows where GitHub renders the
// file"): `/api/images/<name>` in the app, `/.images/<name>` in a markdown
// file, where GitHub reads the path from the repository root. The parser
// swaps them at the edge of the text, so the document — and a published
// scenario's body in it — is the same either way, and the drift pass moves a
// file written the old way into the new form without reading it as an edit.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importDrift } from "../src/server/automerge/driftSync";
import { loadFeatureDoc, loadPageDoc } from "../src/server/automerge/store";
import { readTextFile } from "../src/server/fsx";
import { imageReferences } from "../src/server/imageCleanup";
import { toAppImageRefs, toFileImageRefs } from "../src/server/imageRefs";
import { referencedImageNames, storedImageName, storeImage } from "../src/server/images";
import { ROADMAP } from "../src/server/pageFolders";
import { importPageDrift } from "../src/server/pages";
import { parseFeature, parsePage, serializeFeature, serializePage } from "../src/server/parser";
import { renderMarkdown } from "../src/frontend/markdown";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-image-refs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const APP = "/api/images/shot-1a2b3c4d.png";
const FILE = "/.images/shot-1a2b3c4d.png";

test("a stored image goes by its repo path in a file and by its route in the app", () => {
  expect(toFileImageRefs(`![shot](${APP})`)).toBe(`![shot](${FILE})`);
  expect(toFileImageRefs(`<img src="${APP}" alt="shot" width="320">`)).toBe(
    `<img src="${FILE}" alt="shot" width="320">`,
  );
  expect(toFileImageRefs(`![a](${APP}) ![b](/api/images/b-00000000.webp)`)).toBe(
    `![a](${FILE}) ![b](/.images/b-00000000.webp)`,
  );
  expect(toAppImageRefs(`![shot](${FILE})`)).toBe(`![shot](${APP})`);
  expect(toAppImageRefs(`<img src='${FILE}'>`)).toBe(`<img src='${APP}'>`);
  expect(toAppImageRefs(toFileImageRefs(`see ${APP} and ![x](${APP}?v=2)`))).toBe(
    `see ${APP} and ![x](${APP}?v=2)`,
  );
});

test("an address that only ends like a stored image is left as written", () => {
  for (const text of [
    // Somebody else's url.
    `![x](http://localhost:3000${APP})`,
    `![x](https://github.com/acme/specs/blob/main${FILE})`,
    `![x](..${FILE})`,
    // No name storeImage generates.
    "![x](/api/images/<name>)",
    "![x](/api/images/Upper-12345678.png)",
    "![x](/api/images/../etc/passwd)",
    "![x](/.images/notes.txt)",
    "the `/api/images/` route",
  ]) {
    expect(toFileImageRefs(text)).toBe(text);
    expect(toAppImageRefs(text)).toBe(text);
  }
});

const FEATURE = {
  name: "Quote Policy",
  description: `Quotes. ![overview](${APP})`,
  scenarios: [
    {
      name: "Basic quote",
      version: 1,
      status: "published" as const,
      body: `- Then: the quote shows <img src="${APP}" alt="quote" width="320">`,
      tests: [],
    },
  ],
};

test("a feature file names its images by their path in the repo", () => {
  const text = serializeFeature(FEATURE);
  expect(text).toContain(`![overview](${FILE})`);
  expect(text).toContain(`<img src="${FILE}" alt="quote" width="320">`);
  expect(text).not.toContain("/api/images/");
});

test("a feature reads the same from a file in either image form", () => {
  const written = serializeFeature(FEATURE);
  const old = written.replaceAll("/.images/", "/api/images/");
  for (const text of [written, old]) {
    const feature = parseFeature(text);
    expect(feature.description).toBe(FEATURE.description);
    expect(feature.scenarios[0]!.body).toBe(FEATURE.scenarios[0]!.body);
    expect(serializeFeature(feature)).toBe(written);
  }
});

test("a page names its images by their path in the repo and reads either form", () => {
  const page = { name: "Q3", body: `![plan](${APP})` };
  const written = serializePage(page);
  expect(written).toBe(`# Q3\n\n![plan](${FILE})\n`);
  expect(parsePage(written)).toEqual(page);
  expect(parsePage(`# Q3\n\n![plan](${APP})\n`)).toEqual(page);
});

test("a file written the old way moves to the new form without touching its published scenario", async () => {
  const file = "specs/billing.feature.md";
  const old =
    "# Billing\n\n## S1: Refund @v1 [published]\n\n- **Given** a cancelled policy\n" +
    `- **Then** the receipt shows ![receipt](${APP})\n`;
  await mkdir(join(dir, "specs"), { recursive: true });
  await writeFile(join(dir, file), old);
  await importDrift(dir);
  const moved = old.replace(APP, FILE);
  expect(await readTextFile(join(dir, file))).toBe(moved);
  const body = async () => (await loadFeatureDoc(dir, file))!.doc.specs[0]!.body;
  expect(await body()).toContain(`![receipt](${APP})`);

  // A peer on the old form writes the file back: not an edit, so nothing is
  // refused — the published body in the document is the one the file names.
  await writeFile(join(dir, file), old);
  expect(await importDrift(dir)).toBe("absorbed 1 externally edited file(s)");
  expect(await readTextFile(join(dir, file))).toBe(moved);
  expect(await body()).toContain(`![receipt](${APP})`);
  // In the new form the file is the document's projection: nothing to do.
  expect(await importDrift(dir)).toBe("");
});

test("a page written the old way moves to the new form", async () => {
  const file = "roadmap/q3.md";
  await mkdir(join(dir, "roadmap"), { recursive: true });
  await writeFile(join(dir, file), `# Q3\n\n![plan](${APP})\n`);
  await importPageDrift(dir, ROADMAP);
  // Adopted: the document holds the app's form, whatever the file says.
  expect((await loadPageDoc(dir, file))!.doc.body).toBe(`![plan](${APP})`);
  await writeFile(join(dir, file), `# Q3\n\nThe plan.\n\n![plan](${APP})\n`);
  await importPageDrift(dir, ROADMAP);
  expect(await readTextFile(join(dir, file))).toBe(`# Q3\n\nThe plan.\n\n![plan](${FILE})\n`);
  expect((await loadPageDoc(dir, file))!.doc.body).toBe(`The plan.\n\n![plan](${APP})`);
  expect(await importPageDrift(dir, ROADMAP)).toBe("");
});

test("an image a file names by its repo path counts as referenced", async () => {
  expect([...referencedImageNames(`![x](${FILE}) <img src="/.images/tag-00000000.webp">`)].sort()).toEqual([
    "shot-1a2b3c4d.png",
    "tag-00000000.webp",
  ]);
  expect(storedImageName(FILE)).toBe("shot-1a2b3c4d.png");
  expect(storedImageName(APP)).toBe("shot-1a2b3c4d.png");
  expect(storedImageName("/.images/../secret.png")).toBeNull();

  // On disk, where the cleanup looks before it deletes anything.
  const name = await storeImage(dir, "used.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]));
  await mkdir(join(dir, "notebook"), { recursive: true });
  await writeFile(join(dir, "notebook/entry.md"), `# Entry\n\n![used](/.images/${name})\n`);
  expect((await imageReferences(dir)).get(name)).toEqual(["notebook/entry.md"]);
});

// A page's source is its file's text: the image goes by its path in the repo
// there, and the preview loads it from the app's route all the same.
test("an image named by its path in the repo loads from the app's route", () => {
  const html = (src: string) =>
    renderToStaticMarkup(createElement(Fragment, null, renderMarkdown(src))).replace(/<link rel="preload"[^>]*\/>/g, "");
  expect(html(`![shot](${FILE})`)).toBe(`<p><img src="${APP}" alt="shot"/></p>`);
  expect(html(`<img src="${FILE}" width="320">`)).toBe(`<p><img src="${APP}" alt="" width="320"/></p>`);
  // Anything that is not a stored image keeps its own address.
  expect(html("![x](/.images/notes.txt)")).toBe('<p><img src="/.images/notes.txt" alt="x"/></p>');
});

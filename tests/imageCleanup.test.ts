// Unused images (src/server/imageCleanup.ts, specs/app/unused-images.feature.md
// [proposed]): which stored images the data repo's files reference — markdown
// images, <img> tags, url-encoded names, pages, draft scenarios that live only
// in the document — the listing that says so, a delete of the unreferenced
// ones, the refusal of a referenced one, and the routes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeatureDoc } from "../src/server/automerge/schema";
import { createFeatureDoc, newFeatureDoc } from "../src/server/automerge/store";
import { handleApi } from "../src/server/api";
import { deleteImages, imageReferences, listImages, StillReferenced } from "../src/server/imageCleanup";
import { IMAGES_DIR, isStoredImageName, referencedImageNames, storeImage } from "../src/server/images";
import { writeState } from "../src/server/state";

let root: string;
let data: string;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-unused-images-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = join(root, "home");
  data = join(root, "data");
  await mkdir(data, { recursive: true });
});

afterEach(async () => {
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const FEATURE = "specs/billing/collect-premium.feature.md";

/** Distinct bytes per letter, so each stored name is its own. */
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]);

/**
 * Five images: `a` in a markdown image, `b` in a sized <img> tag, `c` url-
 * encoded in a roadmap page, `d` only in a draft scenario the document holds,
 * and `e` nothing references.
 */
async function seed() {
  const a = await storeImage(data, "a.png", png(1));
  const b = await storeImage(data, "b.png", png(2));
  const c = await storeImage(data, "c.png", png(3));
  const d = await storeImage(data, "d.png", png(4));
  const e = await storeImage(data, "e.png", png(5));
  await mkdir(join(data, "specs/billing"), { recursive: true });
  await writeFile(
    join(data, FEATURE),
    [
      "# Collect Premium",
      "",
      "Money in.",
      "",
      "## S1: Pay on time @v1 [published]",
      "",
      `- Given: a policy ![receipt](/api/images/${a})`,
      `- Then: paid <img src="/api/images/${b}" alt="paid" width="320">`,
      "",
    ].join("\n"),
  );
  await mkdir(join(data, "roadmap"), { recursive: true });
  await writeFile(join(data, "roadmap/q3.md"), `# Q3\n\n![plan](/api/images/${encodeURIComponent(c)})\n`);
  await createFeatureDoc(
    data,
    FEATURE,
    newFeatureDoc({
      name: "Collect Premium",
      description: "Money in.",
      specs: [
        {
          id: "s-1",
          type: "Scenario",
          name: "Pay on time",
          version: 1,
          status: "published",
          rank: 1,
          body: `- Given: a policy ![receipt](/api/images/${a})\n- Then: paid <img src="/api/images/${b}" alt="paid" width="320">`,
          tests: [],
        },
        {
          id: "s-2",
          type: "Scenario",
          name: "Late payment",
          version: 1,
          status: "draft",
          rank: 2,
          body: `- Given: a reminder ![reminder](/api/images/${d})`,
          tests: [],
        },
      ],
    } as unknown as Omit<FeatureDoc, "schemaVersion" | "id">),
  );
  return { a, b, c, d, e };
}

describe("referencedImageNames", () => {
  test("finds stored names in markdown images, <img> tags, encoded urls and prose", () => {
    const text = [
      "![x](/api/images/shot-1a2b3c4d.png)",
      '<img src="/api/images/tag-00000000.webp" width="10">',
      "see /api/images/plain-abcdef01.svg here",
      "![y](/api/images/sp%20ace-12345678.png)",
      "![z](/api/images/../etc/passwd) ![w](/api/images/Upper-12345678.png) ![v](https://x/api/images/shot-1a2b3c4d.png)",
    ].join("\n");
    expect([...referencedImageNames(text)].sort()).toEqual([
      "plain-abcdef01.svg",
      "shot-1a2b3c4d.png",
      "tag-00000000.webp",
    ]);
  });

  test("only names storeImage generates are stored names", () => {
    expect(isStoredImageName("shot-1a2b3c4d.png")).toBe(true);
    expect(isStoredImageName("../shot.png")).toBe(false);
    expect(isStoredImageName(".hidden.png")).toBe(false);
    expect(isStoredImageName("notes.txt")).toBe(false);
  });
});

describe("imageReferences and listImages", () => {
  test("maps each image to the files that reference it, draft scenarios included", async () => {
    const { a, b, c, d, e } = await seed();
    const refs = await imageReferences(data);
    expect(refs.get(a)).toEqual([FEATURE]);
    expect(refs.get(b)).toEqual([FEATURE]);
    expect(refs.get(c)).toEqual(["roadmap/q3.md"]);
    expect(refs.get(d)).toEqual([FEATURE]);
    expect(refs.has(e)).toBe(false);

    const images = await listImages(data);
    expect(images.map((i) => i.name)).toEqual([a, b, c, d, e].sort());
    const byName = Object.fromEntries(images.map((i) => [i.name, i]));
    expect(byName[e]).toEqual({ name: e, path: `/api/images/${e}`, bytes: png(5).byteLength, referencedBy: [] });
    expect(byName[d]!.referencedBy).toEqual([FEATURE]);
  });

  test("a repo with no images lists none; stray files in .images/ are not images", async () => {
    expect(await listImages(data)).toEqual([]);
    await mkdir(join(data, IMAGES_DIR));
    await writeFile(join(data, IMAGES_DIR, ".DS_Store"), "x");
    await writeFile(join(data, IMAGES_DIR, "notes.txt"), "x");
    expect(await listImages(data)).toEqual([]);
  });
});

describe("deleteImages", () => {
  test("removes unreferenced images from .images/", async () => {
    const { a, b, c, d, e } = await seed();
    const result = await deleteImages(data, [e, e]);
    expect(result.deleted).toEqual([e]);
    expect((await readdir(join(data, IMAGES_DIR))).sort()).toEqual([a, b, c, d].sort());
  });

  test("refuses an image a file still references, and deletes nothing", async () => {
    const { a, d, e } = await seed();
    const attempt = deleteImages(data, [e, a, d]);
    await expect(attempt).rejects.toBeInstanceOf(StillReferenced);
    await expect(attempt).rejects.toThrow(/2 images are still referenced/);
    const err = (await attempt.catch((x: unknown) => x)) as StillReferenced;
    expect(err.referenced).toEqual({ [a]: [FEATURE], [d]: [FEATURE] });
    expect((await readdir(join(data, IMAGES_DIR))).length).toBe(5);
  });

  test("refuses names that are not stored images, or have no file", async () => {
    await seed();
    await expect(deleteImages(data, [])).rejects.toThrow("No images named");
    await expect(deleteImages(data, ["../specs/x.md"])).rejects.toThrow("Not a stored image name");
    await expect(deleteImages(data, ["gone-00000000.png"])).rejects.toThrow("No such image: gone-00000000.png");
  });
});

describe("routes", () => {
  const call = (path: string, init?: RequestInit) => handleApi(new Request(`http://localhost${path}`, init));
  const del = (body: unknown) =>
    call("/api/images", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("list the images with their references; delete the unreferenced; 409 for a referenced one", async () => {
    const { a, e } = await seed();
    await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);

    const list = await call("/api/images");
    expect(list!.status).toBe(200);
    const { images } = (await list!.json()) as { images: { name: string; referencedBy: string[] }[] };
    expect(images.length).toBe(5);
    expect(images.find((i) => i.name === e)!.referencedBy).toEqual([]);
    expect(images.find((i) => i.name === a)!.referencedBy).toEqual([FEATURE]);

    const refused = await del({ names: [a] });
    expect(refused!.status).toBe(409);
    const body = (await refused!.json()) as { error: string; referenced: Record<string, string[]> };
    expect(body.referenced).toEqual({ [a]: [FEATURE] });
    expect(body.error).toContain(a);

    const deleted = await del({ names: [e] });
    expect(deleted!.status).toBe(200);
    expect(((await deleted!.json()) as { deleted: string[] }).deleted).toEqual([e]);
    expect((await readdir(join(data, IMAGES_DIR))).includes(e)).toBe(false);
  });

  test("a delete needs a non-empty list of names", async () => {
    await seed();
    await writeState({ dataRepo: data, reloadFrequencySeconds: 0 }, root);
    expect((await del({}))!.status).toBe(400);
    expect((await del({ names: [] }))!.status).toBe(400);
    expect((await del({ names: [1] }))!.status).toBe(400);
    expect((await call("/api/images", { method: "DELETE", body: "nope" }))!.status).toBe(400);
  });
});

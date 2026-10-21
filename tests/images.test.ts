// Automates specs/images.feature.md: images pasted or uploaded into a scenario
// land as content-addressed files under `.images/` in the data repo and are
// served back only under the names storeImage itself generates.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentImageName, imageMime, readImage, storeImage, IMAGES_DIR, MAX_IMAGE_BYTES } from "../src/server/images";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-img-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("storeImage", () => {
  test("stores under .images/ with slug + content hash name", async () => {
    const name = await storeImage(root, "My Screenshot.PNG", PNG);
    expect(name).toMatch(/^my-screenshot-[0-9a-f]{8}\.png$/);
    expect(await readImage(root, name)).toEqual(PNG);
    expect(await readdir(join(root, IMAGES_DIR))).toEqual([name]);
  });

  // Scenario: repeated upload of the same image — same name, one file.
  test("same bytes upload to the same name, once", async () => {
    const first = await storeImage(root, "shot.png", PNG);
    const second = await storeImage(root, "shot.png", PNG);
    expect(second).toBe(first);
    expect(await readdir(join(root, IMAGES_DIR))).toEqual([first]);
  });

  test("different bytes under the same original name coexist", async () => {
    const a = await storeImage(root, "image.png", PNG);
    const b = await storeImage(root, "image.png", new Uint8Array([9, 9, 9]));
    expect(a).not.toBe(b);
    expect((await readdir(join(root, IMAGES_DIR))).sort()).toEqual([a, b].sort());
  });

  test("a name with no usable stem falls back to 'image'", async () => {
    const name = await storeImage(root, "画像.png", PNG);
    expect(name).toMatch(/^image-[0-9a-f]{8}\.png$/);
  });

  // Scenario: unsupported file is refused.
  test("rejects unsupported types, empty and oversized files", async () => {
    expect(storeImage(root, "notes.txt", PNG)).rejects.toThrow("Unsupported image type");
    expect(storeImage(root, "noext", PNG)).rejects.toThrow("Unsupported image type");
    expect(storeImage(root, "empty.png", new Uint8Array())).rejects.toThrow("Image is empty");
    expect(
      storeImage(root, "big.png", new Uint8Array(MAX_IMAGE_BYTES + 1)),
    ).rejects.toThrow("too large");
  });
});

describe("currentImageName", () => {
  test("a stored name while the bytes are the ones it was given for; its stem with their hash once they differ", async () => {
    const name = await storeImage(root, "flow chart.png", PNG);
    expect(currentImageName(name, PNG)).toBe(name);
    const touched = new Uint8Array([...PNG, 4]);
    const renamed = currentImageName(name, touched);
    expect(renamed).not.toBe(name);
    expect(renamed).toMatch(/^flow-chart-[0-9a-f]{8}\.png$/);
    // The renamed one is what storing the touched bytes would be called.
    expect(renamed).toBe(await storeImage(root, "flow chart.png", touched));
    expect(currentImageName(renamed, PNG)).toBe(name);
  });
});

describe("readImage", () => {
  test("null for missing images", async () => {
    expect(await readImage(root, "nope-12345678.png")).toBeNull();
  });

  // Only names storeImage generates are servable: no traversal out of
  // .images/, no reaching feature files or hidden files by crafted names.
  test("refuses names storeImage would never generate", async () => {
    await writeFile(join(root, "secret.feature.md"), "# Secret\n");
    for (const name of [
      "../secret.feature.md",
      "..%2Fsecret.feature.md",
      "sub/dir.png",
      ".hidden.png",
      "UPPER-12345678.PNG",
      "shot.png.txt",
      "shot",
    ]) {
      expect(await readImage(root, name)).toBeNull();
    }
  });
});

describe("imageMime", () => {
  test("maps stored extensions", () => {
    expect(imageMime("a-1.png")).toBe("image/png");
    expect(imageMime("a-1.jpg")).toBe("image/jpeg");
    expect(imageMime("a-1.svg")).toBe("image/svg+xml");
    expect(imageMime("weird")).toBe("application/octet-stream");
  });
});

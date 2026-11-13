// The zip a plugin release travels in (specs/app/plugins.feature.md "A
// plugin is released as a versioned zip in its release folder"): what
// `specdriven plugin release` writes unpacks to the same files, the same
// files always give the same bytes, and a zip carrying anything but plain
// files under its own folder is refused whole, before anything is written.

import { $ } from "bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ZIP_LIMITS, crc32, entryPathRefusal, unzip, unzipInto, zipEntries, type ZipEntry } from "../src/plugins/host/zip";

const text = (s: string) => new TextEncoder().encode(s);
const bundle = "export default { name: 'hello', apply() {} };\n".repeat(200);
const files: ZipEntry[] = [
  { path: "package.json", data: text('{"name":"hello","version":"1.0.0"}') },
  { path: "dist/host.js", data: text(bundle) },
  { path: "dist/client.js", data: text("x") },
  { path: "README.md", data: text("") },
];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "specdriven-zip-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The offset of the n-th record with this signature. */
function find(zip: Uint8Array, signature: number, nth = 0): number {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let seen = 0;
  for (let at = 0; at + 4 <= buf.length; at++) {
    if (buf.readUInt32LE(at) === signature && seen++ === nth) return at;
  }
  throw new Error("no such record");
}
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

/** A copy of the zip with bytes rewritten. */
function patched(zip: Uint8Array, change: (buf: Buffer) => void): Uint8Array {
  const copy = Buffer.from(zip);
  change(copy);
  return new Uint8Array(copy);
}

test("a zip unpacks to the files it was written from", () => {
  const out = unzip(zipEntries(files));
  expect(out.map((e) => e.path)).toEqual(["README.md", "dist/client.js", "dist/host.js", "package.json"]);
  for (const entry of out) {
    const original = files.find((f) => f.path === entry.path)!;
    expect(new TextDecoder().decode(entry.data)).toBe(new TextDecoder().decode(original.data));
  }
  // The bundle was worth deflating.
  expect(zipEntries(files).length).toBeLessThan(bundle.length / 4);
});

test("the same files give the same bytes, whatever order they are handed in", () => {
  const a = zipEntries(files);
  const b = zipEntries([...files].reverse());
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
});

test("a zip is unpacked into a folder, its subfolders made", async () => {
  const written = await unzipInto(zipEntries(files), join(dir, "out"));
  expect(written.sort()).toEqual(["README.md", join("dist", "client.js"), join("dist", "host.js"), "package.json"]);
  expect(await readFile(join(dir, "out", "dist", "host.js"), "utf8")).toBe(bundle);
  expect((await readdir(join(dir, "out", "dist"))).sort()).toEqual(["client.js", "host.js"]);
});

test("the checksum is the one every zip tool computes", () => {
  expect(crc32(text("123456789"))).toBe(0xcbf43926);
  expect(crc32(new Uint8Array())).toBe(0);
});

test("a path that would leave the folder is not an entry", () => {
  expect(entryPathRefusal("dist/host.js")).toBeNull();
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "a//b", "./a", "a/.", ""]) {
    expect(entryPathRefusal(bad)).not.toBeNull();
  }
  expect(() => zipEntries([{ path: "../x", data: text("x") }])).toThrow(/leaves the folder/);
  expect(() => zipEntries([files[0]!, files[0]!])).toThrow(/listed twice/);
});

test("a zip with an entry that leaves the folder is refused and nothing is written", async () => {
  // "aa/x" rewritten as "../x" in the file header and in the directory.
  const zip = zipEntries([{ path: "aa/x", data: text("x") }]);
  const evil = patched(zip, (buf) => {
    for (let at = 0; at + 4 <= buf.length; at++) {
      if (buf.subarray(at, at + 4).toString("latin1") === "aa/x") buf.write("../x", at, "latin1");
    }
  });
  expect(() => unzip(evil)).toThrow(/leaves the folder/);
  await expect(unzipInto(evil, join(dir, "out"))).rejects.toThrow(/leaves the folder/);
  expect(await readdir(dir)).toEqual([]);
});

test("a symlink, an encrypted entry, a zip64 zip and an unknown compression are refused", () => {
  const zip = zipEntries([{ path: "link", data: text("target") }]);
  const central = find(zip, CENTRAL);
  // Made on Unix, mode 0120777: a symlink.
  const symlink = patched(zip, (buf) => {
    buf.writeUInt16LE((3 << 8) | 20, central + 4);
    buf.writeUInt32LE(((0o120777 << 16) >>> 0), central + 38);
  });
  expect(() => unzip(symlink)).toThrow(/is a symlink/);
  const encrypted = patched(zip, (buf) => buf.writeUInt16LE(buf.readUInt16LE(central + 8) | 1, central + 8));
  expect(() => unzip(encrypted)).toThrow(/is encrypted/);
  const end = find(zip, END);
  const zip64 = patched(zip, (buf) => {
    buf.writeUInt16LE(0xffff, end + 8);
    buf.writeUInt16LE(0xffff, end + 10);
  });
  expect(() => unzip(zip64)).toThrow(/zip64/);
  const bzip = patched(zip, (buf) => buf.writeUInt16LE(12, central + 10));
  expect(() => unzip(bzip)).toThrow(/method 12/);
});

test("an entry whose bytes are not what it declares is refused", () => {
  // Stored: one byte flipped no longer matches the checksum.
  const stored = zipEntries([{ path: "a", data: text("abc") }]);
  const flipped = patched(stored, (buf) => {
    const at = buf.indexOf("abc", 0, "latin1");
    buf[at] = 0x7a;
  });
  expect(() => unzip(flipped)).toThrow(/does not match its checksum/);
  // Deflated: declaring fewer bytes than it unpacks to is never unpacked past them.
  const deflated = zipEntries([{ path: "b", data: text(bundle) }]);
  const central = find(deflated, CENTRAL);
  const lying = patched(deflated, (buf) => buf.writeUInt32LE(10, central + 24));
  expect(() => unzip(lying)).toThrow(/does not unpack|not the size/);
});

test("a zip past the limits, a truncated one and a file that is no zip are refused", () => {
  const zip = zipEntries(files);
  expect(() => unzip(zip, { maxEntries: 2, maxBytes: 1 << 20 })).toThrow(/at most 2/);
  expect(() => unzip(zip, { maxEntries: 100, maxBytes: 100 })).toThrow(/more than 100 bytes/);
  expect(() => unzip(zip.subarray(0, zip.length - 5))).toThrow(/not a zip/);
  expect(() => unzip(text("just some text, long enough to hold a record"))).toThrow(/not a zip/);
  expect(unzip(zipEntries([]))).toEqual([]);
});

test.if(Boolean(Bun.which("unzip")))("the system's unzip reads a zip this app wrote", async () => {
  const file = join(dir, "hello-1.0.0.zip");
  await writeFile(file, zipEntries(files));
  const listing = await $`unzip -t ${file}`.quiet().text();
  expect(listing).toContain("No errors detected");
  await $`unzip -q ${file} -d ${join(dir, "sys")}`.quiet();
  expect(await readFile(join(dir, "sys", "dist", "host.js"), "utf8")).toBe(bundle);
});

test.if(Boolean(Bun.which("zip")))("this app reads a zip the system's zip wrote, folders and all", async () => {
  const src = join(dir, "src");
  await unzipInto(zipEntries(files), src);
  const file = join(dir, "sys.zip");
  await $`zip -q -r ${file} .`.cwd(src).quiet();
  const out = unzip(new Uint8Array(await readFile(file)));
  expect(out.map((e) => e.path).sort()).toEqual(["README.md", "dist/client.js", "dist/host.js", "package.json"]);
  expect(new TextDecoder().decode(out.find((e) => e.path === "dist/host.js")!.data)).toBe(bundle);
});

test("a zip with more entries than a release could hold is refused by default", () => {
  const many = Array.from({ length: DEFAULT_ZIP_LIMITS.maxEntries + 1 }, (_, i) => ({ path: `f/${i}`, data: new Uint8Array() }));
  expect(() => unzip(zipEntries(many))).toThrow(new RegExp(`at most ${DEFAULT_ZIP_LIMITS.maxEntries} are unpacked`));
  // One fewer is a zip like any other.
  expect(unzip(zipEntries(many.slice(1)))).toHaveLength(DEFAULT_ZIP_LIMITS.maxEntries);
  // A release's bundles fit many times over.
  expect(DEFAULT_ZIP_LIMITS.maxBytes).toBeGreaterThan(64 * 1024 * 1024);
});

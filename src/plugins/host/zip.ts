// Zip files, as far as a plugin release needs them (specs/app/plugins
// .feature.md "A plugin is released as a versioned zip in its release
// folder"): `specdriven plugin release` writes one and an install reads it.
// Written here on `node:zlib` rather than taken from a package — a release
// is code that will run with the app's rights, so what unpacks it is small
// enough to read: plain files, stored or deflated, and nothing else. A zip
// that carries anything more (a symlink, an encrypted or zip64 entry, a
// path that leaves the folder, more bytes than it declares) is refused
// whole, before a single file is written.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

/** One file in a zip: its path, `/`-separated and relative, and its bytes. */
export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/** What a reader refuses to unpack past: a release is a few bundles. */
export interface ZipLimits {
  maxEntries: number;
  maxBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 2000, maxBytes: 128 * 1024 * 1024 };

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
/** Names are UTF-8 (general purpose bit 11). */
const UTF8 = 0x0800;
const ENCRYPTED = 0x0001;
const STORED = 0;
const DEFLATED = 8;
/** 1980-01-01 00:00, the zip epoch: the same bytes whenever a release is cut. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Why a path cannot be an entry, or null: it must be relative, `/`-separated,
 * with no empty, `.` or `..` segment — so it lands under the folder it is
 * unpacked into and nowhere else.
 */
export function entryPathRefusal(path: string): string | null {
  if (!path) return "an entry has no name";
  if (path.includes("\0")) return `"${path}" has a NUL in its name`;
  if (path.includes("\\")) return `"${path}" uses backslashes`;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return `"${path}" is an absolute path`;
  const segments = path.split("/");
  if (segments.some((s) => s === "..")) return `"${path}" leaves the folder`;
  if (segments.some((s) => s === "" || s === ".")) return `"${path}" is not a plain relative path`;
  return null;
}

/**
 * The files as a zip. The same files give the same bytes: entries are
 * sorted by path, carry no time of their own, and are deflated at one
 * level (stored when deflating does not make them smaller).
 */
export function zipEntries(files: readonly ZipEntry[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let last: string | undefined;
  for (const file of sorted) {
    const refusal = entryPathRefusal(file.path);
    if (refusal) throw new Error(refusal);
    if (file.path === last) throw new Error(`"${file.path}" is listed twice`);
    last = file.path;
    const name = Buffer.from(file.path, "utf8");
    const deflated = deflateRawSync(file.data, { level: 9 });
    const method = deflated.length < file.data.length ? DEFLATED : STORED;
    const body = method === DEFLATED ? deflated : Buffer.from(file.data);
    const crc = crc32(file.data);
    if (name.length > 0xffff || body.length >= 0xffffffff || file.data.length >= 0xffffffff) {
      throw new Error(`"${file.path}" is too large for a plugin release`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
    if (offset >= 0xffffffff) throw new Error("the files are too large for a plugin release");
  }
  if (sorted.length > 0xfffe) throw new Error("too many files for a plugin release");
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/**
 * The files in a zip, in the order its directory lists them. Throws for a
 * zip this app does not unpack: not a zip at all, split over disks, zip64,
 * an encrypted entry, a symlink, a compression other than stored or
 * deflate, a path that would leave the folder, a name listed twice, an
 * entry whose bytes do not match the size or checksum it declares, or more
 * entries or bytes than the limits allow. Folder entries are skipped.
 */
export function unzip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endOfDirectory(buf);
  if (buf.readUInt16LE(end + 4) !== 0 || buf.readUInt16LE(end + 6) !== 0) {
    throw new Error("the zip is split over several disks");
  }
  const count = buf.readUInt16LE(end + 10);
  const dirSize = buf.readUInt32LE(end + 12);
  const dirOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    throw new Error("the zip is in zip64 format");
  }
  if (end >= 20 && buf.readUInt32LE(end - 20) === ZIP64_LOCATOR) throw new Error("the zip is in zip64 format");
  if (buf.readUInt16LE(end + 8) !== count) throw new Error("the zip is split over several disks");
  if (count > limits.maxEntries) throw new Error(`the zip has ${count} entries; at most ${limits.maxEntries} are unpacked`);
  if (dirOffset + dirSize > end) throw new Error("the zip's directory is cut short");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let at = dirOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buf.readUInt32LE(at) !== CENTRAL) throw new Error("the zip's directory is damaged");
    const madeBy = buf.readUInt16LE(at + 4);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const attributes = buf.readUInt32LE(at + 38);
    const localOffset = buf.readUInt32LE(at + 42);
    if (at + 46 + nameLength > end) throw new Error("the zip's directory is damaged");
    let path: string;
    try {
      path = decoder.decode(buf.subarray(at + 46, at + 46 + nameLength));
    } catch {
      throw new Error("the zip has an entry whose name is not UTF-8");
    }
    at += 46 + nameLength + extraLength + commentLength;

    if (packed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("the zip is in zip64 format");
    }
    if (flags & ENCRYPTED) throw new Error(`"${path}" is encrypted`);
    // Made on Unix: the high half of the attributes is the file's mode.
    const unix = madeBy >>> 8 === 3;
    const type = unix ? (attributes >>> 16) & 0o170000 : 0;
    if (type === 0o120000) throw new Error(`"${path}" is a symlink`);
    if (path.endsWith("/")) {
      if (size !== 0) throw new Error(`"${path}" is a folder with content`);
      continue;
    }
    if (type !== 0 && type !== 0o100000) throw new Error(`"${path}" is not a plain file`);
    const refusal = entryPathRefusal(path);
    if (refusal) throw new Error(refusal);
    if (seen.has(path)) throw new Error(`"${path}" is listed twice`);
    seen.add(path);
    if (method !== STORED && method !== DEFLATED) {
      throw new Error(`"${path}" is compressed in a way this app does not unpack (method ${method})`);
    }
    total += size;
    if (total > limits.maxBytes) throw new Error(`the zip unpacks to more than ${limits.maxBytes} bytes`);

    if (localOffset + 30 > dirOffset || buf.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`"${path}" has no file header`);
    }
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + packed > dirOffset) throw new Error(`"${path}" is cut short`);
    const body = buf.subarray(start, start + packed);
    let data: Uint8Array;
    if (method === STORED) {
      if (packed !== size) throw new Error(`"${path}" is not the size it declares`);
      data = new Uint8Array(body);
    } else {
      try {
        // Never more than it declares: a small zip cannot unpack to a huge file.
        data = new Uint8Array(inflateRawSync(body, { maxOutputLength: Math.max(size, 1) }));
      } catch {
        throw new Error(`"${path}" does not unpack`);
      }
      if (data.length !== size) throw new Error(`"${path}" is not the size it declares`);
    }
    if (crc32(data) !== crc) throw new Error(`"${path}" does not match its checksum`);
    out.push({ path, data });
  }
  return out;
}

/** Where the end-of-directory record starts: the last one a comment could follow. */
function endOfDirectory(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let at = buf.length - 22; at >= lowest; at--) {
    if (buf.readUInt32LE(at) === END && at + 22 + buf.readUInt16LE(at + 20) === buf.length) return at;
  }
  throw new Error("the file is not a zip");
}

/**
 * Unpack a zip into a folder, which is created. Everything is read and
 * checked first, so a refused zip writes nothing. Answers the paths written.
 */
export async function unzipInto(
  bytes: Uint8Array,
  dir: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<string[]> {
  const entries = unzip(bytes, limits);
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  for (const entry of entries) {
    const target = resolve(root, ...entry.path.split("/"));
    if (!target.startsWith(root + sep)) throw new Error(`"${entry.path}" leaves the folder`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data);
  }
  return entries.map((e) => join(...e.path.split("/")));
}

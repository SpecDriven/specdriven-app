// Automates specs/app/desktop-app.feature.md "Packaging": the application
// icon every artifact carries, the committed renderings electron-builder
// stamps, and the tool that makes them (scripts/build-icons.ts).
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import {
  CANVAS,
  ICO_SIZES,
  LINUX_SIZES,
  MAC_TILE,
  encodeIco,
  iconsetFiles,
  pngSize,
  renderPage,
} from "../scripts/build-icons";
import { APP_ICON } from "../scripts/build-desktop";

const build = pkg.build;

test("electron-builder is pointed at committed icons for every platform", () => {
  expect(build.mac.icon).toBe("build/icon.icns");
  expect(build.win.icon).toBe("build/icon.ico");
  expect(build.linux.icon).toBe("build/icons");
  for (const file of [build.mac.icon, build.win.icon, build.linux.icon, "build/icon.svg", APP_ICON]) {
    expect(existsSync(file)).toBe(true);
  }
});

test("build/icons carries every Linux size, each file the size it names", () => {
  for (const size of LINUX_SIZES) {
    const png = new Uint8Array(readFileSync(join("build/icons", `${size}x${size}.png`)));
    expect(pngSize(png)).toEqual({ width: size, height: size });
  }
  expect(pngSize(new Uint8Array(readFileSync(APP_ICON)))).toEqual({ width: CANVAS, height: CANVAS });
});

test("the .icns and .ico are what their formats expect", () => {
  const icns = readFileSync("build/icon.icns");
  expect(icns.subarray(0, 4).toString("latin1")).toBe("icns");
  expect(icns.readUInt32BE(4)).toBe(icns.byteLength);

  const ico = readFileSync("build/icon.ico");
  expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
  expect(ico.readUInt16LE(4)).toBe(ICO_SIZES.length);
});

/** The least PNG pngSize reads: the signature and an IHDR with the size. */
function fakePng(size: number, filler: number): Uint8Array {
  const png = new Uint8Array(33).fill(filler);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer);
  view.setUint32(8, 13);
  png.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, size);
  view.setUint32(20, size);
  return png;
}

test("encodeIco lays out PNG entries the way Windows reads them back", () => {
  const images = [16, 256].map((size, i) => ({ size, png: fakePng(size, i + 1) }));
  const ico = encodeIco(images);
  const view = new DataView(ico.buffer);
  expect(view.getUint16(2, true)).toBe(1); // an icon, not a cursor
  expect(view.getUint16(4, true)).toBe(2);
  images.forEach((image, i) => {
    const at = 6 + 16 * i;
    // 256 is written as 0: the width byte cannot hold it.
    expect(ico[at]).toBe(image.size === 256 ? 0 : image.size);
    expect(ico[at + 1]).toBe(ico[at]);
    expect(view.getUint16(at + 6, true)).toBe(32);
    const length = view.getUint32(at + 8, true);
    const offset = view.getUint32(at + 12, true);
    expect(length).toBe(image.png.byteLength);
    const stored = ico.subarray(offset, offset + length);
    expect([...stored]).toEqual([...image.png]);
    expect(pngSize(stored)).toEqual({ width: image.size, height: image.size });
  });
  expect(ico.byteLength).toBe(6 + 16 * 2 + 33 * 2);
});

test("macOS and Linux renderings sit on Apple's margin; the Windows one is full-bleed", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>SD</text></svg>';
  const font = "data:font/woff2;base64,AA==";
  const mac = renderPage(svg, font, "mac");
  const margin = (CANVAS - MAC_TILE) / 2;
  expect(mac).toContain(`left: ${margin}px; top: ${margin}px; width: ${MAC_TILE}px; height: ${MAC_TILE}px;`);
  const flat = renderPage(svg, font, "flat");
  expect(flat).toContain(`left: 0px; top: 0px; width: ${CANVAS}px; height: ${CANVAS}px;`);
  for (const page of [mac, flat]) {
    // Inline, not an <img>: an image document would not see the page's font.
    expect(page).toContain(svg);
    expect(page).toContain(`src: url(${font}) format("woff2")`);
    expect(page).toContain('font-family: "Inter Variable"');
  }
});

test("the iconset names each file by its point size, with the @2x double beside it", () => {
  const files = iconsetFiles();
  expect(files).toContainEqual({ name: "icon_16x16.png", size: 16 });
  expect(files).toContainEqual({ name: "icon_16x16@2x.png", size: 32 });
  expect(files).toContainEqual({ name: "icon_512x512@2x.png", size: CANVAS });
  expect(files.map((f) => f.size).sort((a, b) => a - b)).toEqual([16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]);
});

test("the web app's favicon is the same artwork", () => {
  expect(readFileSync("src/index.html", "utf8")).toContain('<link rel="icon" type="image/svg+xml" href="../build/icon.svg" />');
});

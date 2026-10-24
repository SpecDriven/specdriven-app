#!/usr/bin/env bun
/**
 * Rasterizes the application icon (specs/app/desktop-app.feature.md
 * "Packaging") from its master artwork, build/icon.svg:
 *
 *   bun run build:icons
 *
 * writes, next to the SVG:
 *
 *   build/icon.icns       macOS, the full iconset from 16 to 1024 (needs
 *                         iconutil, so this one is only refreshed on macOS)
 *   build/icon.ico        Windows, 16–256 full-bleed
 *   build/icons/NxN.png   Linux, 16–1024
 *   build/icon.png        the 1024 Linux/macOS rendering, copied into the
 *                         desktop bundle for the Linux window icon and the
 *                         dev dock (src/electron/main.ts)
 *
 * The outputs are committed: electron-builder reads them from build/ (the
 * "build" section of package.json names each) and no build machine has to
 * run this. Run it after editing the SVG.
 *
 * Rendering goes through Electron's own Chromium (scripts/renderIcon.cjs),
 * so the result is what the app itself would draw and no image library
 * joins the dependencies. macOS and Linux icons sit inside a transparent
 * margin — Apple's template puts the tile on 824 of the 1024 canvas, and
 * Linux desktops expect the same — while the Windows one is full-bleed,
 * like every other taskbar icon there.
 */
import { $ } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The square every icon is painted on. */
export const CANVAS = 1024;
/** Apple's template: the tile covers 824 of the 1024 canvas, centered. */
export const MAC_TILE = 824;
/** The PNG sizes build/icons/ carries for Linux. */
export const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
/** The images inside the Windows .ico (256 is the largest Windows reads). */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

export type Variant = "mac" | "flat";

/** The files iconutil expects in an .iconset, with each one's pixel size. */
export function iconsetFiles(): { name: string; size: number }[] {
  const files: { name: string; size: number }[] = [];
  for (const points of [16, 32, 128, 256, 512]) {
    files.push({ name: `icon_${points}x${points}.png`, size: points });
    files.push({ name: `icon_${points}x${points}@2x.png`, size: points * 2 });
  }
  return files;
}

/**
 * The page Chromium paints: the SVG inline (an <img> would not see the
 * page's font), the Inter face it names embedded so the wordmark is the
 * same on every build machine, and for the mac variant the tile scaled onto
 * the transparent margin.
 */
export function renderPage(svg: string, fontDataUrl: string, variant: Variant): string {
  const tile = variant === "mac" ? MAC_TILE : CANVAS;
  const offset = (CANVAS - tile) / 2;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @font-face {
        font-family: "Inter Variable";
        font-style: normal;
        font-weight: 100 900;
        src: url(${fontDataUrl}) format("woff2");
      }
      html, body { margin: 0; background: transparent; }
      body { width: ${CANVAS}px; height: ${CANVAS}px; overflow: hidden; }
      .tile { position: absolute; left: ${offset}px; top: ${offset}px; width: ${tile}px; height: ${tile}px; }
      .tile svg { display: block; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div class="tile">${svg}</div>
  </body>
</html>
`;
}

/**
 * A Windows .ico holding PNG-compressed images (every Windows since Vista
 * reads those): the ICONDIR header, one ICONDIRENTRY per image, then the
 * PNGs back to back. A 256-pixel edge is written as 0, the format's way of
 * saying 256.
 */
export function encodeIco(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const HEADER = 6;
  const ENTRY = 16;
  const total = HEADER + ENTRY * images.length + images.reduce((n, i) => n + i.png.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);
  let offset = HEADER + ENTRY * images.length;
  images.forEach((image, i) => {
    const at = HEADER + ENTRY * i;
    const edge = image.size >= 256 ? 0 : image.size;
    out[at] = edge;
    out[at + 1] = edge;
    out[at + 2] = 0; // colours in palette: none
    out[at + 3] = 0; // reserved
    view.setUint16(at + 4, 1, true); // colour planes
    view.setUint16(at + 6, 32, true); // bits per pixel
    view.setUint32(at + 8, image.png.byteLength, true);
    view.setUint32(at + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.byteLength;
  });
  return out;
}

/** Edge length of a PNG, from its IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const FONT = "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2";

export async function buildIcons(buildDir = "build"): Promise<void> {
  const svg = await readFile(join(buildDir, "icon.svg"), "utf8");
  const font = await readFile(FONT);
  const fontDataUrl = `data:font/woff2;base64,${font.toString("base64")}`;

  const work = await mkdtemp(join(tmpdir(), "specdriven-icons-"));
  try {
    const macSizes = [...new Set([...LINUX_SIZES, ...iconsetFiles().map((f) => f.size)])].sort((a, b) => a - b);
    const pngFile = (variant: Variant, size: number) => join(work, `${variant}-${size}.png`);
    const pages = (
      [
        ["mac", macSizes],
        ["flat", ICO_SIZES],
      ] as [Variant, number[]][]
    ).map(([variant, sizes]) => ({
      html: join(work, `${variant}.html`),
      outputs: sizes.map((size) => ({ size, file: pngFile(variant, size) })),
    }));
    for (const [variant, page] of (["mac", "flat"] as Variant[]).map((v, i) => [v, pages[i]!] as const)) {
      await writeFile(page.html, renderPage(svg, fontDataUrl, variant));
    }
    const jobFile = join(work, "job.json");
    await writeFile(jobFile, JSON.stringify({ canvas: CANVAS, pages }));

    console.log("Rendering with Electron…");
    const renderer = resolve(import.meta.dir, "renderIcon.cjs");
    await $`bunx electron ${renderer} ${jobFile}`;

    for (const page of pages) {
      for (const out of page.outputs) {
        const { width, height } = pngSize(new Uint8Array(await readFile(out.file)));
        if (width !== out.size || height !== out.size) {
          throw new Error(`${out.file} is ${width}×${height}, expected ${out.size}×${out.size}`);
        }
      }
    }

    console.log("Writing build/icons/ and build/icon.png…");
    const iconsDir = join(buildDir, "icons");
    await rm(iconsDir, { recursive: true, force: true });
    await mkdir(iconsDir, { recursive: true });
    for (const size of LINUX_SIZES) {
      await writeFile(join(iconsDir, `${size}x${size}.png`), await readFile(pngFile("mac", size)));
    }
    await writeFile(join(buildDir, "icon.png"), await readFile(pngFile("mac", CANVAS)));

    console.log("Writing build/icon.ico…");
    const ico = encodeIco(
      await Promise.all(
        ICO_SIZES.map(async (size) => ({ size, png: new Uint8Array(await readFile(pngFile("flat", size))) })),
      ),
    );
    await writeFile(join(buildDir, "icon.ico"), ico);

    if (Bun.which("iconutil")) {
      console.log("Writing build/icon.icns…");
      const iconset = join(work, "icon.iconset");
      await mkdir(iconset);
      for (const { name, size } of iconsetFiles()) {
        await writeFile(join(iconset, name), await readFile(pngFile("mac", size)));
      }
      await $`iconutil -c icns ${iconset} -o ${join(buildDir, "icon.icns")}`.quiet();
    } else {
      console.log("No iconutil here — build/icon.icns left as committed (refresh it on macOS).");
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await buildIcons();
  console.log("Done — icons in build/");
}

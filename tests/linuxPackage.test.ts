// Automates specs/app/desktop-app.feature.md "the packaged Linux app opens
// on a clean machine": what the electron-builder config in package.json
// promises a machine that has never seen Electron. Building and installing
// the deb or AppImage needs Linux tooling; this checks the config the build
// reads, so a change that would break a clean install fails here first.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { DESKTOP_SCHEME } from "../src/frontend/route";

const pkg = await Bun.file(join(import.meta.dir, "../package.json")).json();
const build = pkg.build;

/** Each dependency of the deb, as its list of alternatives. */
const debDepends: string[][] = (build.deb.depends as string[]).map((d) =>
  d.split("|").map((alt) => alt.trim()),
);

test("the deb names the shared libraries Electron loads", () => {
  const named = debDepends.flat();
  for (const lib of ["libgtk-3-0", "libnss3", "libxss1", "libxtst6", "libatspi2.0-0", "libsecret-1-0"]) {
    expect(named).toContain(lib);
  }
});

test("ALSA is required by its t64 name first, then the old one", () => {
  // On releases that renamed it, plain libasound2 resolves to an OSS
  // compatibility stub missing symbols Electron calls.
  const alsa = debDepends.filter((alts) => alts.some((a) => a.startsWith("libasound2")));
  expect(alsa).toEqual([["libasound2t64", "libasound2"]]);
});

test("the AppImage carries the static runtime, needing neither FUSE nor a host zlib", () => {
  // electron-builder's legacy toolset ("0.0.0", its default) has the
  // dynamically linked runtime; every later one is static.
  const toolset = build.toolsets?.appimage;
  expect(toolset).toBeString();
  expect(toolset).not.toBe("0.0.0");
});

test("both Linux artifacts are built for x64 and arm64", () => {
  const targets = build.linux.target as { target: string; arch: string[] }[];
  expect(targets.map((t) => t.target).sort()).toEqual(["AppImage", "deb"]);
  for (const t of targets) expect(t.arch.sort()).toEqual(["arm64", "x64"]);
});

test("packaging never rebuilds native modules for the build machine", () => {
  expect(build.npmRebuild).toBe(false);
});

test("the installed app declares the specdriven scheme to the OS", () => {
  // electron-builder writes these into Info.plist on macOS and the desktop
  // entry's MimeType on Linux.
  const schemes = (build.protocols as { schemes: string[] }[]).flatMap((p) => p.schemes);
  expect(schemes).toEqual([DESKTOP_SCHEME]);
});

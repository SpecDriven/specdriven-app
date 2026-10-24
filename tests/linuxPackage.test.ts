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

// The main process and the renderer are bundled under dist/ before packaging
// (scripts/build-desktop.ts), so the package carries those bundles and
// nothing of the dependency tree they were built from: shipping node_modules
// as well once put 300 MB of never-loaded code into app.asar. dist/ is named
// piece by piece because the web build (dist/specdriven, 90 MB) and the crash
// test (dist/crash-test, a user profile) leave their output beside the bundles.
test("the package ships the bundles, not node_modules or the rest of dist/", () => {
  const files = build.files as string[];
  expect(files).toContain("dist/electron/**");
  expect(files).toContain("dist/renderer/**");
  expect(files).toContain("dist/icon.png");
  expect(files).toContain("dist/patch.json");
  expect(files).not.toContain("dist/**/*");
  expect(files).toContain("!node_modules/**");
});

test("source maps stay out of the package", () => {
  expect(build.files as string[]).toContain("!dist/**/*.map");
});

test("only the English Chromium locale ships", () => {
  // The app's own UI is English; the other locale packs only translate
  // Chromium's context menus and cost ~47 MB per install.
  expect(build.electronLanguages).toEqual(["en"]);
});

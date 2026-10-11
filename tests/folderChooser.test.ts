// Automates specs/ui/app-start.feature.md "picking the data directory with the
// native folder chooser": the chooser is pluggable (osascript on a macOS
// web server, PowerShell on a Windows one, zenity or kdialog on a Linux
// one, Electron's dialog in the desktop app), one dialog is open at a
// time, and the endpoint reports 501 where no native chooser exists.

import { test, expect, afterEach, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canChooseFolder,
  chooseFolder,
  FOLDER_TITLES,
  platformChooser,
  setFolderChooser,
} from "../src/server/folderChooser";
import { matchApi } from "../src/server/api";

// Detach whatever the platform default is (osascript on this mac) so no
// test ever opens a real dialog; put it back when the file is done.
const platformDefault = setFolderChooser(null);
afterEach(() => {
  setFolderChooser(null);
});
afterAll(() => {
  setFolderChooser(platformDefault);
});

const post = () =>
  new Request("http://localhost/api/choose-folder", { method: "POST" });

// A PATH holding just the named executables, so the Linux lookup can be
// exercised without caring what this machine has installed.
function pathWith(...commands: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "chooser-path-"));
  for (const command of commands) {
    const file = join(dir, command);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

// macOS and Windows always have a dialog to open; the Browse… button is
// hidden only where none exists.
test("macOS and Windows get a chooser out of the box, unknown platforms none", () => {
  expect(platformChooser("darwin")).not.toBeNull();
  expect(platformChooser("win32")).not.toBeNull();
  expect(platformChooser("freebsd", {})).toBeNull();
});

// Linux ships no dialog of its own, so the chooser is whichever of the
// desktop ones is actually installed.
test("Linux takes zenity or kdialog, whichever is on PATH", () => {
  const display = { DISPLAY: ":0" };
  expect(platformChooser("linux", { ...display, PATH: pathWith("zenity") })).not.toBeNull();
  expect(platformChooser("linux", { ...display, PATH: pathWith("kdialog") })).not.toBeNull();
  expect(platformChooser("linux", { ...display, PATH: pathWith("ls") })).toBeNull();
  expect(platformChooser("linux", display)).toBeNull();
});

// A directory on PATH named zenity is not a dialog; neither is one without
// the execute bit.
test("Linux ignores a PATH entry that is not executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "chooser-path-"));
  mkdirSync(join(dir, "zenity"));
  const notExecutable = mkdtempSync(join(tmpdir(), "chooser-path-"));
  writeFileSync(join(notExecutable, "kdialog"), "#!/bin/sh\n");
  chmodSync(join(notExecutable, "kdialog"), 0o644);
  expect(platformChooser("linux", { DISPLAY: ":0", PATH: dir })).toBeNull();
  expect(platformChooser("linux", { DISPLAY: ":0", PATH: notExecutable })).toBeNull();
});

// Headless Linux — the Docker image, an SSH session — has nowhere to put a
// dialog even with zenity installed, so Browse… stays hidden.
test("Linux with no display gets no chooser", () => {
  const PATH = pathWith("zenity");
  expect(platformChooser("linux", { PATH })).toBeNull();
  expect(platformChooser("linux", { PATH, WAYLAND_DISPLAY: "wayland-0" })).not.toBeNull();
});

// Cancel exits non-zero and prints nothing, which has to read back as null
// rather than an empty path — same contract as osascript and PowerShell.
test("Linux chooser resolves the printed path, null when canceled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chooser-path-"));
  const picks = join(dir, "zenity");
  writeFileSync(picks, "#!/bin/sh\necho /tmp/linux-picked\n");
  chmodSync(picks, 0o755);
  const picked = platformChooser("linux", { DISPLAY: ":0", PATH: dir })!;
  expect(await picked()).toBe("/tmp/linux-picked");

  const cancelDir = mkdtempSync(join(tmpdir(), "chooser-path-"));
  const cancels = join(cancelDir, "zenity");
  writeFileSync(cancels, "#!/bin/sh\nexit 1\n");
  chmodSync(cancels, 0o755);
  const canceled = platformChooser("linux", { DISPLAY: ":0", PATH: cancelDir })!;
  expect(await canceled()).toBeNull();
});

test("canChooseFolder reflects whether a chooser is installed", () => {
  expect(canChooseFolder()).toBe(false);
  setFolderChooser(async () => null);
  expect(canChooseFolder()).toBe(true);
});

test("chooseFolder resolves the picked path, null when canceled", async () => {
  setFolderChooser(async () => "/tmp/picked");
  expect(await chooseFolder()).toBe("/tmp/picked");
  setFolderChooser(async () => null);
  expect(await chooseFolder()).toBeNull();
});

test("concurrent calls share the one open dialog", async () => {
  let calls = 0;
  let release!: (v: string | null) => void;
  setFolderChooser(() => {
    calls++;
    return new Promise((r) => {
      release = r;
    });
  });
  const a = chooseFolder();
  const b = chooseFolder();
  release("/tmp/one");
  expect(await a).toBe("/tmp/one");
  expect(await b).toBe("/tmp/one");
  expect(calls).toBe(1);
  // The next call after settling opens a fresh dialog.
  const c = chooseFolder();
  release("/tmp/two");
  expect(await c).toBe("/tmp/two");
  expect(calls).toBe(2);
});

test("POST /api/choose-folder returns the picked path", async () => {
  setFolderChooser(async () => "/tmp/data");
  const m = matchApi("POST", "/api/choose-folder");
  expect(m).not.toBeNull();
  const res = await m!.handler(post(), {});
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ path: "/tmp/data" });
});

test("POST /api/choose-folder is 501 with no native chooser", async () => {
  const m = matchApi("POST", "/api/choose-folder")!;
  const res = await m.handler(post(), {});
  expect(res.status).toBe(501);
});

test("folder chooser route matches POST only", () => {
  expect(matchApi("GET", "/api/choose-folder")).toBeNull();
  expect(matchApi("PUT", "/api/choose-folder")).toBeNull();
});

// Picking the code repo to add the specs to as a submodule
// (specs/app/code-repo-submodule.feature.md "Choosing the code repo and the submodule's folder")
// titles the dialog for that. The request names a purpose, never the title
// itself — the title is spliced into the osascript and PowerShell.
test("the dialog title follows the purpose, never free text from the request", async () => {
  const titles: (string | undefined)[] = [];
  setFolderChooser(async (title) => {
    titles.push(title);
    return "/tmp/picked";
  });
  const m = matchApi("POST", "/api/choose-folder")!;
  const asking = (body: unknown) =>
    new Request("http://localhost/api/choose-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  await m.handler(post(), {});
  await m.handler(asking({ purpose: "code-repo" }), {});
  await m.handler(asking({ purpose: '" & do shell script "rm -rf ~' }), {});
  expect(titles).toEqual([
    FOLDER_TITLES["data-repo"],
    FOLDER_TITLES["code-repo"],
    FOLDER_TITLES["data-repo"],
  ]);
  expect(FOLDER_TITLES["code-repo"]).toBe("Choose the code repository");
});

test("the Linux dialog shows the title it is given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chooser-path-"));
  const echoes = join(dir, "zenity");
  // Prints its --title argument back as the "picked" path.
  writeFileSync(echoes, '#!/bin/sh\nfor a in "$@"; do case "$a" in --title=*) echo "${a#--title=}";; esac; done\n');
  chmodSync(echoes, 0o755);
  const chooser = platformChooser("linux", { DISPLAY: ":0", PATH: dir })!;
  expect(await chooser()).toBe(FOLDER_TITLES["data-repo"]);
  expect(await chooser(FOLDER_TITLES["code-repo"])).toBe("Choose the code repository");
});

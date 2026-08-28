// Automates specs/app-start.spec.md "picking the data directory with the
// native folder chooser": the chooser is pluggable (osascript on a macOS
// web server, PowerShell on a Windows one, Electron's dialog in the desktop
// app), one dialog is open at a time, and the endpoint reports 501 where no
// native chooser exists.

import { test, expect, afterEach, afterAll } from "bun:test";
import {
  canChooseFolder,
  chooseFolder,
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

// The desktop shells that run a local web server both ship a chooser; the
// Browse… button is hidden only where no dialog exists to open.
test("macOS and Windows get a chooser out of the box, others none", () => {
  expect(platformChooser("darwin")).not.toBeNull();
  expect(platformChooser("win32")).not.toBeNull();
  expect(platformChooser("linux")).toBeNull();
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

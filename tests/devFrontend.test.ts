// Automates specs/app/multiple-windows.feature.md "A development run": in
// `bun run dev:electron` the windows load the dev server's address, and the
// desktop process decides which of their requests it answers itself
// (src/electron/devFrontend.ts).

import { expect, test } from "bun:test";
import { devServerUrl, isDevServerRequest, needsShell } from "../src/electron/devFrontend";

test("a development run loads its windows from the dev server, on the port it listens on", () => {
  expect(devServerUrl({})).toBeNull();
  expect(devServerUrl({ PORT: "4000" })).toBeNull();
  expect(devServerUrl({ ELECTRON_DEV: "1" })).toBe("http://localhost:3000");
  expect(devServerUrl({ ELECTRON_DEV: "1", PORT: "4000" })).toBe("http://localhost:4000");
});

test("only requests to the dev server's own address pass through the desktop process", () => {
  const dev = "http://localhost:3000";
  expect(isDevServerRequest("http://localhost:3000/", dev)).toBe(true);
  expect(isDevServerRequest("http://localhost:3000/api/state?boot=1", dev)).toBe(true);
  expect(isDevServerRequest("http://localhost:3000/_bun/client/index.js", dev)).toBe(true);
  // Another port of this machine, another host, a look-alike host.
  expect(isDevServerRequest("http://localhost:3001/api/state", dev)).toBe(false);
  expect(isDevServerRequest("http://localhost:30000/", dev)).toBe(false);
  expect(isDevServerRequest("http://example.com/api/state", dev)).toBe(false);
  expect(isDevServerRequest("http://localhost:3000.example.com/", dev)).toBe(false);
  expect(isDevServerRequest("not a url", dev)).toBe(false);
  // The packaged app has no dev server: no http request is its own.
  expect(isDevServerRequest("http://localhost:3000/", null)).toBe(false);
});

test("a page the dev server has no route for loads the app shell, and a missing file stays missing", () => {
  const page = { method: "GET", accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
  expect(needsShell(page, 404)).toBe(true);
  // What the dev server does answer is its own answer.
  expect(needsShell(page, 200)).toBe(false);
  expect(needsShell(page, 500)).toBe(false);
  // A script, an image, a fetch.
  expect(needsShell({ method: "GET", accept: "*/*" }, 404)).toBe(false);
  expect(needsShell({ method: "GET", accept: null }, 404)).toBe(false);
  expect(needsShell({ method: "POST", accept: "text/html" }, 404)).toBe(false);
});

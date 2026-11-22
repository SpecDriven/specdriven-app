// git-operations.md "a spec folder that cannot be pushed to opens read
// only", on the page (issue #467): a folder whose remote turns this account's
// pushes down opens with a dialog that says so in the remote's words, a
// "Read only" chip beside its name, and its specs locked — no editor, no
// "new" buttons — instead of the struck-through Sync icon, a toast of git's
// output with the ssh host key drawn in it, and an editor promising saves
// that never leave the computer. Once access is granted, Check again makes
// the folder editable.
//
// This mounts the real App in happy-dom over the real API and a real clone
// (the harness of syncProblem.test.tsx). The origin's receive-pack answers
// the way GitHub answers an account without write access over ssh.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLFormElement",
  "Element",
  "Node",
  "Text",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "PopStateEvent",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
  "sessionStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const saved = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window | undefined;

beforeAll(() => {
  happyWindow = new Window({ url: "http://localhost/" });
  const w = happyWindow as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    let value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (w[key] ?? w.window);
    if (typeof value === "function" && /^[a-z]/.test(key)) value = (value as Function).bind(w);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  await happyWindow?.happyDOM.close();
});

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, fetchListing } from "../src/frontend/App";
import { setRepoReadOnly } from "../src/frontend/repoReadOnly";
import { setSyncProblem } from "../src/frontend/syncProblem";
import { handleApi, reloader } from "../src/server/api";
import { forgetWriteAccess, setGitEngine } from "../src/server/git";
import { reloadData } from "../src/server/reload";
import { writeState } from "../src/server/state";
import { git, twoClones } from "./helpers/fixtures";

let root: string;
let home: string;
let reactRoot: Root | undefined;
let host: HTMLElement | undefined;
const realFetch = globalThis.fetch;
const realRoot = process.env.SPECDRIVEN_ROOT;
const realHome = process.env.SPECDRIVEN_HOME;

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  host?.remove();
  reactRoot = undefined;
  globalThis.fetch = realFetch;
  setSyncProblem(null);
  setRepoReadOnly(null);
  sessionStorage.clear();
  forgetWriteAccess();
  reloader.stop();
  setGitEngine(null);
  if (root) await rm(root, { recursive: true, force: true });
  if (home) await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", realRoot],
    ["SPECDRIVEN_HOME", realHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function openLink(path: string) {
  happyWindow!.happyDOM.setURL(`http://localhost${path}`);
  host = document.createElement("div");
  document.body.appendChild(host);
  reactRoot = createRoot(host);
  await act(async () => reactRoot!.render(<App />));
}

/** Waits for the app's fetches and renders to settle on `done`. */
async function until(done: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (done()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  throw new Error(`gave up waiting for ${what}; the page shows: ${host?.textContent?.slice(0, 400)}`);
}

const dialog = () => host!.querySelector<HTMLElement>(".read-only-repo-dialog");
const chip = () => host!.querySelector<HTMLButtonElement>("button.repo-read-only");
const syncButton = () => host!.querySelector<HTMLButtonElement>("button.repo-sync");
const toasts = (kind: string) =>
  [...host!.querySelectorAll<HTMLElement>(`.toast.${kind} .toast-message`)].map((el) => el.textContent ?? "");
const button = (scope: HTMLElement, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label) ?? null;

test("a folder this account cannot push to opens read only with a dialog, and Check again unlocks it once access is granted", async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-readonly-page-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-readonly-page-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
  setGitEngine("cli");
  const { a: data, originDir } = await twoClones(root);
  // No cron: the ticks below are the test's own.
  await writeState({ dataRepo: "a", reloadFrequencySeconds: 0 }, root);
  await reloadData(root);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost/");
    const res = await handleApi(new Request(url, init));
    return res ?? new Response("Not found", { status: 404 });
  }) as typeof fetch;

  // The origin answers like GitHub to an account that may read but not write.
  const script = join(root, "refuse-receive-pack.sh");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      "echo 'Host key fingerprint is SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM' >&2",
      "echo '+---[ECDSA 256]---+' >&2",
      "echo '|       .o=X*+ .o.|' >&2",
      "echo '+----[SHA256]-----+' >&2",
      "echo 'ERROR: Write access to repository not granted.' >&2",
      "exit 128",
      "",
    ].join("\n"),
  );
  await chmod(script, 0o755);
  await git(data, "config", "remote.origin.receivepack", script);
  // As in the issue: an edit was saved before anyone knew, and its push failed.
  await Bun.write(join(data, "README.md"), "# Project\n\nedited\n");
  expect(await reloadData(root)).toContain("push failed");

  await openLink("/");
  await until(() => dialog() !== null, "the read-only dialog");
  expect(dialog()!.textContent).toContain("This folder is read only");
  expect(dialog()!.textContent).toContain("ERROR: Write access to repository not granted.");
  expect(dialog()!.textContent).not.toContain("Host key fingerprint");
  expect(chip()?.textContent).toContain("Read only");
  // The push's error is not thrown at the user a second time, as a toast,
  // and Sync is not drawn as failing: the folder is read only, not broken.
  expect(toasts("error").some((m) => m.startsWith("Saved changes are not being pushed"))).toBe(false);
  expect(syncButton()?.classList.contains("failing")).toBe(false);
  // The specs are locked: the README is a page, nothing can be created.
  await act(async () => button(dialog()!, "OK")!.click());
  expect(dialog()).toBeNull();
  await until(() => host!.querySelector(".read-only-page") !== null, "the README shown as a page");
  expect(host!.querySelector(".readme-hint")).toBeNull();
  expect(host!.querySelector('button[aria-label="New folder"]')).toBeNull();
  expect(host!.querySelector(".layout")?.classList.contains("read-only")).toBe(true);

  // Write access granted: the chip reopens the dialog, Check again unlocks.
  await git(data, "config", "--unset", "remote.origin.receivepack");
  await act(async () => chip()!.click());
  await until(() => dialog() !== null, "the dialog again from the chip");
  await act(async () => button(dialog()!, "Check again")!.click());
  await until(() => dialog() === null && chip() === null, "the folder to unlock");
  expect(toasts("success")).toContain("a can be edited again");
  // The edit the refused push left behind goes up with the unlock, and its
  // old error never reaches the page.
  const originLog = await $`git -C ${originDir} log --format=%s main`.quiet();
  expect(originLog.stdout.toString()).toContain("README.md");
  expect(toasts("error").some((m) => m.startsWith("Saved changes are not being pushed"))).toBe(false);
  expect(syncButton()?.classList.contains("failing")).toBe(false);
  await until(() => host!.querySelector(".readme-hint") !== null, "the README editor back");
  expect(host!.querySelector(".layout")?.classList.contains("read-only")).toBe(false);
});

test("the listing carries why the folder is read only, and null when it is not", async () => {
  const reply = (body: object) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const noRemote = await fetchListing(reply({ features: [], readOnlyRepo: { kind: "no-remote" } }));
  expect("listing" in noRemote && noRemote.listing.readOnlyRepo).toEqual({ kind: "no-remote" });
  const denied = await fetchListing(
    reply({ features: [], readOnlyRepo: { kind: "denied", remote: "git@github.com:o/r.git", reason: "ERROR: no" } }),
  );
  expect("listing" in denied && denied.listing.readOnlyRepo).toEqual({
    kind: "denied",
    remote: "git@github.com:o/r.git",
    reason: "ERROR: no",
  });
  // An older server sends no such field.
  const older = await fetchListing(reply({ features: [] }));
  expect("listing" in older && older.listing.readOnlyRepo).toBeNull();
});

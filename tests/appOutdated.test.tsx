// The update screen (specs/app/data-format.feature.md) in
// src/frontend/AppOutdated.tsx: what the user is told to install and run on
// each platform, and the one place the client notices a blocked folder.
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_INSTALL, type InstallState } from "../src/server/appUpdate";
import { EMPTY_UPDATE, type UpdateIndex, type UpdateStore } from "../src/frontend/appUpdate";
import {
  AppOutdatedView,
  DATA_TOO_NEW_HEADER,
  upgradeInstructions,
  watchDataTooNew,
  type UpgradePlatform,
} from "../src/frontend/AppOutdated";

const noop = () => {};
const index = (extra: Partial<UpdateIndex> = {}): UpdateIndex => ({
  runtime: "desktop",
  bun: "/usr/local/bin/bun",
  source: { dir: "/h/app/specdriven-0.1.150", version: "0.1.150", match: true, mode: "installed" },
  shell: "/bin/sh",
  canActivate: true,
  reasons: [],
  current: "0.1.150",
  platform: "darwin",
  canInstall: true,
  check: null,
  install: EMPTY_INSTALL,
  ...extra,
});
const render = (
  platform: UpgradePlatform,
  minAppVersion: string | null = "0.1.160",
  update: UpdateStore = EMPTY_UPDATE,
  updating = false,
) =>
  renderToStaticMarkup(
    <AppOutdatedView
      appVersion="0.1.150"
      minAppVersion={minAppVersion}
      platform={platform}
      checking={false}
      onCheckAgain={noop}
      update={update}
      updating={updating}
      onInstall={noop}
      onControl={noop}
    />,
  );
const buttons = (markup: string) =>
  [...markup.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map(([, cls, label]) => `${label} (${cls})`);

describe("AppOutdated — data saved by a newer app blocks this one", () => {
  test("it names the version the folder needs and the one running", () => {
    const markup = render("unix");
    expect(markup).toMatch(/role="alert".*<h1>Update to latest version<\/h1>/);
    expect(markup).toContain("<strong>0.1.160</strong> or later");
    expect(markup).toContain("You are running 0.1.150.");
    expect(markup).toContain("Check again");
    expect(markup).not.toContain("Open another folder");
  });

  test("where the app can update itself, Install & restart leads, as on the Updates page", () => {
    const markup = render("desktop", "0.1.160", { ...EMPTY_UPDATE, index: index() });
    expect(buttons(markup)).toEqual(["Install &amp; restart (btn btn-primary)", "Check again (btn)"]);
  });

  test("where it cannot, Check again is the one button and the instructions stay", () => {
    const markup = render("unix", "0.1.160", { ...EMPTY_UPDATE, index: index({ canInstall: false }) });
    expect(buttons(markup)).toEqual(["Copy (btn)", "Check again (btn btn-primary)"]);
    expect(markup).toContain("install.sh | sh");
  });

  test("once Install & restart is pressed, the installer's progress and Restart now take the instructions' place", () => {
    const found = { current: "0.1.150", latest: "0.1.160", newer: true, url: "https://example.test/v0.1.160", checkedAt: "2026-11-23T10:00:00Z" };
    const installing: InstallState = { ...EMPTY_INSTALL, phase: "installing", version: "0.1.160", log: ["Downloading"], startedAt: "2026-11-23T10:00:00Z" };
    const building = render("unix", "0.1.160", { ...EMPTY_UPDATE, index: index({ check: found, install: installing }) }, true);
    expect(building).toContain("Installing SpecDriven 0.1.160…");
    expect(building).toContain("Downloading");
    expect(building).not.toContain("install.sh | sh");
    expect(buttons(building)).toEqual(["Check again (btn)"]);

    // An install already done shows where it stands even before a press.
    const ready = render("unix", "0.1.160", { ...EMPTY_UPDATE, index: index({ check: found, install: { ...installing, phase: "ready" } }) });
    expect(buttons(ready)).toEqual(["Restart now (btn btn-primary)", "Check again (btn)"]);

    // A failed install offers to try again, but not the release check — Check again is the folder's.
    const failed = render("unix", "0.1.160", { ...EMPTY_UPDATE, index: index({ check: found, install: { ...installing, phase: "failed", error: "exit 1" } }) }, true);
    expect(buttons(failed)).toEqual(["Install &amp; restart (btn btn-primary)", "Check again (btn)"]);
  });

  test("a folder that names no version still says to update", () => {
    const markup = render("unix", null);
    expect(markup).not.toContain("<strong>");
    expect(markup).toContain("Install the latest version");
  });

  test("macOS and Linux get the curl installer", () => {
    expect(render("unix")).toContain(
      "curl -fsSL https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.sh | sh",
    );
  });

  test("Windows gets the PowerShell installer", () => {
    const markup = render("windows");
    expect(markup).toContain("In PowerShell, run:");
    expect(markup).toContain(
      "irm https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.ps1 | iex",
    );
  });

  test("the desktop app points at the latest release", () => {
    expect(upgradeInstructions("desktop").command).toBeNull();
    const markup = render("desktop");
    expect(markup).not.toContain("<code");
    expect(markup).toContain(
      'href="https://github.com/SpecDriven/specdriven-app/releases/latest"',
    );
  });
});

describe("watchDataTooNew", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const answering = (headers: Record<string, string>) =>
    (async () => new Response("{}", { headers })) as unknown as typeof fetch;

  test("an answer carrying the header reports the version it asks for", async () => {
    globalThis.fetch = answering({ [DATA_TOO_NEW_HEADER]: "0.1.160" });
    const seen: (string | null)[] = [];
    const stop = watchDataTooNew((v) => seen.push(v));
    await fetch("/api/features");
    stop();
    expect(seen).toEqual(["0.1.160"]);
  });

  test("an empty header still reports, with no version", async () => {
    globalThis.fetch = answering({ [DATA_TOO_NEW_HEADER]: "" });
    const seen: (string | null)[] = [];
    const stop = watchDataTooNew((v) => seen.push(v));
    await fetch("/api/features");
    stop();
    expect(seen).toEqual([null]);
  });

  test("ordinary answers pass through, and stopping restores fetch", async () => {
    const plain = answering({});
    globalThis.fetch = plain;
    const seen: (string | null)[] = [];
    const stop = watchDataTooNew((v) => seen.push(v));
    expect(globalThis.fetch).not.toBe(plain);
    await fetch("/api/features");
    stop();
    expect(seen).toEqual([]);
    expect(globalThis.fetch).toBe(plain);
  });
});

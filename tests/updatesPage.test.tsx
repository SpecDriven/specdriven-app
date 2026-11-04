// specs/app/app-updates.feature.md on the client: the stage the page is at,
// its headline and controls, and the markup for each — the installer's
// output while it builds, the one-liner where the app cannot update itself.
// Pure helpers and static markup — no DOM.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_INSTALL, type InstallState } from "../src/server/appUpdate";
import { EMPTY_UPDATE, logTail, updateControls, updateHeadline, updateStage, type UpdateIndex, type UpdateStore } from "../src/frontend/appUpdate";
import { MAC_ADMIN_NOTE, UpdateStatus, upgradePlatform } from "../src/frontend/UpdatesPage";

const index = (extra: Partial<UpdateIndex> = {}): UpdateIndex => ({
  runtime: "desktop",
  bun: "/usr/local/bin/bun",
  source: { dir: "/h/app/specdriven-0.1.220", version: "0.1.220", match: true, mode: "installed" },
  shell: "/bin/sh",
  canActivate: true,
  reasons: [],
  current: "0.1.220",
  platform: "darwin",
  canInstall: true,
  check: null,
  install: EMPTY_INSTALL,
  ...extra,
});

const found = { current: "0.1.220", latest: "0.1.221", newer: true, url: "https://github.com/SpecDriven/specdriven-app/releases/tag/v0.1.221", checkedAt: "2026-11-02T10:00:00Z" };
const installing: InstallState = { ...EMPTY_INSTALL, phase: "installing", version: "0.1.221", log: ["Downloading", "Building"], startedAt: "2026-11-02T10:00:00Z" };
const store = (extra: Partial<UpdateStore> = {}): UpdateStore => ({ ...EMPTY_UPDATE, ...extra });

describe("where the update stands", () => {
  test("each stage has its headline and its controls", () => {
    expect(updateStage(store())).toEqual({ kind: "loading" });
    expect(updateHeadline({ kind: "loading" })).toBe("Loading…");
    expect(updateControls({ kind: "loading" }, true)).toEqual([]);

    const unchecked = updateStage(store({ index: index() }));
    expect(unchecked).toEqual({ kind: "unchecked", current: "0.1.220" });
    expect(updateControls(unchecked, true)).toEqual(["check"]);

    expect(updateStage(store({ index: index(), checking: true }))).toEqual({ kind: "checking", current: "0.1.220" });

    const upToDate = updateStage(store({ index: index({ check: { ...found, latest: "0.1.220", newer: false } }) }));
    expect(upToDate).toEqual({ kind: "up-to-date", current: "0.1.220", checkedAt: found.checkedAt });
    expect(updateHeadline(upToDate)).toBe("SpecDriven 0.1.220 is up to date.");

    const available = updateStage(store({ index: index({ check: found }) }));
    expect(available).toEqual({ kind: "available", current: "0.1.220", latest: "0.1.221", url: found.url });
    expect(updateHeadline(available)).toBe("SpecDriven 0.1.221 is available. You are running 0.1.220.");
    expect(updateControls(available, true)).toEqual(["install", "check-again"]);
    // Where it cannot install here, the one-liner takes Install's place.
    expect(updateControls(available, false)).toEqual(["check-again"]);

    const building = updateStage(store({ index: index({ check: found, install: installing }) }));
    expect(building).toEqual({ kind: "installing", version: "0.1.221" });
    expect(updateControls(building, true)).toEqual([]);

    const ready = updateStage(store({ index: index({ check: found, install: { ...installing, phase: "ready", sourceDir: "/h/app/specdriven-0.1.221" } }) }));
    expect(ready).toEqual({ kind: "ready", version: "0.1.221" });
    expect(updateHeadline(ready)).toBe("SpecDriven 0.1.221 is installed. Restart to use it.");
    expect(updateControls(ready, true)).toEqual(["restart"]);

    const failed = updateStage(store({ index: index({ check: found, install: { ...installing, phase: "failed", error: "The installer failed (exit 1)" } }) }));
    expect(failed).toEqual({ kind: "failed", version: "0.1.221", error: "The installer failed (exit 1)" });
    expect(updateControls(failed, true)).toEqual(["install", "check-again"]);

    expect(updateStage(store({ index: index({ install: { ...installing, phase: "ready" } }), restarting: true }))).toEqual({ kind: "restarting", version: "0.1.221" });
  });

  test("the installer's last lines are what the page shows", () => {
    const log = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    expect(logTail({ ...installing, log })).toEqual(log.slice(18));
    expect(logTail({ ...installing, log }, 2)).toEqual(["line 28", "line 29"]);
  });
});

describe("the page", () => {
  const render = (s: UpdateStore, platform: "desktop" | "unix" | "windows" = "desktop") =>
    renderToStaticMarkup(<UpdateStatus store={s} platform={platform} onControl={() => {}} />);

  test("a newer release offers Install & restart and says what installing does", () => {
    const html = render(store({ index: index({ check: found }) }));
    expect(html).toContain("SpecDriven 0.1.221 is available. You are running 0.1.220.");
    expect(html).toContain("Install &amp; restart");
    expect(html).toContain("Check again");
    expect(html).toContain(`href="${found.url}"`);
    expect(html).toContain("fetches Electron and takes a few minutes");
    expect(html).not.toContain("curl -fsSL");
  });

  test("on macOS, a newer release warns that Admin privileges may be needed", () => {
    expect(render(store({ index: index({ check: found }) }))).toContain(MAC_ADMIN_NOTE);
    const failed = { ...installing, phase: "failed" as const, error: "The installer failed (exit 1)" };
    expect(render(store({ index: index({ check: found, install: failed }) }))).toContain(MAC_ADMIN_NOTE);
    // Not on other machines, nor before a newer release is found or once it is installing.
    expect(render(store({ index: index({ check: found, platform: "linux" }) }))).not.toContain(MAC_ADMIN_NOTE);
    expect(render(store({ index: index({ check: found, platform: "win32" }) }))).not.toContain(MAC_ADMIN_NOTE);
    expect(render(store({ index: index() }))).not.toContain(MAC_ADMIN_NOTE);
    expect(render(store({ index: index({ check: found, install: installing }) }))).not.toContain(MAC_ADMIN_NOTE);
  });

  test("while installing, the installer's output is on the page and nothing is offered", () => {
    const html = render(store({ index: index({ check: found, install: installing }) }));
    expect(html).toContain("Installing SpecDriven 0.1.221…");
    expect(html).toContain("Downloading\nBuilding");
    expect(html).not.toContain("<button");
  });

  test("a failed install shows the reason, the output and the way to try again", () => {
    const html = render(store({ index: index({ check: found, install: { ...installing, phase: "failed", error: "The installer failed (exit 2)" } }) }));
    expect(html).toContain("SpecDriven 0.1.221 did not install.");
    expect(html).toContain("The installer failed (exit 2)");
    expect(html).toContain("Downloading\nBuilding");
    expect(html).toContain("Install &amp; restart");
  });

  test("where the app cannot update itself, the reasons and the installer one-liner take Install's place", () => {
    const web = index({ runtime: "web", canActivate: false, canInstall: false, reasons: ["The web server cannot replace itself: run the installer again, then start it"], check: found });
    const html = render(store({ index: web }), "unix");
    expect(html).toContain("The web server cannot replace itself");
    expect(html).toContain("curl -fsSL https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.sh | sh");
    expect(html).not.toContain("Install &amp; restart");
    expect(render(store({ index: web }), "windows")).toContain("irm https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.ps1 | iex");
    // The desktop app's remedy is the installer too, for the machine the server runs on.
    expect(upgradePlatform(index({ platform: "darwin" }))).toBe("unix");
    expect(upgradePlatform(index({ platform: "linux" }))).toBe("unix");
    expect(upgradePlatform(index({ platform: "win32" }))).toBe("windows");
  });

  test("a restart the shell could not do says so, with the new app's path", () => {
    const ready = index({ check: found, install: { ...installing, phase: "ready", sourceDir: "/h/app/specdriven-0.1.221" } });
    const html = render(store({ index: ready, manual: { restart: "manual", reason: "/Applications is not writable", path: "/h/app/specdriven-0.1.221/release/mac-arm64/SpecDriven.app" } }));
    expect(html).toContain("/Applications is not writable — the new app is at /h/app/specdriven-0.1.221/release/mac-arm64/SpecDriven.app");
    expect(html).toContain("Restart now");
  });
});

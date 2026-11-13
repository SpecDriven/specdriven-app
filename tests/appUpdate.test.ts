// Automates specs/app/app-updates.feature.md over the module and the routes:
// the newest release is found the way install.sh finds it, an update is
// installed by the installer that shipped in the running app's source —
// told not to start anything — and the restart is handed to whatever the
// runtime registered. The releases page is the loopback stand-in the
// installer tests use (tests/helpers/fakeReleases.ts); the installer is a
// stand-in that records what it was asked and leaves what a real run leaves.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { version as appVersion } from "../package.json";
import { handleApi } from "../src/server/api";
import {
  builtApp,
  checkForUpdate,
  DAILY_CHECK_MS,
  dailyCheckSettled,
  installState,
  installUpdate,
  installerCommand,
  latestFromLocation,
  maybeCheckDaily,
  NO_ACTIVATOR,
  findShell,
  preconditions,
  releasesUrl,
  resetUpdateState,
  restartIntoUpdate,
  setUpdateDeps,
  SHELL_MISSING,
  sourceMismatch,
  streamRun,
  updateAvailable,
  WEB_RUNTIME,
  type StreamOptions,
  type StreamRunner,
  type UpdateIndex,
} from "../src/server/appUpdate";
import { setActivator } from "../src/server/relaunch";
import { NO_SOURCE } from "../src/server/selfFix";
import { fakeReleases } from "./helpers/fakeReleases";

const NEWER = "9.9.9";

let root: string;
let home: string;
/** ~/.specdriven/app, with `current` on the running version's tree. */
let appDir: string;
let source: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["SPECDRIVEN_ROOT", "SPECDRIVEN_HOME", "SPECDRIVEN_APP_SOURCE", "SPECDRIVEN_RELEASES_URL", "DEMO_MODE", "SPECDRIVEN_HOSTED", "PATH"];

/** A package tree like install.sh unpacks: package.json, src/, install.sh, no .git. */
async function makeSource(dir: string, version: string): Promise<void> {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "specdriven", version }));
  await writeFile(join(dir, "install.sh"), "#!/bin/sh\nexit 0\n");
}

/** What `build:desktop --local` leaves: the .app on a Mac, the AppImage on Linux. */
async function makeBuilt(dir: string, os: NodeJS.Platform = process.platform): Promise<string> {
  if (os === "darwin") {
    const exe = join(dir, "release", "mac-arm64", "SpecDriven.app", "Contents", "MacOS", "SpecDriven");
    await mkdir(dirname(exe), { recursive: true });
    await writeFile(exe, "");
    return join(dir, "release", "mac-arm64", "SpecDriven.app");
  }
  if (os === "win32") {
    const exe = join(dir, "release", "win-unpacked", "SpecDriven.exe");
    await mkdir(dirname(exe), { recursive: true });
    await writeFile(exe, "");
    return exe;
  }
  const image = join(dir, "release", `SpecDriven-${NEWER}-x86_64.AppImage`);
  await mkdir(dirname(image), { recursive: true });
  await writeFile(image, "");
  return image;
}

async function pointCurrent(version: string): Promise<void> {
  await rm(join(appDir, "current"), { force: true });
  await symlink(`specdriven-${version}`, join(appDir, "current"));
}

/** An installer stand-in that does what the real one leaves behind, and records its call. */
function fakeInstaller(opts: { exitCode?: number; build?: boolean; moveCurrent?: boolean; lines?: string[] } = {}) {
  const calls: { cmd: string; args: string[]; opts: StreamOptions }[] = [];
  const runner: StreamRunner = async (cmd, args, o) => {
    calls.push({ cmd, args, opts: o });
    for (const line of opts.lines ?? ["Downloading SpecDriven 9.9.9 source…", "Building the desktop app"]) o.onLine(line);
    if (opts.exitCode) return { exitCode: opts.exitCode };
    const target = join(appDir, `specdriven-${NEWER}`);
    await makeSource(target, NEWER);
    if (opts.build !== false) await makeBuilt(target);
    if (opts.moveCurrent !== false) await pointCurrent(NEWER);
    return { exitCode: 0 };
  };
  return { runner, calls };
}

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ) as Promise<Response>;
}

beforeEach(async () => {
  for (const name of ENV) saved[name] = process.env[name];
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-update-")));
  home = join(root, "home");
  appDir = join(home, "app");
  source = join(appDir, `specdriven-${appVersion}`);
  await makeSource(source, appVersion);
  await pointCurrent(appVersion);
  process.env.SPECDRIVEN_ROOT = join(root, "data");
  await mkdir(join(root, "data"), { recursive: true });
  process.env.SPECDRIVEN_HOME = home;
  for (const name of ["SPECDRIVEN_APP_SOURCE", "SPECDRIVEN_RELEASES_URL", "DEMO_MODE", "SPECDRIVEN_HOSTED"]) delete process.env[name];
  resetUpdateState();
  setUpdateDeps({ runtime: () => "desktop" });
  setActivator(async () => ({ restart: "relaunching" }));
});

afterEach(async () => {
  resetUpdateState();
  setActivator(null);
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await rm(root, { recursive: true, force: true });
});

describe("the newest release", () => {
  test("the releases page's `latest` redirect names it, as it does for the installer", async () => {
    const releases = fakeReleases(NEWER, { [NEWER]: { assets: {} } });
    try {
      const check = await checkForUpdate({ releasesUrl: releases.url, current: "0.1.220", now: new Date("2026-11-02T10:00:00Z") });
      expect(check).toEqual({
        current: "0.1.220",
        latest: NEWER,
        newer: true,
        url: `${releases.url}/tag/v${NEWER}`,
        checkedAt: "2026-11-02T10:00:00.000Z",
      });
      expect(releases.hits).toEqual(["/latest"]);
    } finally {
      releases.stop();
    }
  });

  test("the version running, or a newer one, is up to date", async () => {
    const releases = fakeReleases("0.1.220", { "0.1.220": { assets: {} } });
    try {
      expect((await checkForUpdate({ releasesUrl: releases.url, current: "0.1.220" })).newer).toBe(false);
      expect((await checkForUpdate({ releasesUrl: releases.url, current: "0.1.221" })).newer).toBe(false);
    } finally {
      releases.stop();
    }
  });

  test("a page that does not redirect to a release tag, or cannot be reached, is an error in so many words", async () => {
    const nowhere = fakeReleases("nope", {});
    const url = nowhere.url;
    await expect(checkForUpdate({ releasesUrl: url })).rejects.toThrow(`could not find the latest release at ${url}/latest`);
    nowhere.stop();
    await expect(checkForUpdate({ releasesUrl: url })).rejects.toThrow(`could not reach ${url}/latest`);
    expect(latestFromLocation("https://github.com/SpecDriven/specdriven-app/releases/tag/v0.1.221")).toBe("0.1.221");
    expect(latestFromLocation("https://github.com/SpecDriven/specdriven-app/releases")).toBeNull();
    expect(latestFromLocation("/releases/tag/windows-v0.1.221")).toBeNull();
    expect(latestFromLocation(null)).toBeNull();
  });

  test("the releases page is SPECDRIVEN_RELEASES_URL, as install.sh reads it, else the app's own", () => {
    expect(releasesUrl({})).toBe("https://github.com/SpecDriven/specdriven-app/releases");
    expect(releasesUrl({ SPECDRIVEN_RELEASES_URL: "http://127.0.0.1:9/releases/" })).toBe("http://127.0.0.1:9/releases");
  });
});

describe("whether an update can install here", () => {
  test("the desktop app with Bun, its source and a shell can; each missing piece is a reason", async () => {
    const ready = await preconditions();
    expect(ready.reasons).toEqual([]);
    expect(ready.source?.dir).toBe(source);
    expect(ready.bun).not.toBeNull();
    expect(ready.shell).toBe(await findShell());
    expect(ready.shell).not.toBeNull();

    setUpdateDeps({ runtime: () => "web" });
    expect((await preconditions()).reasons).toEqual([WEB_RUNTIME]);
    setUpdateDeps({ runtime: () => "desktop" });

    setActivator(null);
    expect((await preconditions()).reasons).toEqual([NO_ACTIVATOR]);
    setActivator(async () => ({ restart: "relaunching" }));

    // Without a PATH, sh is still where every Unix keeps it; Bun may still be where install.sh puts it.
    process.env.PATH = "";
    expect((await preconditions()).reasons).not.toContain(SHELL_MISSING);
    expect(SHELL_MISSING).toContain("sh is needed");
    process.env.PATH = saved.PATH ?? "";

    // No source anywhere (a developer's checkout would otherwise stand in).
    process.env.SPECDRIVEN_APP_SOURCE = join(root, "nowhere");
    expect((await preconditions()).reasons).toEqual([NO_SOURCE]);
    delete process.env.SPECDRIVEN_APP_SOURCE;

    await makeSource(join(appDir, "specdriven-0.0.1"), "0.0.1");
    await pointCurrent("0.0.1");
    const stale = await preconditions();
    expect(stale.reasons).toEqual([sourceMismatch(stale.source!)]);
    expect(stale.reasons[0]).toContain("0.0.1");
  });
});

describe("installing an update", () => {
  test("the installer in the running app's source does it, told the version and not to start anything", async () => {
    const installer = fakeInstaller();
    const { state, done } = await installUpdate(NEWER, { runner: installer.runner });
    expect(state.phase).toBe("installing");
    expect(state.version).toBe(NEWER);
    const final = await done;
    expect(final.phase).toBe("ready");
    expect(final.sourceDir).toBe(join(appDir, `specdriven-${NEWER}`));
    expect(final.error).toBeNull();
    expect(final.log).toEqual(["Downloading SpecDriven 9.9.9 source…", "Building the desktop app"]);
    expect(installState()).toEqual(final);

    const [call] = installer.calls;
    expect(call!.cmd).toBe((await findShell())!);
    expect(call!.args).toEqual([join(source, "install.sh")]);
    expect(call!.opts.cwd).toBe(source);
    const { env } = call!.opts;
    expect(env.SPECDRIVEN_VERSION).toBe(NEWER);
    expect(env.SPECDRIVEN_INSTALL_BUN).toBe("0");
    expect(env.SPECDRIVEN_HANDOVER).toBe("0");
    expect(env.SPECDRIVEN_HOME).toBe(home);
    expect(env.PATH!.split(":")[0]).toBe(dirname((await preconditions()).bun!));
  });

  test("on Windows it is install.ps1, run as a file by PowerShell", () => {
    expect(installerCommand("C:\\u\\.specdriven\\app\\specdriven-1.0.0", "C:\\ps\\powershell.exe", "win32")).toEqual({
      cmd: "C:\\ps\\powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join("C:\\u\\.specdriven\\app\\specdriven-1.0.0", "install.ps1")],
    });
    expect(installerCommand("/h/app/specdriven-1.0.0", "/bin/sh", "darwin")).toEqual({ cmd: "/bin/sh", args: ["/h/app/specdriven-1.0.0/install.sh"] });
  });

  test("a version that is not newer, not a version, or already installing is refused", async () => {
    await expect(installUpdate(appVersion)).rejects.toThrow(`${appVersion} does not come after the running ${appVersion}`);
    await expect(installUpdate("latest")).rejects.toThrow('"latest" is not a release version');
    // The version names a directory the restart starts an executable from:
    // nothing that could step out of it, or carry anything along, gets by.
    for (const bad of ["9.9.9/../../elsewhere", "../9.9.9", "9.9.9 ", "9.9.9\n", "9.9.9;id", "v9.9.9", "9.9"]) {
      await expect(installUpdate(bad)).rejects.toThrow("is not a release version");
    }
    let release!: () => void;
    const slow: StreamRunner = () => new Promise((r) => (release = () => r({ exitCode: 1 })));
    const { done } = await installUpdate(NEWER, { runner: slow });
    await expect(installUpdate(NEWER)).rejects.toThrow(`SpecDriven ${NEWER} is still installing`);
    release();
    expect((await done).phase).toBe("failed");
  });

  test("an installer that fails, or finishes without what it promised, leaves a failed install and changes nothing that runs", async () => {
    const failed = await (await installUpdate(NEWER, { runner: fakeInstaller({ exitCode: 2, lines: ["checksum mismatch"] }).runner })).done;
    expect(failed.phase).toBe("failed");
    expect(failed.error).toBe("The installer failed (exit 2)");
    expect(failed.log).toEqual(["checksum mismatch"]);
    expect(await realpath(join(appDir, "current"))).toBe(source);
    await expect(restartIntoUpdate()).rejects.toThrow("Install the update before restarting");

    resetUpdateState();
    setUpdateDeps({ runtime: () => "desktop" });
    const unbuilt = await (await installUpdate(NEWER, { runner: fakeInstaller({ build: false }).runner })).done;
    expect(unbuilt.phase).toBe("failed");
    expect(unbuilt.error).toContain("no built app under");

    resetUpdateState();
    setUpdateDeps({ runtime: () => "desktop" });
    await rm(join(appDir, `specdriven-${NEWER}`), { recursive: true, force: true });
    await pointCurrent(appVersion);
    const unmoved = await (await installUpdate(NEWER, { runner: fakeInstaller({ moveCurrent: false }).runner })).done;
    expect(unmoved.phase).toBe("failed");
    expect(unmoved.error).toContain(`\`current\` points at specdriven-${appVersion}, not specdriven-${NEWER}`);
  });

  test("the installer's output is kept, newest last, to the last thousand lines", async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
    const final = await (await installUpdate(NEWER, { runner: fakeInstaller({ lines }).runner })).done;
    expect(final.log.length).toBe(1000);
    expect(final.log[0]).toBe("line 500");
    expect(final.log.at(-1)).toBe("line 1499");
  });

  test("the real runner streams a command's output line by line and reports a command that is not there", async () => {
    const seen: string[] = [];
    const ok = await streamRun((await findShell())!, ["-c", "echo one; echo two >&2; printf three"], { env: process.env, onLine: (l) => seen.push(l) });
    expect(ok.exitCode).toBe(0);
    expect(seen.sort()).toEqual(["one", "three", "two"]);
    const missing = await streamRun(join(root, "no-such-command"), [], { env: process.env, onLine: (l) => seen.push(l) });
    expect(missing.exitCode).toBe(1);
    expect(seen.at(-1)).toContain("ENOENT");
  });

  test("the built app is the .app, the AppImage or the unpacked exe the local build leaves", async () => {
    expect(await builtApp(source, "darwin")).toBeNull();
    const mac = join(root, "mac");
    expect(await builtApp(mac, "darwin")).toBeNull();
    await makeBuilt(mac, "darwin");
    expect(await builtApp(mac, "darwin")).toBe(join(mac, "release", "mac-arm64", "SpecDriven.app"));
    const linux = join(root, "linux");
    await makeBuilt(linux, "linux");
    expect(await builtApp(linux, "linux")).toBe(join(linux, "release", `SpecDriven-${NEWER}-x86_64.AppImage`));
    const win = join(root, "win");
    await makeBuilt(win, "win32");
    expect(await builtApp(win, "win32")).toBe(join(win, "release", "win-unpacked", "SpecDriven.exe"));
  });
});

describe("restarting into the update", () => {
  test("the runtime's activator gets the new source tree; without one the new app's path is handed back", async () => {
    const asked: string[] = [];
    setActivator(async (dir) => {
      asked.push(dir);
      return { restart: "relaunching" };
    });
    await (await installUpdate(NEWER, { runner: fakeInstaller().runner })).done;
    expect(await restartIntoUpdate()).toEqual({ restart: "relaunching" });
    expect(asked).toEqual([join(appDir, `specdriven-${NEWER}`)]);

    setActivator(null);
    expect(await restartIntoUpdate()).toEqual({
      restart: "manual",
      reason: NO_ACTIVATOR,
      path: await builtApp(join(appDir, `specdriven-${NEWER}`)),
    });
  });
});

describe("the routes", () => {
  test("GET says where things stand; check, install and restart drive them", async () => {
    const releases = fakeReleases(NEWER, { [NEWER]: { assets: {} } });
    process.env.SPECDRIVEN_RELEASES_URL = releases.url;
    const installer = fakeInstaller();
    setUpdateDeps({ runtime: () => "desktop", runner: installer.runner });
    try {
      const before = (await (await api("/api/app-update")).json()) as UpdateIndex;
      expect(before.current).toBe(appVersion);
      expect(before.canInstall).toBe(true);
      expect(before.check).toBeNull();
      expect(before.install.phase).toBe("idle");

      const checked = await api("/api/app-update/check", "POST");
      expect(checked.status).toBe(200);
      expect(((await checked.json()) as { check: { latest: string; newer: boolean } }).check).toMatchObject({ latest: NEWER, newer: true });

      // No version in the body: the one just found.
      const started = await api("/api/app-update/install", "POST", {});
      expect(started.status).toBe(202);
      expect(((await started.json()) as { install: { phase: string; version: string } }).install).toMatchObject({ phase: "installing", version: NEWER });
      for (let i = 0; i < 100 && installState().phase === "installing"; i++) await Bun.sleep(10);
      const after = (await (await api("/api/app-update")).json()) as UpdateIndex;
      expect(after.install.phase).toBe("ready");
      expect(after.install.log.length).toBeGreaterThan(0);

      const restarted = await api("/api/app-update/restart", "POST");
      expect(restarted.status).toBe(200);
      expect(await restarted.json()).toEqual({ restart: "relaunching" });
    } finally {
      releases.stop();
    }
  });

  test("a check that finds nothing is a 502 with the reason; an install that cannot run is a 409", async () => {
    const nowhere = fakeReleases("nope", {});
    process.env.SPECDRIVEN_RELEASES_URL = nowhere.url;
    try {
      const res = await api("/api/app-update/check", "POST");
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain("could not find the latest release");
    } finally {
      nowhere.stop();
    }
    const unchecked = await api("/api/app-update/install", "POST", {});
    expect(unchecked.status).toBe(400);
    expect(((await unchecked.json()) as { error: string }).error).toContain("Check for updates first");

    setUpdateDeps({ runtime: () => "web" });
    const web = await api("/api/app-update/install", "POST", { version: NEWER });
    expect(web.status).toBe(409);
    expect(((await web.json()) as { error: string }).error).toBe(WEB_RUNTIME);
    const idle = await api("/api/app-update/restart", "POST");
    expect(idle.status).toBe(409);
  });

  test("the demo and a hosted copy refuse every route", async () => {
    process.env.DEMO_MODE = "1";
    expect((await api("/api/app-update")).status).toBe(403);
    expect((await api("/api/app-update/install", "POST", { version: NEWER })).status).toBe(403);
    delete process.env.DEMO_MODE;
    process.env.SPECDRIVEN_HOSTED = "1";
    expect((await api("/api/app-update")).status).toBe(403);
    expect((await api("/api/app-update/check", "POST")).status).toBe(403);
    delete process.env.SPECDRIVEN_HOSTED;
  });
});

// specs/app/app-updates.feature.md "the desktop app checks once a day":
// the check the app makes of its own accord, and what the version chip
// learns from /api/state.
describe("the daily check", () => {
  /** A check stand-in that counts its calls and answers as told. */
  function fakeCheck(answer: () => Promise<{ latest: string; newer: boolean }>) {
    const calls: number[] = [];
    const check = async () => {
      calls.push(1);
      const a = await answer();
      return { current: appVersion, latest: a.latest, newer: a.newer, url: `https://example.test/tag/v${a.latest}`, checkedAt: new Date().toISOString() };
    };
    return { calls, check };
  }

  test("the desktop app checks once a day, counted from the last check, and /api/state names the newer version", async () => {
    let clock = new Date("2026-11-02T08:00:00Z").getTime();
    const found = fakeCheck(async () => ({ latest: NEWER, newer: true }));
    setUpdateDeps({ runtime: () => "desktop", now: () => new Date(clock), check: found.check });

    expect(updateAvailable()).toBeNull();
    expect(maybeCheckDaily()).toBe(true);
    // Not waited for: the version is known once the check has settled.
    expect(updateAvailable()).toBeNull();
    await dailyCheckSettled();
    expect(updateAvailable()).toBe(NEWER);
    expect(((await (await api("/api/app-update")).json()) as UpdateIndex).check).toMatchObject({ latest: NEWER, newer: true });

    // A second look an hour later, or just under a day later, asks nothing.
    clock += 60 * 60 * 1000;
    expect(maybeCheckDaily()).toBe(false);
    clock += DAILY_CHECK_MS - 2 * 60 * 60 * 1000;
    expect(maybeCheckDaily()).toBe(false);
    expect(found.calls.length).toBe(1);
    // A day on, it asks again.
    clock += 60 * 60 * 1000;
    expect(maybeCheckDaily()).toBe(true);
    await dailyCheckSettled();
    expect(found.calls.length).toBe(2);

    // The boot-time state fetch is what starts it, and the payload carries the answer.
    const state = (await (await api("/api/state")).json()) as { updateAvailable: string | null; version: string };
    expect(state.version).toBe(appVersion);
    expect(state.updateAvailable).toBe(NEWER);
  });

  test("the version running, or a newer one, leaves the chip unmarked", async () => {
    const upToDate = fakeCheck(async () => ({ latest: appVersion, newer: false }));
    setUpdateDeps({ runtime: () => "desktop", check: upToDate.check });
    expect(maybeCheckDaily()).toBe(true);
    await dailyCheckSettled();
    expect(updateAvailable()).toBeNull();
    expect(((await (await api("/api/state")).json()) as { updateAvailable: string | null }).updateAvailable).toBeNull();
  });

  test("the web server, the demo and a hosted copy never check by themselves", async () => {
    const found = fakeCheck(async () => ({ latest: NEWER, newer: true }));
    setUpdateDeps({ runtime: () => "web", check: found.check });
    expect(maybeCheckDaily()).toBe(false);
    setUpdateDeps({ runtime: () => "desktop", check: found.check });
    process.env.DEMO_MODE = "1";
    expect(maybeCheckDaily()).toBe(false);
    delete process.env.DEMO_MODE;
    process.env.SPECDRIVEN_HOSTED = "1";
    expect(maybeCheckDaily()).toBe(false);
    delete process.env.SPECDRIVEN_HOSTED;
    await dailyCheckSettled();
    expect(found.calls.length).toBe(0);
    expect(updateAvailable()).toBeNull();
  });

  test("a check that fails is swallowed, counts as the day's check, and leaves the last answer alone", async () => {
    let clock = new Date("2026-11-02T08:00:00Z").getTime();
    const failing = fakeCheck(async () => {
      throw new Error("could not reach https://example.test/latest: no network");
    });
    setUpdateDeps({ runtime: () => "desktop", now: () => new Date(clock), check: failing.check });
    expect(maybeCheckDaily()).toBe(true);
    await dailyCheckSettled();
    expect(updateAvailable()).toBeNull();
    expect(((await (await api("/api/app-update")).json()) as UpdateIndex).check).toBeNull();
    // Not again until tomorrow — the manual check is there meanwhile.
    clock += 60 * 60 * 1000;
    expect(maybeCheckDaily()).toBe(false);
    expect(failing.calls.length).toBe(1);
  });
});

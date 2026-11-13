// Automates specs/app/app-updates.feature.md "restart into the new version"
// on the desktop shell's side (src/electron/updateActivation.ts): which
// executable the next launch is on each platform, when the running Mac
// bundle is replaced in place, and how that swap is undone if the copy
// fails. Pure decisions over temp directories — no Electron.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundleOf, handoverCommand, handoverEnv, HANDOVER_WAIT_SECONDS, planActivation, previousBundle, swapBundle, type ActivationFs } from "../src/electron/updateActivation";

let root: string;
let appDir: string;
/** The new version's source tree, built. */
let newSource: string;
let newApp: string;

async function makeBuilt(dir: string, os: NodeJS.Platform): Promise<string> {
  if (os === "darwin") {
    const bundle = join(dir, "release", "mac-arm64", "SpecDriven.app");
    await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
    await writeFile(join(bundle, "Contents", "MacOS", "SpecDriven"), "");
    return bundle;
  }
  if (os === "win32") {
    const exe = join(dir, "release", "win-unpacked", "SpecDriven.exe");
    await mkdir(dirname(exe), { recursive: true });
    await writeFile(exe, "");
    return exe;
  }
  const image = join(dir, "release", "SpecDriven-9.9.9-x86_64.AppImage");
  await mkdir(dirname(image), { recursive: true });
  await writeFile(image, "");
  return image;
}

const writableDirs = new Set<string>();
const fs: ActivationFs = {
  realpath: (p) => realpath(p),
  writable: async (dir) => writableDirs.has(dir),
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "specdriven-activate-")));
  appDir = join(root, "home", "app");
  newSource = join(appDir, "specdriven-9.9.9");
  await mkdir(newSource, { recursive: true });
  newApp = await makeBuilt(newSource, "darwin");
  writableDirs.clear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("which executable the next launch is", () => {
  test("a Mac app in Applications is replaced where it is, and started from there", async () => {
    const applications = join(root, "Applications");
    const running = join(applications, "SpecDriven.app");
    await mkdir(join(running, "Contents", "MacOS"), { recursive: true });
    writableDirs.add(applications);
    const plan = await planActivation({
      platform: "darwin",
      execPath: join(running, "Contents", "MacOS", "SpecDriven"),
      newSourceDir: newSource,
      appDir,
      fs,
    });
    expect(plan).toEqual({
      kind: "swap-bundle",
      bundle: running,
      newBundle: newApp,
      execPath: join(running, "Contents", "MacOS", "SpecDriven"),
    });
  });

  test("a Mac app run from the install's own release directory is not copied anywhere, the new one just starts", async () => {
    const oldSource = join(appDir, "specdriven-0.1.220");
    const oldApp = await makeBuilt(oldSource, "darwin");
    const plan = await planActivation({
      platform: "darwin",
      execPath: join(oldApp, "Contents", "MacOS", "SpecDriven"),
      newSourceDir: newSource,
      appDir,
      fs,
    });
    expect(plan).toEqual({ kind: "relaunch-into", execPath: join(newApp, "Contents", "MacOS", "SpecDriven") });
  });

  test("an Applications folder that is not writable, or no bundle at all, leaves the swap to the user and says where the new app is", async () => {
    const applications = join(root, "Applications");
    const running = join(applications, "SpecDriven.app");
    await mkdir(join(running, "Contents", "MacOS"), { recursive: true });
    const locked = await planActivation({
      platform: "darwin",
      execPath: join(running, "Contents", "MacOS", "SpecDriven"),
      newSourceDir: newSource,
      appDir,
      fs,
    });
    expect(locked).toEqual({
      kind: "manual",
      reason: `${applications} is not writable, so SpecDriven.app cannot be replaced from here`,
      path: newApp,
    });
    const dev = await planActivation({ platform: "darwin", execPath: join(root, "node_modules", "electron", "electron"), newSourceDir: newSource, appDir, fs });
    expect(dev).toEqual({ kind: "manual", reason: "This SpecDriven is not running from an app bundle", path: newApp });
  });

  test("Windows and Linux start the new build where the installer left it", async () => {
    const win = join(root, "win-source");
    const exe = await makeBuilt(win, "win32");
    expect(await planActivation({ platform: "win32", execPath: "C:\\old\\SpecDriven.exe", newSourceDir: win, appDir, fs })).toEqual({
      kind: "relaunch-into",
      execPath: exe,
    });
    // Linux hands the new AppImage to a shell that outlives this one's
    // mount, rather than relaunching from inside it (#446).
    const linux = join(root, "linux-source");
    const image = await makeBuilt(linux, "linux");
    expect(await planActivation({ platform: "linux", execPath: "/tmp/.mount_x/specdriven", newSourceDir: linux, appDir, fs })).toEqual({
      kind: "hand-over",
      appImage: image,
    });
  });

  test("a new version with no built app cannot be started", async () => {
    const unbuilt = join(appDir, "specdriven-9.9.10");
    await mkdir(unbuilt, { recursive: true });
    expect(await planActivation({ platform: "linux", execPath: "/x", newSourceDir: unbuilt, appDir, fs })).toEqual({
      kind: "manual",
      reason: `There is no built app under ${join(unbuilt, "release")}`,
      path: null,
    });
  });

  test("the bundle of an executable is its .app", () => {
    expect(bundleOf("/Applications/SpecDriven.app/Contents/MacOS/SpecDriven")).toBe("/Applications/SpecDriven.app");
    expect(bundleOf("/Users/me/Apps/SpecDriven.app/Contents/MacOS/SpecDriven")).toBe("/Users/me/Apps/SpecDriven.app");
    expect(bundleOf("/usr/local/bin/electron")).toBeNull();
    expect(previousBundle("/Applications/SpecDriven.app")).toBe("/Applications/SpecDriven.app.previous");
  });
});

describe("swapping the running bundle", () => {
  const plan = (bundle: string, newBundle: string) =>
    ({ kind: "swap-bundle", bundle, newBundle, execPath: join(bundle, "Contents", "MacOS", "SpecDriven") }) as const;

  test("the running bundle steps aside as .previous, a stale .previous first going, and the new one is copied to its path", async () => {
    const log: string[] = [];
    await swapBundle(plan("/Applications/SpecDriven.app", newApp), {
      rename: async (a, b) => void log.push(`rename ${a} -> ${b}`),
      remove: async (p) => void log.push(`remove ${p}`),
      copy: async (a, b) => void log.push(`copy ${a} -> ${b}`),
    });
    expect(log).toEqual([
      "remove /Applications/SpecDriven.app.previous",
      "rename /Applications/SpecDriven.app -> /Applications/SpecDriven.app.previous",
      `copy ${newApp} -> /Applications/SpecDriven.app`,
    ]);
  });

  test("a copy that fails puts the running bundle back and reports the failure", async () => {
    const log: string[] = [];
    await expect(
      swapBundle(plan("/Applications/SpecDriven.app", newApp), {
        rename: async (a, b) => void log.push(`rename ${a} -> ${b}`),
        remove: async (p) => void log.push(`remove ${p}`),
        copy: async () => {
          throw new Error("ditto failed: No space left on device");
        },
      }),
    ).rejects.toThrow("ditto failed: No space left on device");
    expect(log).toEqual([
      "remove /Applications/SpecDriven.app.previous",
      "rename /Applications/SpecDriven.app -> /Applications/SpecDriven.app.previous",
      "remove /Applications/SpecDriven.app",
      "rename /Applications/SpecDriven.app.previous -> /Applications/SpecDriven.app",
    ]);
  });
});

// The handover itself (#446): a real /bin/sh, a real process to outlive.
describe.skipIf(process.platform === "win32")("handing over to the new app on Linux", () => {
  /** A script that writes `started` next to itself, so starting it is visible. */
  async function marker(): Promise<{ app: string; stamp: string }> {
    const app = join(root, "new-app");
    const stamp = join(root, "started");
    await writeFile(app, `#!/bin/sh\nprintf 'started' > ${JSON.stringify(stamp)}\n`);
    await chmod(app, 0o755);
    return { app, stamp };
  }

  async function started(stamp: string): Promise<boolean> {
    return (await readFile(stamp, "utf8").catch(() => null)) === "started";
  }

  async function settle(ms = 400): Promise<void> {
    await new Promise((done) => setTimeout(done, ms));
  }

  test("the new app starts only once the old process has gone", async () => {
    const { app, stamp } = await marker();
    // Stands in for the app being restarted: it holds the single-instance
    // lock, so nothing may start before it exits. It blocks on its stdin
    // rather than sleeping, since the suite's PATH holds git alone
    // (tests/helpers/binPath.ts).
    const old = spawn("/bin/sh", ["-c", "read line"], { stdio: ["pipe", "ignore", "ignore"] });
    const { command, args } = handoverCommand(app, old.pid!);
    const waiter = spawn(command, args, { detached: true, stdio: "ignore" });
    waiter.unref();
    await settle();
    expect(await started(stamp)).toBe(false);
    old.kill();
    await settle(1500);
    expect(await started(stamp)).toBe(true);
  });

  test("a path with spaces and quotes in it is an argument, never part of the script", async () => {
    const dir = join(root, "my apps", "it's \"here\"");
    await mkdir(dir, { recursive: true });
    const app = join(dir, "new app");
    const stamp = join(dir, "started");
    await writeFile(app, `#!/bin/sh\nprintf 'started' > ${JSON.stringify(stamp)}\n`);
    await chmod(app, 0o755);
    const gone = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    await new Promise((done) => gone.on("exit", done));
    const { command, args } = handoverCommand(app, gone.pid!);
    const waiter = spawn(command, args, { detached: true, stdio: "ignore" });
    waiter.unref();
    await settle(1000);
    expect(await started(stamp)).toBe(true);
  });

  test("the waiting shell is the system's own, and gives up waiting rather than never starting the app", () => {
    const { command, args } = handoverCommand("/new/SpecDriven.AppImage", 4242);
    expect(command).toBe("/bin/sh");
    expect(args[0]).toBe("-c");
    expect(args.slice(2)).toEqual(["sh", "/new/SpecDriven.AppImage", "4242"]);
    expect(args[1]).toContain('kill -0 "$pid"');
    expect(args[1]).toContain('exec "$app"');
    expect(args[1]).toContain(`"$n" -lt ${HANDOVER_WAIT_SECONDS / 0.2}`);
  });

  test("only an absolute path is handed to the shell, nothing it could look up on PATH or read as an option", () => {
    for (const path of ["SpecDriven.AppImage", "release/SpecDriven.AppImage", "-c", "--help", ""]) {
      expect(() => handoverCommand(path, 4242)).toThrow("is not an absolute path");
    }
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(() => handoverCommand("/new/SpecDriven.AppImage", pid)).toThrow("is not a process id");
    }
  });

  test("the new app does not inherit this AppImage's own variables", () => {
    const appImage = {
      PATH: "/usr/bin",
      APPIMAGE: "/home/me/.specdriven/app/current/release/SpecDriven-0.1.268-x86_64.AppImage",
      APPDIR: "/tmp/.mount_SpecDrWxYz",
      ARGV0: "SpecDriven.AppImage",
      OWD: "/home/me",
      LD_LIBRARY_PATH: "/tmp/.mount_SpecDrWxYz/usr/lib",
    };
    expect(handoverEnv(appImage)).toEqual({ PATH: "/usr/bin" });
    // Not an AppImage (a development run): the environment is left alone.
    const plain = { PATH: "/usr/bin", LD_LIBRARY_PATH: "/opt/lib" };
    expect(handoverEnv(plain)).toEqual(plain);
  });
});

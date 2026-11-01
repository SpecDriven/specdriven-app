// Automates specs/app/installation.feature.md "install on Windows from
// PowerShell": install.ps1 is install.sh's twin for Windows — it fetches a
// release's source zip, checks that its SHASUMS256.txt is signed by the
// release key and that the zip matches it, unpacks it under ~/.specdriven/app,
// builds the desktop app with Bun and starts it, and leaves nothing behind
// when the download cannot be trusted.
//
// The script runs under PowerShell 7, and every run of it starts one — too
// slow for the suite every pull request runs. So those tests are opt-in: they
// run when SPECDRIVEN_TEST_PWSH names a `pwsh`, as the install.ps1 workflow
// (.github/workflows/install-ps1.yml) does whenever the installer changes;
// otherwise only the static checks run. Off Windows the script links `current`
// with a symbolic link rather than a junction and adds no Start menu shortcut
// — the rest is the same code path a Windows machine takes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { cachedExecutable, linkExecutable } from "./helpers/fakeBin";
import { fakeReleases, generateSshKey, releaseKey, sha256, shasums, signedAssets, sourceZip } from "./helpers/fakeReleases";

const INSTALL_PS1 = join(import.meta.dir, "..", "install.ps1");
const VERSION = "0.1.40";
const OLDER = "0.1.39";

const PWSH = process.env.SPECDRIVEN_TEST_PWSH;

// --- fixtures ----------------------------------------------------------------

/**
 * A `bun` writing "<cwd> | <args>" to $FAKE_LOG, and running $FAKE_ON_BUILD
 * for build:desktop. Both come from the environment so the body is the same
 * for every test and stays cached (helpers/fakeBin.ts).
 */
const FAKE_BUN = `#!/bin/sh
printf '%s | %s\\n' "$(pwd)" "$*" >> "$FAKE_LOG"
case "$*" in
  "run build:desktop --local") eval "\${FAKE_ON_BUILD:-:}" ;;
esac
`;

/** The app electron-builder leaves in release/win-unpacked: says it started. */
const FAKE_APP = `#!/bin/sh\nprintf 'started | %s\\n' "$(pwd)" >> "$FAKE_LOG"\n`;

/** What a successful `build:desktop --local` leaves behind on Windows. */
const BUILDS_APP = `mkdir -p release/win-unpacked && ln -s ${cachedExecutable(FAKE_APP)} release/win-unpacked/SpecDriven.exe`;

/** A directory of stand-in tools, put first on PATH. */
function tools(fakes: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "specdriven-ps-tools-"));
  for (const [name, body] of Object.entries(fakes)) linkExecutable(dir, name, body);
  return dir;
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "specdriven-ps-home-"));
}

interface RunOptions {
  tools?: string;
  env?: Record<string, string>;
  /** Run at a terminal of the script's own and type this at it, as a person would. */
  tty?: string;
}

const PYTHON = Bun.which("python3");
const TERMINAL_PY = join(import.meta.dir, "helpers", "terminal.py");

async function runInstaller(releasesUrl: string, home: string, opts: RunOptions = {}) {
  const pwsh = opts.tty !== undefined
    ? [PYTHON!, TERMINAL_PY, "tty", opts.tty, "--", PWSH!, "-NoProfile", "-File", INSTALL_PS1]
    : [PWSH!, "-NoProfile", "-NonInteractive", "-File", INSTALL_PS1];
  const proc = Bun.spawn(pwsh, {
    env: {
      HOME: home,
      // The machine's own tools (id, git, ln) but never the developer's Bun.
      PATH: [opts.tools ?? tools(), "/usr/bin", "/bin"].join(delimiter),
      SPECDRIVEN_RELEASES_URL: releasesUrl,
      // The fake releases are signed with a key of the suite's own.
      SPECDRIVEN_RELEASE_PUBKEY: (await releaseKey()).publicKey,
      // Nobody is asked anything and no Bun is installed behind the
      // developer's back; the tests of the question set it themselves.
      SPECDRIVEN_INSTALL_BUN: "0",
      FAKE_LOG: join(home, "run.log"),
      ...opts.env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function appEntries(home: string): string[] {
  const dir = join(home, ".specdriven", "app");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function logLines(home: string): string[] {
  const log = join(home, "run.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

/** The detached app starts on its own clock; give it a moment to say so. */
async function waits(until: () => boolean): Promise<boolean> {
  for (let i = 0; i < 150; i++) {
    if (until()) return true;
    await Bun.sleep(20);
  }
  return false;
}

let latestZip: Uint8Array<ArrayBuffer>;
let olderZip: Uint8Array<ArrayBuffer>;
let good: ReturnType<typeof fakeReleases>;

beforeAll(async () => {
  latestZip = await sourceZip(VERSION);
  olderZip = await sourceZip(OLDER);
  good = fakeReleases(VERSION, {
    [VERSION]: { assets: await signedAssets(VERSION, latestZip) },
    [OLDER]: { assets: await signedAssets(OLDER, olderZip) },
  });
});

afterAll(() => good?.stop());

// PowerShell's first start on a machine is slow: .NET reads and compiles its
// assemblies from a cold disk, which on a CI runner takes longer than a test
// may. One install up front pays for that here, so every test below times
// the script rather than the runtime under it.
beforeAll(async () => {
  if (PWSH) await runInstaller(good.url, freshHome());
}, 60_000);

// --- what Windows PowerShell can read ----------------------------------------

test("install.ps1 is plain ASCII, which Windows PowerShell 5.1 reads as written", () => {
  // 5.1 reads a script file without a BOM in the legacy code page: an
  // ellipsis or a dash would reach the user as mojibake.
  const text = readFileSync(INSTALL_PS1, "utf8");
  const wide = [...text].map((ch, i) => [ch, i] as const).filter(([ch]) => ch.charCodeAt(0) > 0x7e || (ch < " " && ch !== "\n" && ch !== "\r"));
  expect(wide).toEqual([]);
});

// --- install on Windows from PowerShell --------------------------------------

test.skipIf(!PWSH)("the latest release is downloaded, verified and unpacked under ~/.specdriven/app", async () => {
  const home = freshHome();
  const { code, stdout, stderr } = await runInstaller(good.url, home);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toContain("Signature verified (release@specdriven.app).");
  expect(stdout).toContain("Checksum verified.");

  const app = join(home, ".specdriven", "app");
  expect(appEntries(home)).toEqual([
    "current",
    `specdriven-${VERSION}`,
    `specdriven-${VERSION}-src.zip`,
    `specdriven-${VERSION}-src.zip.sha256`,
  ]);
  expect(lstatSync(join(app, "current")).isSymbolicLink()).toBe(true);
  expect(realpathSync(join(app, "current"))).toBe(realpathSync(join(app, `specdriven-${VERSION}`)));
  expect(readFileSync(join(app, "current", "src", "index.ts"), "utf8")).toBe("export {};\n");
  expect(readFileSync(join(app, `specdriven-${VERSION}-src.zip.sha256`), "utf8")).toBe(
    `${sha256(latestZip)}  specdriven-${VERSION}-src.zip\n`,
  );

  // Without Bun it stops at the source and says what to run.
  expect(stdout).toContain("Bun is not installed; get it from https://bun.sh first.");
  expect(stdout).toContain("bun run build:desktop");
});

test.skipIf(!PWSH)("SPECDRIVEN_VERSION picks a release, with or without the v", async () => {
  for (const asked of [OLDER, `v${OLDER}`]) {
    const home = freshHome();
    const { code } = await runInstaller(good.url, home, { env: { SPECDRIVEN_VERSION: asked } });
    expect(code).toBe(0);
    expect(appEntries(home)).toContain(`specdriven-${OLDER}`);
  }
});

test.skipIf(!PWSH)("a version that is not version-shaped is refused before any download", async () => {
  const home = freshHome();
  good.hits.length = 0;
  const { code, stderr } = await runInstaller(good.url, home, { env: { SPECDRIVEN_VERSION: "../../evil" } });
  expect(code).toBe(1);
  expect(stderr).toContain("is not a release version");
  expect(good.hits).toEqual([]);
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

test.skipIf(!PWSH)("a checksum mismatch aborts without unpacking anything", async () => {
  // Signed, so the signature passes and the checksum is what gives it away.
  const tampered = fakeReleases(VERSION, {
    [VERSION]: {
      assets: await signedAssets(VERSION, latestZip, { sums: shasums({ [`specdriven-${VERSION}-src.zip`]: olderZip }) }),
    },
  });
  const home = freshHome();
  const { code, stderr } = await runInstaller(tampered.url, home);
  tampered.stop();
  expect(code).toBe(1);
  expect(stderr).toContain(`checksum mismatch for specdriven-${VERSION}-src.zip`);
  expect(stderr).toContain(`expected ${sha256(olderZip)}`);
  expect(stderr).toContain(`got      ${sha256(latestZip)}`);
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

test.skipIf(!PWSH)("a release without SHASUMS256.txt, or one not listing the zip, is refused", async () => {
  const unsigned = fakeReleases(VERSION, {
    [VERSION]: { assets: { [`specdriven-${VERSION}-src.zip`]: latestZip } },
  });
  let home = freshHome();
  let run = await runInstaller(unsigned.url, home);
  unsigned.stop();
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("refusing to install unverified");
  expect(existsSync(join(home, ".specdriven"))).toBe(false);

  const unlisted = fakeReleases(VERSION, {
    [VERSION]: {
      assets: await signedAssets(VERSION, latestZip, { sums: shasums({ "something-else.zip": latestZip }) }),
    },
  });
  home = freshHome();
  run = await runInstaller(unlisted.url, home);
  unlisted.stop();
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`no checksum listed for specdriven-${VERSION}-src.zip`);
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

// --- the signature -----------------------------------------------------------

test.skipIf(!PWSH)("a release without SHASUMS256.txt.sig is refused rather than installed unsigned", async () => {
  const assets = await signedAssets(VERSION, latestZip);
  delete assets["SHASUMS256.txt.sig"];
  const unsigned = fakeReleases(VERSION, { [VERSION]: { assets } });
  const home = freshHome();
  const { code, stderr, stdout } = await runInstaller(unsigned.url, home);
  unsigned.stop();
  expect(code).toBe(1);
  expect(stderr).toContain(`failed to download ${unsigned.url}/download/v${VERSION}/SHASUMS256.txt.sig`);
  expect(stderr).toContain("refusing to install unsigned");
  expect(stdout).not.toContain("verified");
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

test.skipIf(!PWSH)("a release swapped for another, checksum file and all, fails the signature and is refused", async () => {
  // Someone replaces the zip and rewrites SHASUMS256.txt to match: the
  // signature was made over the real checksum file, so it no longer
  // verifies, and the checksum — which would have matched — is never compared.
  const real = await signedAssets(VERSION, latestZip);
  const swapped = fakeReleases(VERSION, {
    [VERSION]: {
      assets: {
        [`specdriven-${VERSION}-src.zip`]: olderZip,
        "SHASUMS256.txt": shasums({ [`specdriven-${VERSION}-src.zip`]: olderZip }),
        "SHASUMS256.txt.sig": real["SHASUMS256.txt.sig"]!,
      },
    },
  });
  const home = freshHome();
  const { code, stderr, stdout } = await runInstaller(swapped.url, home);
  swapped.stop();
  expect(code).toBe(1);
  expect(stderr).toContain("SHASUMS256.txt is not signed by the SpecDriven release key (release@specdriven.app)");
  expect(stderr).toContain("refusing to install");
  expect(stdout).not.toContain("Signature verified");
  expect(stdout).not.toContain("Checksum verified");
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

test.skipIf(!PWSH)("a release signed with some other key is refused, and says a newer install.ps1 may know it", async () => {
  const impostor = fakeReleases(VERSION, {
    [VERSION]: { assets: await signedAssets(VERSION, latestZip, { signedAs: await generateSshKey("someone else") }) },
  });
  const home = freshHome();
  const { code, stderr } = await runInstaller(impostor.url, home);
  impostor.stop();
  expect(code).toBe(1);
  expect(stderr).toContain("not signed by the SpecDriven release key");
  expect(stderr).toContain("https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.ps1");
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

test.skipIf(!PWSH)("an ssh-keygen that cannot verify stops the install, in its own words", async () => {
  // With /usr/bin on PATH the real one is always found, so a broken one
  // stands in: whatever it says reaches the user, and nothing is written.
  const noKeygen = tools({ "ssh-keygen": "#!/bin/sh\necho 'not here' >&2\nexit 127\n" });
  const home = freshHome();
  const { code, stderr } = await runInstaller(good.url, home, { tools: noKeygen });
  expect(code).toBe(1);
  expect(stderr).toContain("not signed by the SpecDriven release key");
  expect(stderr).toContain("not here");
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

test.skipIf(!PWSH)("no releases at all is reported as such", async () => {
  const empty = fakeReleases("", {});
  const home = freshHome();
  const { code, stderr } = await runInstaller(empty.url, home);
  empty.stop();
  expect(code).toBe(1);
  expect(stderr).toContain(`could not find the latest release at ${empty.url}/latest`);
});

test.skipIf(!PWSH)("a version already unpacked is left alone, and `current` moves between versions", async () => {
  const home = freshHome();
  await runInstaller(good.url, home, { env: { SPECDRIVEN_VERSION: OLDER } });
  const app = join(home, ".specdriven", "app");
  mkdirSync(join(app, `specdriven-${OLDER}`, "mine"));

  let run = await runInstaller(good.url, home);
  expect(run.code).toBe(0);
  expect(realpathSync(join(app, "current"))).toBe(realpathSync(join(app, `specdriven-${VERSION}`)));

  run = await runInstaller(good.url, home, { env: { SPECDRIVEN_VERSION: OLDER } });
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(`SpecDriven ${OLDER} is already unpacked`);
  expect(existsSync(join(app, `specdriven-${OLDER}`, "mine"))).toBe(true);
  expect(realpathSync(join(app, "current"))).toBe(realpathSync(join(app, `specdriven-${OLDER}`)));
});

test.skipIf(!PWSH)("an update keeps the version it replaces and clears out the older ones", async () => {
  const home = freshHome();
  const app = join(home, ".specdriven", "app");
  for (const old of ["0.1.36", "0.1.37"]) {
    mkdirSync(join(app, `specdriven-${old}`, "node_modules"), { recursive: true });
    writeFileSync(join(app, `specdriven-${old}-src.zip`), "zip");
    writeFileSync(join(app, `specdriven-${old}-src.zip.sha256`), "sum");
  }
  mkdirSync(join(app, "specdriven-mine"));
  await runInstaller(good.url, home, { env: { SPECDRIVEN_VERSION: OLDER } });
  // The first install had nothing it replaced, so nothing went.
  expect(existsSync(join(app, "specdriven-0.1.36"))).toBe(true);

  const { code, stdout } = await runInstaller(good.url, home);
  expect(code).toBe(0);
  expect(appEntries(home)).toEqual([
    "current",
    `specdriven-${OLDER}`,
    `specdriven-${OLDER}-src.zip`,
    `specdriven-${OLDER}-src.zip.sha256`,
    `specdriven-${VERSION}`,
    `specdriven-${VERSION}-src.zip`,
    `specdriven-${VERSION}-src.zip.sha256`,
    "specdriven-mine",
  ]);
  expect(stdout).toContain(`Removed older versions: 0.1.36 0.1.37 (kept ${OLDER} to go back to).`);
});

test.skipIf(!PWSH)("a `current` that is a real directory is never replaced", async () => {
  const home = freshHome();
  const current = join(home, ".specdriven", "app", "current");
  mkdirSync(join(current, "mine"), { recursive: true });
  const { code, stdout } = await runInstaller(good.url, home);
  expect(code).toBe(0);
  expect(lstatSync(current).isSymbolicLink()).toBe(false);
  expect(existsSync(join(current, "mine"))).toBe(true);
  expect(stdout).toContain(`warning: ${current} is not a link`);
});

// --- Bun, which builds it ----------------------------------------------------

// Bun's installer unpacks into $env:BUN_INSTALL and touches nothing else. This
// stand-in does the same, and writes down who ran it.
const BUN_INSTALLER = `
New-Item -ItemType Directory -Force -Path "$env:BUN_INSTALL/bin" | Out-Null
& ln -f '${cachedExecutable(FAKE_BUN)}' "$env:BUN_INSTALL/bin/bun"
[Environment]::UserName | Set-Content -LiteralPath "$env:BUN_INSTALL/installed-by"
Write-Host "bun was installed to $env:BUN_INSTALL"
`;

/** Stands in for https://bun.sh/install.ps1. */
function fakeBunInstaller(body: string = BUN_INSTALLER) {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      hits += 1;
      return new Response(body);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/install.ps1`,
    get hits() {
      return hits;
    },
    stop: () => server.stop(true),
  };
}

test.skipIf(!PWSH)("SPECDRIVEN_INSTALL_BUN=1 installs Bun as the user, into their home, and builds with it", async () => {
  const installer = fakeBunInstaller();
  const home = freshHome();
  const run = await runInstaller(good.url, home, {
    env: {
      SPECDRIVEN_INSTALL_BUN: "1",
      SPECDRIVEN_BUN_INSTALLER_URL: installer.url,
      BUN_INSTALL: join(home, ".bun"),
      FAKE_ON_BUILD: BUILDS_APP,
    },
  });
  installer.stop();

  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("bun was installed to");
  expect(run.stdout).toContain(`Bun is installed (${join(home, ".bun", "bin", "bun")}).`);
  expect(readFileSync(join(home, ".bun", "installed-by"), "utf8").trim()).toBe(userInfo().username);
  // The Bun just installed is the one that builds, PATH or no PATH.
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  expect(logLines(home).slice(0, 2)).toEqual([
    `${realpathSync(target)} | install --frozen-lockfile`,
    `${realpathSync(target)} | run build:desktop --local`,
  ]);
});

test.skipIf(!PWSH || !PYTHON)("a yes at the terminal installs Bun; a no leaves it alone", async () => {
  let installer = fakeBunInstaller();
  let home = freshHome();
  const asks = { SPECDRIVEN_INSTALL_BUN: "", SPECDRIVEN_BUN_INSTALLER_URL: installer.url, BUN_INSTALL: join(home, ".bun") };
  let run = await runInstaller(good.url, home, { tty: "y\r", env: asks });
  installer.stop();
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(`Install it into ${join(home, ".bun")} now, as ${userInfo().username}? [y/N]`);
  expect(run.stdout).toContain(`Bun is installed (${join(home, ".bun", "bin", "bun")}).`);
  expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(true);

  installer = fakeBunInstaller();
  home = freshHome();
  run = await runInstaller(good.url, home, {
    tty: "n\r",
    env: { ...asks, SPECDRIVEN_BUN_INSTALLER_URL: installer.url, BUN_INSTALL: join(home, ".bun") },
  });
  installer.stop();
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("Leaving Bun alone.");
  expect(existsSync(join(home, ".bun"))).toBe(false);
  expect(installer.hits).toBe(0); // not even downloaded
});

test.skipIf(!PWSH)("with no one to ask, Bun is left alone and never downloaded", async () => {
  const installer = fakeBunInstaller();
  const home = freshHome();
  // stdin is not a terminal, as in a provisioning script: the run finishes on
  // its own rather than wait at a prompt nobody can see.
  const run = await runInstaller(good.url, home, {
    env: { SPECDRIVEN_INSTALL_BUN: "", SPECDRIVEN_BUN_INSTALLER_URL: installer.url, BUN_INSTALL: join(home, ".bun") },
  });
  installer.stop();
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("Bun is not installed; get it from https://bun.sh first.");
  expect(existsSync(join(home, ".bun"))).toBe(false);
  expect(installer.hits).toBe(0);
});

test.skipIf(!PWSH)("a Bun installer that fails is reported, and the checkout still stands", async () => {
  const installer = fakeBunInstaller("exit 3\n");
  const home = freshHome();
  const run = await runInstaller(good.url, home, {
    env: { SPECDRIVEN_INSTALL_BUN: "1", SPECDRIVEN_BUN_INSTALLER_URL: installer.url, BUN_INSTALL: join(home, ".bun") },
  });
  installer.stop();
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("Bun is not installed; get it from https://bun.sh first.");
  expect(existsSync(join(home, ".specdriven", "app", `specdriven-${VERSION}`, "package.json"))).toBe(true);
});

// --- building it, and starting it --------------------------------------------

test.skipIf(!PWSH)("the run ends with the app built and started from release/win-unpacked", async () => {
  const home = freshHome();
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  const run = await runInstaller(good.url, home, {
    tools: tools({ bun: FAKE_BUN }),
    env: { FAKE_ON_BUILD: BUILDS_APP },
  });
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("Installing dependencies...");
  expect(run.stdout).toContain(`SpecDriven ${VERSION} is running.`);

  const unpacked = join(realpathSync(target), "release", "win-unpacked");
  expect(await waits(() => logLines(home).length === 3)).toBe(true);
  expect(logLines(home)).toEqual([
    `${realpathSync(target)} | install --frozen-lockfile`,
    `${realpathSync(target)} | run build:desktop --local`,
    `started | ${unpacked}`,
  ]);
});

test.skipIf(!PWSH)("a build that fails stops the run and says where the checkout is", async () => {
  const home = freshHome();
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  const run = await runInstaller(good.url, home, {
    tools: tools({ bun: FAKE_BUN }),
    env: { FAKE_ON_BUILD: "exit 1" },
  });
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`\`bun run build:desktop --local\` failed in ${target}`);
  expect(existsSync(join(target, "package.json"))).toBe(true);
  expect(logLines(home).some((line) => line.startsWith("started"))).toBe(false);
});

// Releases live on the app's own repository (specs/app/installation.feature.md).
// Read off the script rather than run, so it holds without a pwsh too.
test("with no override, the releases come from SpecDriven/specdriven-app", () => {
  const text = readFileSync(INSTALL_PS1, "utf8");
  const fallback = text.match(/\$releasesUrl = if \(\$env:SPECDRIVEN_RELEASES_URL\) \{[^}]*\} else \{\s*'([^']*)'/);
  expect(fallback?.[1]).toBe("https://github.com/SpecDriven/specdriven-app/releases");
});

// Automates specs/app/installation.feature.md "install via curl": install.sh
// fetches a release's source zip from the releases repo, checks that its
// SHASUMS256.txt is signed by the release key and that the zip matches it,
// unpacks it under ~/.specdriven/app, and says how to build — and refuses to
// leave anything behind when the download cannot be trusted.
//
// The releases repo is stood in for by a loopback server that answers the two
// URL shapes GitHub uses: /latest redirecting to /tag/v<version>, and
// /download/v<version>/<asset>. The zip fixture is cut with `git archive`,
// exactly as .github/workflows/release.yml cuts the real one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { cachedExecutable, linkExecutable } from "./helpers/fakeBin";
import { fakeReleases, generateSshKey, releaseKey, sha256, shasums, signedAssets, sourceZip, sshSign } from "./helpers/fakeReleases";

const INSTALL_SH = join(import.meta.dir, "..", "install.sh");
const INSTALL_PS1 = join(import.meta.dir, "..", "install.ps1");
const RELEASE_YML = join(import.meta.dir, "..", ".github", "workflows", "release.yml");
const RELEASE_WINDOWS_YML = join(import.meta.dir, "..", ".github", "workflows", "release-windows.yml");
const VERSION = "0.1.40";
const OLDER = "0.1.39";

// --- fixtures ----------------------------------------------------------------

/** Where the machine keeps its ordinary tools; PATH itself is pinned to git. */
const TOOL_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/opt/homebrew/bin"];

function findTool(name: string): string | null {
  for (const dir of TOOL_DIRS) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Everything the installer shells out to, apart from the tools a test varies. */
const BASE_TOOLS = [
  "uname", "mktemp", "rm", "mv", "ln", "mkdir", "grep", "cut", "sed", "tail",
  "tr", "cat", "unzip", "sha256sum", "shasum", "ssh-keygen", "printf", "id", "readlink",
];

/**
 * A directory holding exactly the named tools (symlinked from the machine),
 * so a test controls which downloader, unzipper or `bun` the installer sees.
 * Missing optional tools (e.g. sha256sum on macOS) are skipped. Fakes are
 * cached executables (helpers/fakeBin.ts): a body must not vary per test,
 * or every run pays macOS's first-exec scan again.
 */
function toolbox(names: string[], fakes: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "specdriven-tools-"));
  for (const name of names) {
    if (name in fakes) continue; // the fake stands in for the real one
    const real = findTool(name);
    if (real) symlinkSync(real, join(dir, name));
  }
  for (const [name, body] of Object.entries(fakes)) linkExecutable(dir, name, body);
  return dir;
}


interface RunOptions {
  shell?: string[];
  tools?: string;
  env?: Record<string, string>;
  /** Run under a terminal of the script's own and type this at it. */
  tty?: string;
  /** Run with no controlling terminal, as a cron job or a build step would. */
  noTty?: boolean;
}

const PYTHON = findTool("python3");
const TERMINAL_PY = join(import.meta.dir, "helpers", "terminal.py");

async function runInstaller(releasesUrl: string, home: string, opts: RunOptions = {}) {
  const shell = opts.shell ?? ["/bin/sh"];
  const tools = opts.tools ?? toolbox([...BASE_TOOLS, "curl"]);
  const terminal = opts.tty !== undefined
    ? [PYTHON!, TERMINAL_PY, "tty", opts.tty, "--"]
    : opts.noTty
      ? [PYTHON!, TERMINAL_PY, "none", "--"]
      : [];
  const proc = Bun.spawn([...terminal, ...shell, INSTALL_SH], {
    env: {
      HOME: home,
      PATH: [tools, process.env.PATH ?? ""].join(delimiter),
      SPECDRIVEN_RELEASES_URL: releasesUrl,
      // The fake releases are signed with a key of the suite's own.
      SPECDRIVEN_RELEASE_PUBKEY: (await releaseKey()).publicKey,
      // The developer running the suite is never asked anything, and never
      // has Bun installed behind their back; the tests of the question itself
      // set this back to empty.
      SPECDRIVEN_INSTALL_BUN: "0",
      ...opts.env,
    },
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

/** What a run leaves under $HOME/.specdriven/app — only real entries, no scratch dirs. */
function appEntries(home: string): string[] {
  const dir = join(home, ".specdriven", "app");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "specdriven-home-"));
}

// --- the releases on offer ---------------------------------------------------

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

// --- install via curl --------------------------------------------------------

const shells: [string, string[]][] = [["/bin/sh", ["/bin/sh"]]];
const dash = findTool("dash");
if (dash) shells.push(["dash", [dash]]);

describe.each(shells)("under %s", (_name, shell) => {
  test("the latest release is downloaded, verified and unpacked under ~/.specdriven/app", async () => {
    const home = freshHome();
    const { stdout, stderr, code } = await runInstaller(good.url, home, { shell });
    expect(stderr).toBe("");
    expect(code).toBe(0);

    const app = join(home, ".specdriven", "app");
    const target = join(app, `specdriven-${VERSION}`);
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "src", "index.ts"))).toBe(true);
    // `current` is a relative symlink, so the tree can be moved as a whole.
    expect(lstatSync(join(app, "current")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(app, "current"))).toBe(`specdriven-${VERSION}`);
    // The verified archive stays beside the checkout for anyone's own review.
    expect(appEntries(home)).toEqual([
      "current",
      `specdriven-${VERSION}`,
      `specdriven-${VERSION}-src.zip`,
      `specdriven-${VERSION}-src.zip.sha256`,
    ]);
    expect(await Bun.file(join(app, `specdriven-${VERSION}-src.zip.sha256`)).text()).toBe(
      `${sha256(latestZip)}  specdriven-${VERSION}-src.zip\n`,
    );

    expect(stdout).toContain("Signature verified (release@specdriven.app).");
    expect(stdout).toContain("Checksum verified.");
    expect(stdout).toContain(`Unpacked to ${target}`);
    // No Bun here (BASE_TOOLS has none), so the build is left to the reader.
    expect(stdout).toContain("Nothing has been built: Bun is what builds it.");
    expect(stdout).toContain(`cd ${join(app, "current")}`);
    expect(stdout).toContain("bun install");
    expect(stdout).toContain("bun run build:desktop");
  });
});

test("the version is resolved from where /releases/latest redirects", async () => {
  const home = freshHome();
  good.hits.length = 0;
  await runInstaller(good.url, home);
  expect(good.hits).toEqual([
    "/latest",
    `/tag/v${VERSION}`,
    `/download/v${VERSION}/specdriven-${VERSION}-src.zip`,
    `/download/v${VERSION}/SHASUMS256.txt`,
    `/download/v${VERSION}/SHASUMS256.txt.sig`,
  ]);
});

test("SPECDRIVEN_VERSION picks a release, with or without the v", async () => {
  for (const spelled of [OLDER, `v${OLDER}`]) {
    const home = freshHome();
    const { code, stderr } = await runInstaller(good.url, home, { env: { SPECDRIVEN_VERSION: spelled } });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(existsSync(join(home, ".specdriven", "app", `specdriven-${OLDER}`, "package.json"))).toBe(true);
    expect(readlinkSync(join(home, ".specdriven", "app", "current"))).toBe(`specdriven-${OLDER}`);
  }
});

test("SPECDRIVEN_HOME moves the install prefix, as it does the settings", async () => {
  const home = freshHome();
  const prefix = join(home, "elsewhere");
  const { code } = await runInstaller(good.url, home, { env: { SPECDRIVEN_HOME: prefix } });
  expect(code).toBe(0);
  expect(existsSync(join(prefix, "app", `specdriven-${VERSION}`, "package.json"))).toBe(true);
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

test("a version that is not a release fails at the download and writes nothing", async () => {
  const home = freshHome();
  const { code, stderr } = await runInstaller(good.url, home, { env: { SPECDRIVEN_VERSION: "9.9.9" } });
  expect(code).toBe(1);
  expect(stderr).toContain(`failed to download ${good.url}/download/v9.9.9/specdriven-9.9.9-src.zip`);
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

test("a version that is not even version-shaped is refused before any download", async () => {
  // Digits and dots, three fields — nothing else gets spliced into a URL.
  for (const bad of ["main", "0.1", "0.1.40-rc1", "0.1.40 [following]", ".1.40", "0..40", "0.1.40."]) {
    const home = freshHome();
    good.hits.length = 0;
    const { code, stderr } = await runInstaller(good.url, home, { env: { SPECDRIVEN_VERSION: bad } });
    expect(code).toBe(1);
    expect(stderr).toContain(`"${bad}" is not a release version`);
    expect(good.hits).toEqual([]);
    expect(existsSync(join(home, ".specdriven"))).toBe(false);
  }
});

test("a latest redirect that does not name a v<version> tag is not followed into a download", async () => {
  const odd = fakeReleases("next", { next: { assets: {} } }); // redirects to /tag/vnext
  try {
    const home = freshHome();
    const { code, stderr } = await runInstaller(odd.url, home);
    expect(code).toBe(1);
    expect(stderr).toContain(`could not find the latest release at ${odd.url}/latest`);
    expect(odd.hits).toEqual(["/latest", "/tag/vnext"]);
  } finally {
    odd.stop();
  }
});

// --- fail closed -------------------------------------------------------------

test("a checksum mismatch aborts without unpacking anything", async () => {
  // Signed, so the signature passes and the checksum is what gives it away.
  const tampered = fakeReleases(VERSION, {
    [VERSION]: {
      assets: await signedAssets(VERSION, latestZip, { sums: shasums({ [`specdriven-${VERSION}-src.zip`]: olderZip }) }),
    },
  });
  try {
    const home = freshHome();
    const { code, stderr, stdout } = await runInstaller(tampered.url, home);
    expect(code).toBe(1);
    expect(stderr).toContain(`checksum mismatch for specdriven-${VERSION}-src.zip`);
    expect(stderr).toContain(`expected ${sha256(olderZip)}`);
    expect(stderr).toContain(`got      ${sha256(latestZip)}`);
    expect(stdout).not.toContain("Checksum verified.");
    expect(existsSync(join(home, ".specdriven"))).toBe(false);
  } finally {
    tampered.stop();
  }
});

test("a release without SHASUMS256.txt is refused rather than installed unverified", async () => {
  const unsigned = fakeReleases(VERSION, {
    [VERSION]: { assets: { [`specdriven-${VERSION}-src.zip`]: latestZip } },
  });
  try {
    const home = freshHome();
    const { code, stderr } = await runInstaller(unsigned.url, home);
    expect(code).toBe(1);
    expect(stderr).toContain("refusing to install unverified");
    expect(existsSync(join(home, ".specdriven"))).toBe(false);
  } finally {
    unsigned.stop();
  }
});

test("a SHASUMS256.txt that does not list the zip is as good as none", async () => {
  const unlisted = fakeReleases(VERSION, {
    [VERSION]: {
      assets: await signedAssets(VERSION, latestZip, { sums: shasums({ "something-else.zip": latestZip }) }),
    },
  });
  try {
    const home = freshHome();
    const { code, stderr } = await runInstaller(unlisted.url, home);
    expect(code).toBe(1);
    expect(stderr).toContain(`no checksum listed for specdriven-${VERSION}-src.zip`);
    expect(existsSync(join(home, ".specdriven"))).toBe(false);
  } finally {
    unlisted.stop();
  }
});

// --- the signature -----------------------------------------------------------

// The checksum proves the zip is the one SHASUMS256.txt names; the signature
// on SHASUMS256.txt proves it came from SpecDriven's release workflow. A
// release missing either, or carrying a signature that does not check out
// against the key the installer embeds, is refused with nothing written.

test("a release without SHASUMS256.txt.sig is refused rather than installed unsigned", async () => {
  const assets = await signedAssets(VERSION, latestZip);
  delete assets["SHASUMS256.txt.sig"];
  const unsigned = fakeReleases(VERSION, { [VERSION]: { assets } });
  try {
    const home = freshHome();
    const { code, stderr, stdout } = await runInstaller(unsigned.url, home);
    expect(code).toBe(1);
    expect(stderr).toContain(`failed to download ${unsigned.url}/download/v${VERSION}/SHASUMS256.txt.sig`);
    expect(stderr).toContain("refusing to install unsigned");
    expect(stdout).not.toContain("verified");
    expect(existsSync(join(home, ".specdriven"))).toBe(false);
  } finally {
    unsigned.stop();
  }
});

test("a release swapped for another, checksum file and all, fails the signature and is refused", async () => {
  // The attack a checksum alone cannot catch: someone replaces the zip and
  // rewrites SHASUMS256.txt to match it. The signature was made over the
  // real checksum file, so it no longer verifies — and the checksum, which
  // would have matched, is never even compared.
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
  try {
    const home = freshHome();
    const { code, stderr, stdout } = await runInstaller(swapped.url, home);
    expect(code).toBe(1);
    expect(stderr).toContain("SHASUMS256.txt is not signed by the SpecDriven release key (release@specdriven.app)");
    expect(stderr).toContain("refusing to install");
    expect(stdout).not.toContain("Signature verified");
    expect(stdout).not.toContain("Checksum verified");
    expect(existsSync(join(home, ".specdriven"))).toBe(false);
  } finally {
    swapped.stop();
  }
});

test("a release signed with some other key is refused, and says a newer install.sh may know it", async () => {
  const impostor = fakeReleases(VERSION, {
    [VERSION]: { assets: await signedAssets(VERSION, latestZip, { signedAs: await generateSshKey("someone else") }) },
  });
  try {
    const home = freshHome();
    const { code, stderr } = await runInstaller(impostor.url, home);
    expect(code).toBe(1);
    expect(stderr).toContain("not signed by the SpecDriven release key");
    expect(stderr).toContain("https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.sh");
    expect(existsSync(join(home, ".specdriven"))).toBe(false);
  } finally {
    impostor.stop();
  }
});

test("a signature by the right key in some other namespace does not count", async () => {
  // `ssh-keygen -Y sign -n file`, the everyday namespace: the release key,
  // but not a release signature — a signature made for one purpose cannot be
  // passed off as one for another.
  const sums = shasums({ [`specdriven-${VERSION}-src.zip`]: latestZip });
  const wrongNamespace = fakeReleases(VERSION, {
    [VERSION]: {
      assets: {
        [`specdriven-${VERSION}-src.zip`]: latestZip,
        "SHASUMS256.txt": sums,
        "SHASUMS256.txt.sig": await sshSign(sums, undefined, "file"),
      },
    },
  });
  try {
    const home = freshHome();
    const { code, stderr } = await runInstaller(wrongNamespace.url, home);
    expect(code).toBe(1);
    expect(stderr).toContain("not signed by the SpecDriven release key");
    expect(stderr).toContain("namespace does not match");
    expect(existsSync(join(home, ".specdriven"))).toBe(false);
  } finally {
    wrongNamespace.stop();
  }
});

test("without ssh-keygen the download is not installed, however good it may be", async () => {
  const home = freshHome();
  const tools = toolbox([...BASE_TOOLS.filter((t) => t !== "ssh-keygen"), "curl"]);
  const { code, stderr } = await runInstaller(good.url, home, { tools });
  expect(code).toBe(1);
  expect(stderr).toContain("need ssh-keygen");
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

test("SPECDRIVEN_RELEASE_PUBKEY aside, the installers trust the one key the release workflow checks against", async () => {
  // install.sh, install.ps1 and release.yml each name the key: the workflow
  // reads it out of install.sh with this sed, verifies its own signature
  // against it, and refuses to publish unless install.ps1 carries the same.
  // release-windows.yml checks the signature on its own SHASUMS256.txt the
  // same way.
  const sh = readFileSync(INSTALL_SH, "utf8");
  const keyFromInstallSh = /sed -n '(s\/\^SIGNER_KEY=.*?)' install\.sh/;
  const sedPattern = readFileSync(RELEASE_YML, "utf8").match(keyFromInstallSh)?.[1];
  expect(sedPattern).toBeDefined();
  expect(readFileSync(RELEASE_WINDOWS_YML, "utf8").match(keyFromInstallSh)?.[1]).toBe(sedPattern!);
  const p = Bun.spawn(["sed", "-n", sedPattern!, INSTALL_SH], { stdout: "pipe" });
  const fromSh = (await new Response(p.stdout).text()).trim();
  expect(fromSh).toMatch(/^ssh-ed25519 AAAA[A-Za-z0-9+/=]+$/);
  expect(sh).toContain(`SIGNER_KEY="${fromSh}"`);
  expect(readFileSync(INSTALL_PS1, "utf8")).toContain(`$signerKey = '${fromSh}'`);
  // The by-hand recipe quotes it too.
  expect(readFileSync(join(import.meta.dir, "..", "docs", "installation.md"), "utf8")).toContain(`release@specdriven.app ${fromSh}'`);
  // And it is a real key: ssh-keygen can read it.
  const dir = mkdtempSync(join(tmpdir(), "specdriven-pub-"));
  writeFileSync(join(dir, "key.pub"), `${fromSh}\n`);
  const lint = Bun.spawn(["ssh-keygen", "-l", "-f", join(dir, "key.pub")], { stdout: "pipe", stderr: "pipe" });
  expect(await lint.exited).toBe(0);
  expect(await new Response(lint.stdout).text()).toContain("(ED25519)");
});

test("a zip laid out unexpectedly is not installed, and no scratch directory is left", async () => {
  // Same content, but the workflow's specdriven-<version>/ prefix is missing.
  const flat = await (async () => {
    const zip = await sourceZip("0.0.0"); // prefixed specdriven-0.0.0/, i.e. the wrong name
    return zip;
  })();
  const odd = fakeReleases(VERSION, {
    [VERSION]: { assets: await signedAssets(VERSION, flat) },
  });
  try {
    const home = freshHome();
    const { code, stderr } = await runInstaller(odd.url, home);
    expect(code).toBe(1);
    expect(stderr).toContain(`unexpected archive layout: no specdriven-${VERSION}/ directory`);
    expect(appEntries(home)).toEqual([]);
  } finally {
    odd.stop();
  }
});

test("no releases at all is reported as such", async () => {
  const empty = fakeReleases("", {});
  try {
    const home = freshHome();
    const { code, stderr } = await runInstaller(empty.url, home);
    expect(code).toBe(1);
    expect(stderr).toContain(`could not find the latest release at ${empty.url}/latest`);
    expect(existsSync(join(home, ".specdriven"))).toBe(false);
  } finally {
    empty.stop();
  }
});

// --- re-running --------------------------------------------------------------

test("a version already unpacked is left alone — someone may have built in it", async () => {
  const home = freshHome();
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  mkdirSync(join(target, "node_modules"), { recursive: true });
  writeFileSync(join(target, "node_modules", "keep-me"), "");
  good.hits.length = 0;

  const { code, stdout, stderr } = await runInstaller(good.url, home);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(existsSync(join(target, "node_modules", "keep-me"))).toBe(true);
  expect(stdout).toContain(`already unpacked at ${target}`);
  // Only the version lookup went over the network; nothing was re-downloaded.
  expect(good.hits).toEqual(["/latest", `/tag/v${VERSION}`]);
  // `current` still comes to point at it, so the next steps are right.
  expect(readlinkSync(join(home, ".specdriven", "app", "current"))).toBe(`specdriven-${VERSION}`);
});

test("installing another version re-points `current` and keeps the old checkout", async () => {
  const home = freshHome();
  await runInstaller(good.url, home, { env: { SPECDRIVEN_VERSION: OLDER } });
  const { code } = await runInstaller(good.url, home);
  expect(code).toBe(0);
  expect(readlinkSync(join(home, ".specdriven", "app", "current"))).toBe(`specdriven-${VERSION}`);
  expect(existsSync(join(home, ".specdriven", "app", `specdriven-${OLDER}`, "package.json"))).toBe(true);
});

test("a `current` that is a real directory is never replaced", async () => {
  const home = freshHome();
  const current = join(home, ".specdriven", "app", "current");
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, "mine"), "");
  seedVersion(home, "0.1.37");
  const { code, stdout } = await runInstaller(good.url, home);
  expect(code).toBe(0);
  expect(existsSync(join(current, "mine"))).toBe(true);
  expect(stdout).toContain(`warning: ${current} is not a symlink`);
  // With no telling what was in use, no older version is cleared out.
  expect(existsSync(join(home, ".specdriven", "app", "specdriven-0.1.37"))).toBe(true);
});

// --- clearing out older versions ---------------------------------------------

/** An earlier install of `version`: its tree (built, by the look of it), zip and checksum. */
function seedVersion(home: string, version: string): void {
  const app = join(home, ".specdriven", "app");
  mkdirSync(join(app, `specdriven-${version}`, "node_modules"), { recursive: true });
  writeFileSync(join(app, `specdriven-${version}`, "package.json"), "{}");
  writeFileSync(join(app, `specdriven-${version}-src.zip`), "zip");
  writeFileSync(join(app, `specdriven-${version}-src.zip.sha256`), "sum");
}

test("an update keeps the version it replaces and clears out the older ones", async () => {
  const home = freshHome();
  const app = join(home, ".specdriven", "app");
  seedVersion(home, "0.1.36");
  seedVersion(home, "0.1.37");
  seedVersion(home, OLDER);
  // Whoever made this link spelled it out in full; it still names the version.
  symlinkSync(join(app, `specdriven-${OLDER}`), join(app, "current"));
  // Not versions: whatever these are, they are not the installer's to remove.
  mkdirSync(join(app, "specdriven-mine"));
  writeFileSync(join(app, "notes.txt"), "");

  const { code, stdout, stderr } = await runInstaller(good.url, home);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(appEntries(home)).toEqual([
    "current",
    "notes.txt",
    `specdriven-${OLDER}`,
    `specdriven-${OLDER}-src.zip`,
    `specdriven-${OLDER}-src.zip.sha256`,
    `specdriven-${VERSION}`,
    `specdriven-${VERSION}-src.zip`,
    `specdriven-${VERSION}-src.zip.sha256`,
    "specdriven-mine",
  ]);
  expect(readlinkSync(join(app, "current"))).toBe(`specdriven-${VERSION}`);
  expect(stdout).toContain(`Removed older versions: 0.1.36 0.1.37 (kept ${OLDER} to go back to).`);
});

test("going back to an older version keeps the newer one it replaces", async () => {
  const home = freshHome();
  const app = join(home, ".specdriven", "app");
  seedVersion(home, "0.1.37");
  await runInstaller(good.url, home);
  const { code } = await runInstaller(good.url, home, { env: { SPECDRIVEN_VERSION: OLDER } });
  expect(code).toBe(0);
  expect(readlinkSync(join(app, "current"))).toBe(`specdriven-${OLDER}`);
  expect(existsSync(join(app, `specdriven-${VERSION}`, "package.json"))).toBe(true);
  expect(existsSync(join(app, "specdriven-0.1.37"))).toBe(false);
});

test("a first install, or the same version again, clears nothing out", async () => {
  const home = freshHome();
  const app = join(home, ".specdriven", "app");
  seedVersion(home, "0.1.36");
  seedVersion(home, "0.1.37");
  for (let run = 0; run < 2; run++) {
    const { code, stdout } = await runInstaller(good.url, home);
    expect(code).toBe(0);
    expect(stdout).not.toContain("Removed older versions");
    expect(existsSync(join(app, "specdriven-0.1.36", "package.json"))).toBe(true);
    expect(existsSync(join(app, "specdriven-0.1.37-src.zip"))).toBe(true);
  }
});

// --- the machine it runs on --------------------------------------------------

test("Windows shells are sent to install.ps1, or the releases page", async () => {
  const home = freshHome();
  good.hits.length = 0;
  const tools = toolbox([...BASE_TOOLS, "curl"], { uname: "#!/bin/sh\necho MINGW64_NT-10.0-19045\n" });
  const { code, stderr } = await runInstaller(good.url, home, { tools });
  expect(code).toBe(1);
  expect(stderr).toContain("this installer needs a Unix shell");
  expect(stderr).toContain(
    "irm https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.ps1 | iex",
  );
  expect(stderr).toContain(good.url);
  expect(good.hits).toEqual([]);
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

const wget = findTool("wget");
test.skipIf(!wget)("wget does the job when there is no curl", async () => {
  const home = freshHome();
  const { code, stderr } = await runInstaller(good.url, home, { tools: toolbox([...BASE_TOOLS, "wget"]) });
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(readlinkSync(join(home, ".specdriven", "app", "current"))).toBe(`specdriven-${VERSION}`);
});

test("with neither curl nor wget there is nothing to do", async () => {
  const home = freshHome();
  const { code, stderr } = await runInstaller(good.url, home, { tools: toolbox(BASE_TOOLS) });
  expect(code).toBe(1);
  expect(stderr).toContain("need curl or wget");
});

const bsdtar = findTool("bsdtar");
test.skipIf(!bsdtar)("bsdtar unpacks the zip when unzip is missing", async () => {
  const home = freshHome();
  const tools = toolbox([...BASE_TOOLS.filter((t) => t !== "unzip"), "curl", "bsdtar"]);
  const { code, stderr } = await runInstaller(good.url, home, { tools });
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(existsSync(join(home, ".specdriven", "app", `specdriven-${VERSION}`, "src", "index.ts"))).toBe(true);
});

test("without a sha256 tool the download is not installed, however good it may be", async () => {
  const home = freshHome();
  const tools = toolbox([...BASE_TOOLS.filter((t) => t !== "shasum" && t !== "sha256sum"), "curl"]);
  const { code, stderr } = await runInstaller(good.url, home, { tools });
  expect(code).toBe(1);
  expect(stderr).toContain("need sha256sum or shasum");
  expect(existsSync(join(home, ".specdriven"))).toBe(false);
});

test("the next steps say whether Bun is there to run them", async () => {
  const withBun = toolbox([...BASE_TOOLS, "curl"], { bun: "#!/bin/sh\nexit 0\n" });
  let run = await runInstaller(good.url, freshHome(), { tools: withBun });
  expect(run.stdout).toContain(`Bun is installed (${join(withBun, "bun")}).`);
  // Nothing to offer, so nothing is asked.
  expect(run.stdout).not.toContain("Install it into");

  run = await runInstaller(good.url, freshHome());
  expect(run.stdout).toContain("Bun is not installed; get it from https://bun.sh first.");
});

// --- Bun, which builds it ----------------------------------------------------
//
// The script builds nothing, but every command it prints needs Bun. A missing
// Bun is therefore offered — and installed only after a yes at the terminal,
// by Bun's own installer, into the user's own home.

// The bun it installs is a hard link to a cached one rather than a file of its
// own, which the script would then be the first to run — and pay for
// (helpers/fakeBin.ts). Home and the cache are both under tmpdir, so the link
// stays on one filesystem.
const INSTALLED_BUN = cachedExecutable("#!/bin/sh\necho fake bun\n");

// Bun's installer unpacks into $BUN_INSTALL and touches nothing else. This
// stand-in does the same, and writes down who ran it: "as the user, not as
// root" is the whole of what the offer promises.
const BUN_INSTALLER = `#!/usr/bin/env bash
set -eu
mkdir -p "$BUN_INSTALL/bin"
ln -f ${shellQuote(INSTALLED_BUN)} "$BUN_INSTALL/bin/bun"
chmod +x "$BUN_INSTALL/bin/bun"
id -un > "$BUN_INSTALL/installed-by"
echo "bun was installed to $BUN_INSTALL"
`;

/** Stands in for https://bun.sh/install. */
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
    url: `http://127.0.0.1:${server.port}/install`,
    get hits() {
      return hits;
    },
    stop: () => server.stop(true),
  };
}

const BUN_TOOLS = [...BASE_TOOLS, "curl", "bash", "chmod"];

/** A run with no Bun on PATH, pointed at the stand-in installer. */
async function runWithoutBun(
  installer: ReturnType<typeof fakeBunInstaller>,
  home: string,
  opts: RunOptions = {},
) {
  return runInstaller(good.url, home, {
    tools: toolbox(BUN_TOOLS),
    ...opts,
    env: {
      SPECDRIVEN_BUN_INSTALLER_URL: installer.url,
      BUN_INSTALL: join(home, ".bun"),
      ...opts.env,
    },
  });
}

const asks = { SPECDRIVEN_INSTALL_BUN: "" };

test.skipIf(!PYTHON)("a yes at the terminal installs Bun, as the user and in their home", async () => {
  const installer = fakeBunInstaller();
  const home = freshHome();
  const run = await runWithoutBun(installer, home, { tty: "y\n", env: asks });
  installer.stop();

  expect(run.code).toBe(0);
  expect(run.stdout).toContain(`Install it into ${join(home, ".bun")} now, as ${userInfo().username}?`);
  expect(run.stdout).toContain(`Bun is installed (${join(home, ".bun", "bin", "bun")}).`);
  expect(run.stdout).toContain(`Add ${join(home, ".bun", "bin")} to PATH to keep it`);
  // …and the Bun just installed is the one that builds, PATH or no PATH.
  expect(run.stdout).toContain("Installing dependencies…");
  expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(true);
  // Bun's installer decides where Bun goes; the script only says where that is.
  expect(readFileSync(join(home, ".bun", "installed-by"), "utf8").trim()).toBe(userInfo().username);
  // And the SpecDriven checkout is still the point of the exercise.
  expect(existsSync(join(home, ".specdriven", "app", `specdriven-${VERSION}`, "package.json"))).toBe(true);
});

test.skipIf(!PYTHON)("a no at the terminal leaves Bun alone", async () => {
  const installer = fakeBunInstaller();
  const home = freshHome();
  const run = await runWithoutBun(installer, home, { tty: "n\n", env: asks });
  installer.stop();

  expect(run.code).toBe(0);
  expect(run.stdout).toContain("Leaving Bun alone.");
  expect(run.stdout).toContain("Bun is not installed; get it from https://bun.sh first.");
  expect(existsSync(join(home, ".bun"))).toBe(false);
  expect(installer.hits).toBe(0); // not even downloaded
});

test.skipIf(!PYTHON)("with no terminal to ask at, Bun is left to the reader", async () => {
  const installer = fakeBunInstaller();
  const home = freshHome();
  // `curl | sh` in a build step: no one is there to answer, so the run must
  // finish on its own rather than wait at a prompt nobody can see.
  const run = await runWithoutBun(installer, home, { noTty: true, env: asks });
  installer.stop();

  expect(run.code).toBe(0);
  expect(run.stdout).toContain("Bun is not installed; get it from https://bun.sh first.");
  expect(existsSync(join(home, ".bun"))).toBe(false);
  expect(installer.hits).toBe(0);
});

test("SPECDRIVEN_INSTALL_BUN=1 answers the question in advance", async () => {
  const installer = fakeBunInstaller();
  const home = freshHome();
  const run = await runWithoutBun(installer, home, { env: { SPECDRIVEN_INSTALL_BUN: "1" } });
  installer.stop();

  expect(run.code).toBe(0);
  expect(run.stdout).not.toContain("Install it into");
  expect(run.stdout).toContain(`Bun is installed (${join(home, ".bun", "bin", "bun")}).`);
  expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(true);
});

test("a Bun installer that fails is reported, and the checkout still stands", async () => {
  const installer = fakeBunInstaller("#!/usr/bin/env bash\nexit 3\n");
  const home = freshHome();
  const run = await runWithoutBun(installer, home, { env: { SPECDRIVEN_INSTALL_BUN: "1" } });
  installer.stop();

  expect(run.code).toBe(0);
  expect(run.stdout).toContain("Bun is not installed; get it from https://bun.sh first.");
  expect(existsSync(join(home, ".bun", "bin", "bun"))).toBe(false);
  expect(existsSync(join(home, ".specdriven", "app", `specdriven-${VERSION}`, "package.json"))).toBe(true);
});

// --- building it, and starting it --------------------------------------------
//
// The run does not stop at unpacked source: it installs the dependencies,
// builds the desktop app and starts what electron-builder leaves beside the
// installer. Reviewing first means taking the zip from the releases page by
// hand, so nothing here is behind a prompt. A stand-in `bun` does the work —
// a test does not download Electron — and records where it was run and what
// it was asked for.

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * A `bun` writing "<cwd> | <args>" to $FAKE_LOG, and running $FAKE_ON_BUILD
 * for build:desktop. Both come from the environment so the script is the same
 * for every test and is cached (see toolbox); fakeRun() sets them.
 */
const FAKE_BUN = `#!/bin/sh
printf '%s | %s\n' "$(pwd)" "$*" >> "$FAKE_LOG"
case "$*" in
  "run build:desktop --local") eval "\${FAKE_ON_BUILD:-:}" ;;
esac
`;

/** An `open` writing "open | <what>" to $FAKE_LOG. */
const FAKE_OPEN = `#!/bin/sh\nprintf 'open | %s\\n' "$1" >> "$FAKE_LOG"\n`;

/** The environment FAKE_BUN and FAKE_OPEN read: where to log, and what the build leaves behind. */
function fakeRun(log: string, onBuild = ""): Record<string, string> {
  return { FAKE_LOG: log, FAKE_ON_BUILD: onBuild };
}

function logLines(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

/** The detached app starts on its own clock; give it a moment to say so. */
async function waits(until: () => boolean): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (until()) return true;
    await Bun.sleep(20);
  }
  return false;
}

const BUILD_TOOLS = [...BASE_TOOLS, "curl", "chmod"];

/**
 * What the script starts turns on `uname -s`, so the tests say which machine
 * they are: both branches then run on whichever one the suite is on.
 */
function fakeUname(os: string): string {
  return `#!/bin/sh\necho ${os}\n`;
}

test("the run ends with the .dmg opened, and nothing started", async () => {
  const home = freshHome();
  const log = join(home, "bun.log");
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  const app = join(target, "release", "mac-arm64", "SpecDriven.app");
  const dmg = join(target, "release", `SpecDriven-${VERSION}-arm64.dmg`);
  // electron-builder leaves the unpacked .app beside the .dmg; the script is
  // to leave it alone.
  const tools = toolbox(BUILD_TOOLS, {
    uname: fakeUname("Darwin"),
    bun: FAKE_BUN,
    open: FAKE_OPEN,
  });
  const env = fakeRun(log, `mkdir -p ${shellQuote(app)}/Contents && : > ${shellQuote(dmg)}`);

  const { stdout, stderr, code } = await runInstaller(good.url, home, { tools, env });
  expect(stderr).toBe("");
  expect(code).toBe(0);

  // Both commands run inside the checkout, in that order; the .dmg is opened
  // last, once everything else has been said, and the .app is not.
  expect(logLines(log)).toEqual([
    `${target} | install --frozen-lockfile`,
    `${target} | run build:desktop --local`,
    `open | ${dmg}`,
  ]);
  expect(stdout).toContain("Installing dependencies…");
  expect(stdout).toContain("Building the desktop app");
  expect(stdout).not.toContain("Starting ");
  expect(stdout).toContain(`SpecDriven ${VERSION} is built.`);
  expect(stdout).not.toContain("is running.");
  expect(stdout).toContain(`The packaged app is in ${join(target, "release")}`);
  expect(stdout.trim().split("\n").at(-1)).toBe(`Opening ${dmg}…`);
});

test("SPECDRIVEN_HANDOVER=0 builds the macOS app and opens nothing", async () => {
  // The running app updating itself (specs/app/app-updates.feature.md)
  // swaps the new bundle in and restarts on its own, so the installer must
  // leave the hand-over to it.
  const home = freshHome();
  const log = join(home, "bun.log");
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  const app = join(target, "release", "mac-arm64", "SpecDriven.app");
  const dmg = join(target, "release", `SpecDriven-${VERSION}-arm64.dmg`);
  const tools = toolbox(BUILD_TOOLS, {
    uname: fakeUname("Darwin"),
    bun: FAKE_BUN,
    open: FAKE_OPEN,
  });
  const env = { ...fakeRun(log, `mkdir -p ${shellQuote(app)}/Contents && : > ${shellQuote(dmg)}`), SPECDRIVEN_HANDOVER: "0" };

  const { stdout, stderr, code } = await runInstaller(good.url, home, { tools, env });
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(logLines(log)).toEqual([`${target} | install --frozen-lockfile`, `${target} | run build:desktop --local`]);
  expect(stdout).toContain(`SpecDriven ${VERSION} is built.`);
  expect(stdout).not.toContain("Opening ");
  expect(stdout).not.toContain("is running.");
  expect(existsSync(join(app, "Contents"))).toBe(true);
});

test("SPECDRIVEN_HANDOVER=0 makes the AppImage runnable but does not start it", async () => {
  const home = freshHome();
  const log = join(home, "bun.log");
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  const image = join(target, "release", `SpecDriven-${VERSION}-x86_64.AppImage`);
  const tools = toolbox(BUILD_TOOLS, {
    uname: fakeUname("Linux"),
    bun: FAKE_BUN,
  });
  const env = fakeRun(
    log,
    `mkdir -p ${shellQuote(join(target, "release"))}\n` +
      `printf '#!/bin/sh\\nprintf "appimage | started\\\\n" >> ${shellQuote(log)}\\n' > ${shellQuote(image)}\n` +
      `chmod 644 ${shellQuote(image)}`,
  );

  // A display is there; the flag alone keeps the app from starting.
  const { stdout, stderr, code } = await runInstaller(good.url, home, {
    tools,
    env: { ...env, DISPLAY: ":0", SPECDRIVEN_HANDOVER: "0" },
  });
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toContain(`Not starting ${image}: SPECDRIVEN_HANDOVER=0.`);
  expect(stdout).toContain(`SpecDriven ${VERSION} is built.`);
  expect(stdout).not.toContain("is running.");
  // Executable all the same: that is part of building it.
  expect(lstatSync(image).mode & 0o111).not.toBe(0);
  await Bun.sleep(100);
  expect(logLines(log)).toEqual([`${target} | install --frozen-lockfile`, `${target} | run build:desktop --local`]);
});

test("the messages survive a single-byte locale", async () => {
  // In a Latin-1 locale the bytes of "…" count as letters, so "$app…" is read
  // as a variable named app-plus-junk and `set -u` stops the run there. Every
  // variable an ellipsis follows is braced; this keeps it that way.
  const home = freshHome();
  const log = join(home, "bun.log");
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  const app = join(target, "release", "mac-arm64", "SpecDriven.app");
  const dmg = join(target, "release", `SpecDriven-${VERSION}-arm64.dmg`);
  const tools = toolbox(BUILD_TOOLS, {
    uname: fakeUname("Darwin"),
    bun: FAKE_BUN,
    open: FAKE_OPEN,
  });

  const { stderr, code } = await runInstaller(good.url, home, {
    tools,
    env: {
      ...fakeRun(log, `mkdir -p ${shellQuote(app)}/Contents && : > ${shellQuote(dmg)}`),
      LC_ALL: "en_US.ISO8859-1",
      LANG: "en_US.ISO8859-1",
    },
  });
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(logLines(log).at(-1)).toBe(`open | ${dmg}`);
});

test("the run ends with the AppImage made runnable and started", async () => {
  const home = freshHome();
  const log = join(home, "bun.log");
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  const image = join(target, "release", `SpecDriven-${VERSION}-x86_64.AppImage`);
  // electron-builder leaves the AppImage executable; this one is not, so the
  // chmod the script does is the reason it can run at all.
  const tools = toolbox(BUILD_TOOLS, {
    uname: fakeUname("Linux"),
    bun: FAKE_BUN,
  });
  const env = fakeRun(
    log,
    `mkdir -p ${shellQuote(join(target, "release"))}\n` +
      `printf '#!/bin/sh\\nprintf "appimage | started\\\\n" >> ${shellQuote(log)}\\n' > ${shellQuote(image)}\n` +
      `chmod 644 ${shellQuote(image)}`,
  );

  const { stdout, stderr, code } = await runInstaller(good.url, home, { tools, env: { ...env, DISPLAY: ":0" } });
  expect(stderr).toBe("");
  expect(code).toBe(0);

  expect(stdout).toContain(`Starting ${image}…`);
  expect(stdout).toContain(`SpecDriven ${VERSION} is running.`);
  expect(lstatSync(image).mode & 0o111).not.toBe(0);
  expect(await waits(() => logLines(log).includes("appimage | started"))).toBe(true);
  expect(logLines(log).slice(0, 2)).toEqual([`${target} | install --frozen-lockfile`, `${target} | run build:desktop --local`]);
});

test("with no display the app is built but left unstarted", async () => {
  const home = freshHome();
  const log = join(home, "bun.log");
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  const image = join(target, "release", `SpecDriven-${VERSION}-x86_64.AppImage`);
  const tools = toolbox(BUILD_TOOLS, {
    uname: fakeUname("Linux"),
    bun: FAKE_BUN,
  });
  const env = fakeRun(log, `mkdir -p ${shellQuote(join(target, "release"))} && : > ${shellQuote(image)}`);

  // A headless machine: no DISPLAY, no WAYLAND_DISPLAY.
  const { stdout, code } = await runInstaller(good.url, home, { tools, env });
  expect(code).toBe(0);
  expect(stdout).toContain(`No display to start it on. When there is one, run ${image}.`);
  expect(stdout).toContain(`SpecDriven ${VERSION} is built.`);
  expect(stdout).not.toContain("is running.");
});

test("a build that fails stops the run and says where the checkout is", async () => {
  const home = freshHome();
  const log = join(home, "bun.log");
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  const tools = toolbox(BUILD_TOOLS, { bun: FAKE_BUN });

  const { stderr, code } = await runInstaller(good.url, home, { tools, env: fakeRun(log, "exit 2") });
  expect(code).toBe(1);
  expect(stderr).toContain(`\`bun run build:desktop --local\` failed in ${target}`);
  // The verified source is still there to look at or build by hand.
  expect(existsSync(join(target, "package.json"))).toBe(true);
});

test("a failed `bun install` is reported the same way", async () => {
  const home = freshHome();
  const target = join(home, ".specdriven", "app", `specdriven-${VERSION}`);
  const tools = toolbox(BUILD_TOOLS, { bun: "#!/bin/sh\nexit 7\n" });

  const { stderr, code } = await runInstaller(good.url, home, { tools });
  expect(code).toBe(1);
  expect(stderr).toContain(`\`bun install\` failed in ${target}`);
});

// --- what the real release zip carries ---------------------------------------
//
// `git archive` follows nothing: a tracked symlink is archived as a symlink,
// and one that points outside the repo unpacks dangling — as does one into a
// submodule, which the archive carries as an empty folder. `specs` is such a
// link (the spec repo lives beside this one), and a dangling path in the tree
// stops `bun run build:desktop` — electron-builder stats everything under the
// project. Those links, and the submodules, belong in .gitattributes as
// `export-ignore`.

const REPO_ROOT = join(import.meta.dir, "..");

async function git(...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, code] = [await new Response(p.stdout).text(), await p.exited];
  if (code !== 0) throw new Error(await new Response(p.stderr).text());
  return out;
}

test("symlinks that dangle in the release source zip are kept out of it", async () => {
  // Mode 120000 is git's symlink, 160000 a submodule; the path is the last
  // tab-separated field.
  const entries = (await git("ls-files", "-s")).split("\n");
  const pathsOf = (mode: string) =>
    entries.filter((line) => line.startsWith(`${mode} `)).map((line) => line.slice(line.indexOf("\t") + 1));
  const submodules = pathsOf("160000").map((path) => join(REPO_ROOT, path));

  const dangling: string[] = [];
  for (const path of pathsOf("120000")) {
    const target = resolve(dirname(join(REPO_ROOT, path)), readlinkSync(join(REPO_ROOT, path)));
    const escapes = !target.startsWith(REPO_ROOT + "/");
    const intoSubmodule = submodules.some((dir) => target === dir || target.startsWith(dir + "/"));
    if (escapes || intoSubmodule) dangling.push(path);
  }
  expect(dangling).toContain("specs"); // the case that broke a build; keep the test honest

  for (const path of [...dangling, ...pathsOf("160000")]) {
    // `git check-attr` answers "<path>: export-ignore: set|unset|unspecified".
    const attr = await git("check-attr", "export-ignore", "--", path);
    expect(attr.trim()).toBe(`${path}: export-ignore: set`);
  }
});

// The demo dataset rides in the same zip — and in the GitHub archive the demo
// container is built from, which honors export-ignore too. An unanchored
// `specs export-ignore` matches at every depth, so it once stripped
// `demo-data/specs/` (the demo's feature files, and their Automerge docs) and
// the deployed demo opened with "No feature files yet". The pattern has to be
// anchored to the root, and nothing under demo-data/ may carry the attribute.
test("the demo dataset ships whole in the release source zip", async () => {
  const tracked = (await git("ls-files", "--", "demo-data")).split("\n").filter(Boolean);
  expect(tracked.some((p) => p.startsWith("demo-data/specs/"))).toBe(true); // keep the test honest

  // `git archive` prunes a whole directory whose own path carries the
  // attribute, while the files inside answer "unspecified" — attributes do
  // not propagate — so every ancestor directory is asked as well.
  const paths = new Set<string>();
  for (const file of tracked) {
    const parts = file.split("/");
    for (let i = 1; i <= parts.length; i += 1) paths.add(parts.slice(0, i).join("/"));
  }
  const p = Bun.spawn(["git", "check-attr", "export-ignore", "--stdin"], {
    cwd: REPO_ROOT, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  p.stdin.write([...paths].join("\n") + "\n");
  p.stdin.end();
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  const ignored = out.split("\n").filter((line) => line.endsWith(": export-ignore: set"));
  expect(ignored).toEqual([]);
});

// The zip also carries no `.git`. electron-builder's deb target wants a
// project homepage and, given none in package.json, reads one off the git
// remote — so a build from a checkout passed while the same source unpacked
// from the release zip failed with "Please specify project homepage"
// (issue #83). The homepage has to travel in package.json.
test("the deb target's homepage travels in package.json, not in .git", async () => {
  const { homepage } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  expect(typeof homepage).toBe("string");
  expect(() => new URL(homepage)).not.toThrow();
  expect(new URL(homepage).protocol).toBe("https:");
});

// Releases live on the app's own repository (specs/app/installation.feature.md).
// A curl that writes down what it was asked for and fails, so nothing reaches
// GitHub: the first thing the installer asks for is the latest release.
test("with no override, the releases come from SpecDriven/specdriven-app", async () => {
  const home = freshHome();
  const log = join(home, "curl.log");
  const fakeCurl = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_LOG"\nexit 22\n`;
  const tools = toolbox(BASE_TOOLS, { curl: fakeCurl });
  const { code } = await runInstaller("", home, { tools, env: { FAKE_LOG: log } });
  expect(code).not.toBe(0);
  const asked = readFileSync(log, "utf8").trim().split("\n");
  expect(asked[0]).toEndWith(" https://github.com/SpecDriven/specdriven-app/releases/latest");
  expect(appEntries(home)).toEqual([]);
});

// Automates specs/app/user-info-settings.feature.md "Signed commits": some
// repositories only take signed commits, and the app finds out which by
// itself — git's own config signs there, the newest commits on the remote
// are all signed, or the remote refused a push for want of a signature,
// which it remembers in the settings file's list of GitHub urls. A commit
// in such a repository is signed the way git on this computer signs — its
// key, and its git user as the author, since a signature only verifies for
// the email its key was made for.
//
// The signatures here are SSH ones: a throwaway key made by ssh-keygen, named
// in the test repository's own config. Nothing reads the developer's git
// config — GIT_CONFIG_GLOBAL points at an empty file for the length of this
// file — so a signing setup on the machine running the tests, or the lack of
// one, changes nothing.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { handleApi, reloader } from "../src/server/api";
import { commitAndPush, pull, push, pushProblem, setGitEngine, signingSettled, syncSavedChanges } from "../src/server/git";
import { parseCommit, resignWaiting } from "../src/server/git/resign";
import {
  BUILT_IN_CANNOT_SIGN,
  LOCKED_KEY_HINT,
  REFUSED_PUSH_HINT,
  SIGNED_HISTORY_DEPTH,
  SIGNING_HINT,
  SIGN_CONFIG,
  allSigned,
  forgetSigning,
  lockedKey,
  makesCommit,
  maySign,
  normalizeSignedCommitRepos,
  onSignedRepoLearned,
  parseRepoScope,
  rememberSigned,
  scopeUrl,
  setSignedCommitRepos,
  signatureRefusal,
  signingHint,
  signingReason,
  signsCommitsIn,
  signsCommitsTo,
} from "../src/server/git/signing";
import {
  MAX_PASSPHRASE_LENGTH,
  SIGNING_TIMEOUT_MS,
  askpassPath,
  checkSigningPassphrase,
  clearSigningPassphrase,
  passphraseRefusal,
  saveSigningPassphrase,
  setSigningTimeoutMs,
  signingEnv,
  signingPassphrase,
  signingTimeoutMs,
} from "../src/server/git/signingKey";
import { createSecretFileBackend, secretPath, setSecretBackend } from "../src/server/secrets";
import { readState, statePath, writeState } from "../src/server/state";
import { getCurrentUser } from "../src/server/user";
import { FAKE_GH_ACCOUNT, installFakeGh } from "./helpers/binPath";
import { cachedExecutable } from "./helpers/fakeBin";
import type { FakeGh } from "./helpers/binPath";
import { git, twoClones } from "./helpers/fixtures";

// The tests' PATH holds git alone (helpers/preload.ts), so git is told where
// ssh-keygen is; without one on this machine the signing tests are skipped.
const SSH_KEYGEN = ["/usr/bin/ssh-keygen", "/bin/ssh-keygen", "/usr/local/bin/ssh-keygen", "/opt/homebrew/bin/ssh-keygen"].find(
  (path) => existsSync(path),
);

const LISTED = "https://github.com/acme/specs";

let root: string;
let home: string;
let gh: FakeGh | null = null;
let globalConfigDir: string;
const real = {
  root: process.env.SPECDRIVEN_ROOT,
  home: process.env.SPECDRIVEN_HOME,
  globalConfig: process.env.GIT_CONFIG_GLOBAL,
};

beforeAll(async () => {
  globalConfigDir = await mkdtemp(join(tmpdir(), "specdriven-signed-gitconfig-"));
  await writeFile(join(globalConfigDir, "gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(globalConfigDir, "gitconfig");
});

afterAll(async () => {
  if (real.globalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = real.globalConfig;
  await rm(globalConfigDir, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-signed-"));
  home = await mkdtemp(join(tmpdir(), "specdriven-signed-home-"));
  process.env.SPECDRIVEN_ROOT = root;
  process.env.SPECDRIVEN_HOME = home;
});

afterEach(async () => {
  reloader.stop();
  gh?.restore();
  gh = null;
  setGitEngine(null);
  setSignedCommitRepos([]);
  forgetSigning();
  // The store remembers what it read: forget it with the home it was read from.
  setSecretBackend("commit-signing", null);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  for (const [name, value] of [
    ["SPECDRIVEN_ROOT", real.root],
    ["SPECDRIVEN_HOME", real.home],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The app signed in through the GitHub CLI: Octo Cat authors its commits. */
function signedInWithGh(): void {
  gh = installFakeGh();
  setGitEngine("gh");
}

/**
 * A repository whose git user is "Repo Config", with `origin` set to `url`
 * and — with `key` — a signing key of its own, as a machine set up to sign
 * with SSH has in its git config.
 */
async function repoWithOrigin(
  url: string,
  { key = true, passphrase = "" }: { key?: boolean; passphrase?: string } = {},
): Promise<string> {
  const repo = join(root, "local");
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "repo@example.com");
  await git(repo, "config", "user.name", "Repo Config");
  await git(repo, "remote", "add", "origin", url);
  if (key) await giveSigningKey(repo, "repo@example.com", passphrase);
  return repo;
}

/**
 * An SSH signing key in the repository's own config, and the signers file
 * that trusts it for `email`. With a passphrase the key file is encrypted,
 * as a key kept out of an agent is.
 */
async function giveSigningKey(repo: string, email: string, passphrase = ""): Promise<void> {
  const key = join(root, "signing-key");
  if (!existsSync(key)) await $`${SSH_KEYGEN!} -q -t ed25519 -N ${passphrase} -C signing -f ${key}`.quiet();
  await writeFile(join(root, "allowed-signers"), `${email} ${(await Bun.file(`${key}.pub`).text()).trim()}\n`);
  await git(repo, "config", "gpg.format", "ssh");
  await git(repo, "config", "gpg.ssh.program", SSH_KEYGEN!);
  await git(repo, "config", "user.signingkey", `${key}.pub`);
  await git(repo, "config", "gpg.ssh.allowedSignersFile", join(root, "allowed-signers"));
}

/** How git judges a commit's signature: "G" good, "N" none. */
async function signature(repo: string, rev = "HEAD"): Promise<string> {
  return (await git(repo, "log", "-1", "--format=%G?", rev)).stdout.toString().trim();
}

async function author(repo: string, rev = "HEAD"): Promise<string> {
  return (await git(repo, "log", "-1", "--format=%an <%ae>", rev)).stdout.toString().trim();
}

const send = async (method: string, path: string, body?: unknown) =>
  (await handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ))!;

const put = (body: unknown) => send("PUT", "/api/state", body);

/** Whether /api/state says a passphrase is kept. */
async function passphraseKept(): Promise<boolean> {
  const res = await send("GET", "/api/state");
  return ((await res.json()) as { signingPassphrase: boolean }).signingPassphrase;
}

// A key no agent holds: the tests' ssh-keygen must not find the developer's
// agent, nor an askpass of theirs.
const realSsh = { sock: process.env.SSH_AUTH_SOCK, askpass: process.env.SSH_ASKPASS };
beforeAll(() => {
  delete process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_ASKPASS;
});
afterAll(() => {
  if (realSsh.sock !== undefined) process.env.SSH_AUTH_SOCK = realSsh.sock;
  if (realSsh.askpass !== undefined) process.env.SSH_ASKPASS = realSsh.askpass;
});

// --- Which repositories -------------------------------------------------------------

test("a listed url names a repository, an owner or a host, in any form it is written", () => {
  expect(parseRepoScope("https://github.com/acme/specs")).toEqual({ host: "github.com", path: ["acme", "specs"] });
  expect(parseRepoScope(" https://www.GitHub.com/acme/specs.git/ ")).toEqual({ host: "github.com", path: ["acme", "specs"] });
  expect(parseRepoScope("https://github.com/acme/specs/tree/main")).toEqual({ host: "github.com", path: ["acme", "specs"] });
  expect(parseRepoScope("github.com/acme")).toEqual({ host: "github.com", path: ["acme"] });
  expect(parseRepoScope("https://github.example.com")).toEqual({ host: "github.example.com", path: [] });
  expect(parseRepoScope("git@github.com:acme/specs.git")).toEqual({ host: "github.com", path: ["acme", "specs"] });
  expect(parseRepoScope("ssh://git@github.example.com:22/acme/specs")).toEqual({
    host: "github.example.com",
    path: ["acme", "specs"],
  });
  expect(parseRepoScope("https://octo@github.com/acme/specs.git")).toEqual({ host: "github.com", path: ["acme", "specs"] });
  // Whichever way it was written, it is kept the one way.
  expect(scopeUrl(parseRepoScope("git@github.com:acme/specs.git")!)).toBe(LISTED);
  expect(scopeUrl(parseRepoScope("github.example.com")!)).toBe("https://github.example.com");
});

test("a folder, a bare owner/repo and anything else that names no host is not a url", () => {
  for (const text of ["", "   ", "acme/specs", "/Users/me/specs", "~/specs", "ftp://github.com/acme", "not a url", "https://"]) {
    expect(parseRepoScope(text)).toBeNull();
  }
});

test("the list is kept as written urls, each once", () => {
  expect(
    normalizeSignedCommitRepos([
      "git@github.com:acme/specs.git",
      "https://github.com/Acme/Specs",
      "github.example.com/team",
      "/Users/me/specs",
      7,
    ]),
  ).toEqual(["https://github.com/acme/specs", "https://github.example.com/team"]);
  expect(normalizeSignedCommitRepos(undefined)).toEqual([]);
  expect(normalizeSignedCommitRepos("https://github.com/acme/specs")).toEqual([]);
});

test("a remote is signed when a listed url covers its repository, its owner or its host", () => {
  setSignedCommitRepos([LISTED, "https://github.com/team", "https://github.example.com"]);
  // The repository, however its remote is written, whatever the case.
  expect(signsCommitsTo("https://github.com/acme/specs.git")).toBe(true);
  expect(signsCommitsTo("git@github.com:Acme/Specs.git")).toBe(true);
  expect(signsCommitsTo("ssh://git@github.com/acme/specs")).toBe(true);
  // Every repository of a listed owner, and of a listed host.
  expect(signsCommitsTo("https://github.com/team/anything")).toBe(true);
  expect(signsCommitsTo("git@github.example.com:whoever/whatever.git")).toBe(true);
  // Not another repository of the same owner, nor one that only starts alike.
  expect(signsCommitsTo("https://github.com/acme/other")).toBe(false);
  expect(signsCommitsTo("https://github.com/acme/specs-archive")).toBe(false);
  expect(signsCommitsTo("https://github.com/teammates/anything")).toBe(false);
  expect(signsCommitsTo("/Users/me/origin.git")).toBe(false);
  expect(signsCommitsTo(null)).toBe(false);
});

test("with nothing listed, and nothing in git to say so, no commit is signed", async () => {
  const repo = await repoWithOrigin(LISTED, { key: false });
  expect(signsCommitsTo(LISTED)).toBe(false);
  expect(await signingReason(repo)).toBeNull();
  expect(await signsCommitsIn(repo)).toBe(false);
});

// --- What tells the app -------------------------------------------------------------

test.skipIf(!SSH_KEYGEN)("where git's own config signs, the app signs too, as this computer's git user", async () => {
  const repo = await repoWithOrigin("https://github.com/acme/other.git");
  await git(repo, "config", "commit.gpgsign", "true");
  signedInWithGh();

  expect(await signingReason(repo)).toBe("git-config");
  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");
  await commitAndPush(repo, "specs/one.feature.md", "Add one");

  // Signed by git's rule, and authored by the key's own git user: left to
  // the GitHub account, the signature would be for somebody else's email.
  expect(await signature(repo)).toBe("G");
  expect(await author(repo)).toBe("Repo Config <repo@example.com>");
});

test("what git said about a folder stands for a while, rather than being asked at every commit", async () => {
  const repo = await repoWithOrigin("https://github.com/acme/other.git", { key: false });
  expect(await signingReason(repo)).toBeNull();
  await git(repo, "config", "commit.gpgsign", "true");
  expect(await signingReason(repo)).toBeNull();
  forgetSigning();
  expect(await signingReason(repo)).toBe("git-config");
  // The list is the app's own, and is in effect at once.
  await git(repo, "config", "--unset", "commit.gpgsign");
  forgetSigning();
  expect(await signingReason(repo)).toBeNull();
  setSignedCommitRepos(["https://github.com/acme"]);
  expect(await signingReason(repo)).toBe("listed");
});

test("a log is signed when every commit in it carries a signature, and there is one", () => {
  const commit = (sha: string, signed: boolean, message = "Add one") =>
    `commit ${sha}\ntree ${"a".repeat(40)}\nauthor A <a@example.com> 1700000000 +0100\ncommitter A <a@example.com> 1700000000 +0100\n${
      signed ? "gpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----\n" : ""
    }\n    ${message}\n`;
  expect(allSigned(commit("1".repeat(40), true) + "\n" + commit("2".repeat(40), true))).toBe(true);
  expect(allSigned(commit("1".repeat(40), true) + "\n" + commit("2".repeat(40), false))).toBe(false);
  // A message that talks about signatures is indented, and is no header.
  expect(allSigned(commit("1".repeat(40), false, "gpgsig is what a signed commit has"))).toBe(false);
  expect(allSigned("")).toBe(false);
});

test.skipIf(!SSH_KEYGEN)("where the newest commits on the remote are all signed, the app signs too — on a computer that has a key", async () => {
  const { a, b } = await twoClones(root);
  await giveSigningKey(b, "test@example.com");
  setGitEngine("cli");
  // The remote's history as cloned: nobody signed anything.
  expect(await signingReason(a)).toBeNull();

  // A teammate who signs pushes as many commits as the app looks at.
  for (let n = 1; n <= SIGNED_HISTORY_DEPTH; n++) {
    await Bun.write(join(b, `specs/theirs-${n}.feature.md`), `# Theirs ${n}\n`);
    await git(b, "add", ".");
    await git(b, "-c", "commit.gpgsign=true", "commit", "-m", `theirs ${n}`);
  }
  await git(b, "push");
  expect((await pull(a)).ok).toBe(true);

  // Without a key this computer could not keep to it, and must still save.
  forgetSigning();
  expect(await signingReason(a)).toBeNull();
  await giveSigningKey(a, "test@example.com");
  forgetSigning();
  expect(await signingReason(a)).toBe("history");

  await Bun.write(join(a, "specs/mine.feature.md"), "# Mine\n");
  expect((await syncSavedChanges(a)).pushed).toBe(true);
  expect(await signature(a)).toBe("G");

  // One unsigned commit among the newest, and it is no rule any more.
  await Bun.write(join(b, "specs/unsigned.feature.md"), "# Unsigned\n");
  await git(b, "pull");
  await git(b, "add", ".");
  await git(b, "commit", "-m", "unsigned");
  await git(b, "push");
  expect((await pull(a)).ok).toBe(true);
  forgetSigning();
  expect(await signingReason(a)).toBeNull();
});

// --- A push refused for want of a signature -----------------------------------------

// What a GitHub branch that requires signatures does, as a hook of the bare
// origin: a push holding a commit without a signature is refused, in
// GitHub's words. Only git and the shell's own words — the tests' PATH
// holds git alone.
const SIGNATURES_REQUIRED = `#!/bin/sh
while read old new ref; do
  case "$old" in *[!0]*) range="$old..$new" ;; *) range="$new" ;; esac
  for commit in $(git rev-list "$range"); do
    case "$(git cat-file commit "$commit")" in
      *"
gpgsig "*) ;;
      *)
        echo "error: GH006: Protected branch update failed for $ref." >&2
        echo "error: Commits must have verified signatures." >&2
        exit 1
        ;;
    esac
  done
done
`;

async function requireSignatures(originDir: string): Promise<void> {
  await mkdir(join(originDir, "hooks"), { recursive: true });
  await rm(join(originDir, "hooks", "pre-receive"), { force: true });
  await symlink(cachedExecutable(SIGNATURES_REQUIRED), join(originDir, "hooks", "pre-receive"));
}

test("a refused push is recognized by the host's words about signatures", () => {
  expect(
    signatureRefusal(
      "remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Commits must have verified signatures.",
    ),
  ).toBe(true);
  expect(
    signatureRefusal(
      "remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Commits must have verified signatures.\nremote:   Found 1 violation:",
    ),
  ).toBe(true);
  expect(signatureRefusal("remote: GitLab: Commit must be signed with a GPG key")).toBe(true);
  expect(signatureRefusal("remote: Permission to acme/specs.git denied to octocat.")).toBe(false);
  expect(signatureRefusal("! [rejected] main -> main (non-fast-forward)")).toBe(false);
});

test("a commit object is read for what making it again needs", () => {
  const raw =
    `tree ${"a".repeat(40)}\nparent ${"b".repeat(40)}\nparent ${"c".repeat(40)}\n` +
    "author Ada Lovelace <ada@example.com> 1700000000 +0100\ncommitter Octo Cat <octo@example.com> 1700000001 +0000\n" +
    "\nMerge theirs\n\ngpgsig is not a header down here\n";
  expect(parseCommit(raw)).toEqual({
    tree: "a".repeat(40),
    parents: ["b".repeat(40), "c".repeat(40)],
    author: { name: "Ada Lovelace", email: "ada@example.com", date: "@1700000000 +0100" },
    message: "Merge theirs\n\ngpgsig is not a header down here\n",
    signed: false,
  });
  expect(parseCommit(raw.replace("\n\nMerge", "\ngpgsig -----BEGIN SSH SIGNATURE-----\n abc\n -----END SSH SIGNATURE-----\n\nMerge"))!.signed).toBe(true);
  expect(parseCommit("not a commit")).toBeNull();
});

test("a repository that refused unsigned commits is remembered once, by its url, and a remote without one for as long as the app runs", async () => {
  const kept: string[] = [];
  const writer = onSignedRepoLearned(async (url) => void kept.push(url));
  try {
    const repo = await repoWithOrigin("git@github.com:acme/specs.git", { key: false });
    expect(await signingReason(repo)).toBeNull();
    expect(await rememberSigned(repo)).toBe(LISTED);
    // In effect at once, handed to the settings file's writer, and not twice.
    expect(await signingReason(repo)).toBe("listed");
    expect(await rememberSigned(repo)).toBe(LISTED);
    expect(kept).toEqual([LISTED]);

    // A remote that is a folder on this computer has no url the list could hold.
    const { a } = await twoClones(root);
    expect(await rememberSigned(a)).toBeNull();
    expect(await signingReason(a)).toBe("listed");
    expect(kept).toEqual([LISTED]);
    forgetSigning();
    expect(await signingReason(a)).toBeNull();
  } finally {
    onSignedRepoLearned(writer);
  }
});

test.skipIf(!SSH_KEYGEN)("only commits the remote lacks are signed again, and only while one of them is unsigned", async () => {
  const { a } = await twoClones(root);
  await giveSigningKey(a, "test@example.com");
  const head = async () => (await git(a, "rev-parse", "HEAD")).stdout.toString().trim();
  const seeded = await head();

  // Nothing waits: the commits the remote holds are nobody's to make again.
  expect(await resignWaiting(a)).toBe(0);
  expect(await head()).toBe(seeded);

  await Bun.write(join(a, "specs/waiting.feature.md"), "# Waiting\n");
  await git(a, "add", ".");
  await git(a, "commit", "-m", "waiting");
  expect(await resignWaiting(a)).toBe(1);
  expect(await signature(a)).toBe("G");
  expect((await git(a, "rev-parse", "HEAD~1")).stdout.toString().trim()).toBe(seeded);

  // All signed now: a second refusal — a key the host does not know — makes nothing again.
  const signed = await head();
  expect(await resignWaiting(a)).toBe(0);
  expect(await head()).toBe(signed);
});

test.skipIf(!SSH_KEYGEN)("a push refused for want of a signature is remembered, and the waiting commits are signed and pushed", async () => {
  const { a, originDir } = await twoClones(root);
  await writeState({ dataRepo: a }, root);
  // `a` is a GitHub repository's clone: its origin is the url, and git
  // reaches the bare origin on disk in its place.
  await git(a, "config", "remote.origin.url", LISTED);
  await git(a, "config", `url.${originDir}.insteadOf`, LISTED);
  await giveSigningKey(a, "test@example.com");
  await requireSignatures(originDir);
  setGitEngine("cli");
  expect(await signingReason(a)).toBeNull();

  // Two commits made before anyone knew, by somebody else's hand, and an
  // edit that is saved but not committed yet.
  for (const n of [1, 2]) {
    await Bun.write(join(a, `specs/waiting-${n}.feature.md`), `# Waiting ${n}\n`);
    await git(a, "add", ".");
    await git(a, "-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com", "commit", "-m", `waiting ${n}\n\nwith a body`);
  }
  await Bun.write(join(a, "specs/unsaved.feature.md"), "# Not committed yet\n");
  const before = (await git(a, "log", "-2", "--format=%an <%ae>|%at|%B")).stdout.toString();

  const refused = await push(a);
  expect(refused.pushed).toBe(false);
  expect(refused.failure).toContain("Commits must have verified signatures");
  expect(pushProblem(a)).toContain(REFUSED_PUSH_HINT);
  await signingSettled();

  // Remembered: in effect, and in the settings file for the next start.
  expect(await signingReason(a)).toBe("listed");
  expect((await readState(root)).signedCommitRepos).toEqual([LISTED]);
  // The same two commits — message, author, author date — now signed, and
  // on the remote; what was not committed is where it was.
  expect((await git(a, "log", "-2", "--format=%an <%ae>|%at|%B")).stdout.toString()).toBe(before);
  expect(await signature(a, "HEAD")).toBe("G");
  expect(await signature(a, "HEAD~1")).toBe("G");
  expect((await git(a, "rev-parse", "origin/main")).stdout.toString()).toBe((await git(a, "rev-parse", "HEAD")).stdout.toString());
  expect(pushProblem(a)).toBeNull();
  expect((await git(a, "status", "--porcelain")).stdout.toString().trim()).toBe("?? specs/unsaved.feature.md");

  // From now on a save is signed when it is made, and goes straight through.
  const synced = await syncSavedChanges(a);
  expect(synced.pushed).toBe(true);
  expect(await signature(a)).toBe("G");
});

test.skipIf(!SSH_KEYGEN)("where the waiting commits cannot be signed, the push problem stands and the branch has not moved", async () => {
  const { a, originDir } = await twoClones(root);
  await writeState({ dataRepo: a }, root);
  await git(a, "config", "remote.origin.url", LISTED);
  await git(a, "config", `url.${originDir}.insteadOf`, LISTED);
  await giveSigningKey(a, "test@example.com");
  await git(a, "config", "user.signingkey", join(root, "no-such-key.pub"));
  await requireSignatures(originDir);
  setGitEngine("cli");

  await Bun.write(join(a, "specs/waiting.feature.md"), "# Waiting\n");
  await git(a, "add", ".");
  await git(a, "commit", "-m", "waiting");
  const head = (await git(a, "rev-parse", "HEAD")).stdout.toString();

  expect((await push(a)).pushed).toBe(false);
  await signingSettled();

  expect((await git(a, "rev-parse", "HEAD")).stdout.toString()).toBe(head);
  expect(pushProblem(a)).toContain("Commits must have verified signatures");
  expect(pushProblem(a)).toContain(REFUSED_PUSH_HINT);
  // Still remembered: the next commit is signed, or says why it cannot be.
  expect(await signingReason(a)).toBe("listed");
});

test("Settings is told why the open folder's commits are signed", async () => {
  const repo = await repoWithOrigin("https://github.com/acme/other.git", { key: false });
  await writeState({ dataRepo: repo }, root);
  const reason = async () =>
    ((await (await send("GET", "/api/state")).json()) as { commitSigning: string | null }).commitSigning;

  expect(await reason()).toBeNull();
  await git(repo, "config", "commit.gpgsign", "true");
  forgetSigning();
  expect(await reason()).toBe("git-config");
  await git(repo, "config", "--unset", "commit.gpgsign");
  forgetSigning();
  setSignedCommitRepos(["https://github.com/acme/other"]);
  expect(await reason()).toBe("listed");
});

// --- The setting --------------------------------------------------------------------

test("the signed-commit urls round-trip through the settings file, and take effect at once", async () => {
  await writeState({ dataRepo: join(root, "data") }, root);
  const before = (await handleApi(new Request("http://localhost/api/state")))!;
  expect(((await before.json()) as { signedCommitRepos: string[] }).signedCommitRepos).toEqual([]);

  const saved = await put({ signedCommitRepos: ["git@github.com:acme/specs.git", "github.com/team"] });
  expect(saved.status).toBe(200);
  const urls = [LISTED, "https://github.com/team"];
  expect(((await saved.json()) as { signedCommitRepos: string[] }).signedCommitRepos).toEqual(urls);
  expect((await readState(root)).signedCommitRepos).toEqual(urls);
  expect(signsCommitsTo("https://github.com/acme/specs.git")).toBe(true);

  // An empty list is the default, stored as an absent key.
  const cleared = await put({ signedCommitRepos: [] });
  expect(((await cleared.json()) as { signedCommitRepos: string[] }).signedCommitRepos).toEqual([]);
  expect((await readState(root)).signedCommitRepos).toBeUndefined();
  expect(signsCommitsTo("https://github.com/acme/specs.git")).toBe(false);
});

test("an entry that is not a url is refused, and the list stays as it was", async () => {
  await writeState({ dataRepo: join(root, "data"), signedCommitRepos: [LISTED] }, root);
  const res = await put({ signedCommitRepos: [LISTED, "acme/specs"] });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain('"acme/specs" is not a GitHub url');
  expect((await put({ signedCommitRepos: "https://github.com/acme/specs" })).status).toBe(400);
  expect((await readState(root)).signedCommitRepos).toEqual([LISTED]);
});

// --- The commits --------------------------------------------------------------------

test.skipIf(!SSH_KEYGEN)("a commit to a listed repository is signed, and authored by this computer's git user", async () => {
  const repo = await repoWithOrigin("git@github.com:acme/specs.git");
  signedInWithGh();
  setSignedCommitRepos([LISTED]);

  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");
  await commitAndPush(repo, "specs/one.feature.md", "Add one");

  // Good for repo@example.com: the key's own email, not the GitHub account's.
  expect(await signature(repo)).toBe("G");
  expect(await author(repo)).toBe("Repo Config <repo@example.com>");
});

test.skipIf(!SSH_KEYGEN)("a commit to a repository that is not listed is left unsigned, authored by the GitHub account", async () => {
  const repo = await repoWithOrigin("https://github.com/acme/other.git");
  signedInWithGh();
  setSignedCommitRepos([LISTED]);

  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");
  await commitAndPush(repo, "specs/one.feature.md", "Add one");

  expect(await signature(repo)).toBe("N");
  expect(await author(repo)).toBe(`${FAKE_GH_ACCOUNT.name} <${FAKE_GH_ACCOUNT.email}>`);
});

test.skipIf(!SSH_KEYGEN)("the sync's own commit and the merge of a pull are signed too", async () => {
  const { a, b, originDir } = await twoClones(root);
  // `a` is the listed repository's clone: its origin is the GitHub url, and
  // git reaches the bare origin on disk in its place.
  await git(a, "config", "remote.origin.url", LISTED);
  await git(a, "config", `url.${originDir}.insteadOf`, LISTED);
  await giveSigningKey(a, "test@example.com");
  setGitEngine("cli");
  setSignedCommitRepos([LISTED]);

  // A teammate's commit on the remote, and an edit saved here: the sync
  // commits the edit, and the pull that follows has two sides to merge.
  await Bun.write(join(b, "specs/theirs.feature.md"), "# Theirs\n");
  await git(b, "add", ".");
  await git(b, "commit", "-m", "theirs");
  await git(b, "push");
  await rm(originDir + ".away", { recursive: true, force: true });
  await Bun.write(join(a, "specs/mine.feature.md"), "# Mine\n");
  await git(a, "add", ".");
  await git(a, "-c", "commit.gpgsign=true", "commit", "-m", "mine");

  expect((await pull(a)).ok).toBe(true);
  expect((await git(a, "log", "-1", "--format=%P")).stdout.toString().trim().split(" ")).toHaveLength(2);
  expect(await signature(a)).toBe("G");

  await Bun.write(join(a, "specs/later.feature.md"), "# Later\n");
  const synced = await syncSavedChanges(a);
  expect(synced.pushed).toBe(true);
  expect(await signature(a)).toBe("G");
});

test.skipIf(!SSH_KEYGEN)("a commit that cannot be signed fails, saying where git looks for the key", async () => {
  const repo = await repoWithOrigin(LISTED);
  await git(repo, "config", "user.signingkey", join(root, "no-such-key.pub"));
  signedInWithGh();
  setSignedCommitRepos([LISTED]);

  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");
  const failed = await commitAndPush(repo, "specs/one.feature.md", "Add one").then(
    () => null,
    (e: Error) => e.message,
  );

  expect(failed).toStartWith("git commit failed: ");
  expect(failed).toContain(SIGNING_HINT);
  // Nothing was committed: what was saved waits in the working tree.
  expect((await git(repo, "status", "--porcelain")).stdout.toString()).toContain("specs/one.feature.md");
});

test("the built-in git cannot sign, so it refuses a commit to a listed repository", async () => {
  const repo = await repoWithOrigin(LISTED, { key: false });
  setGitEngine("js");
  setSignedCommitRepos([LISTED]);

  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");
  expect(commitAndPush(repo, "specs/one.feature.md", "Add one")).rejects.toThrow(
    `git commit failed: ${BUILT_IN_CANNOT_SIGN}`,
  );
  // No unsigned commit was left behind for the remote to turn away.
  expect((await $`git -C ${repo} rev-parse --verify --quiet HEAD`.quiet().nothrow()).exitCode).not.toBe(0);

  // Off the list, the same engine commits as before — also where signing
  // is only git's own habit, which this engine cannot keep to: nobody is
  // stopped from saving for it.
  setSignedCommitRepos([]);
  await git(repo, "config", "commit.gpgsign", "true");
  forgetSigning();
  expect(await signingReason(repo)).toBe("git-config");
  await commitAndPush(repo, "specs/one.feature.md", "Add one");
  expect((await git(repo, "log", "-1", "--format=%s")).stdout.toString().trim()).toBe("Add one");
});

test.skipIf(!SSH_KEYGEN)("User info names this computer's git user as the commit author of a listed data repo", async () => {
  const repo = await repoWithOrigin(LISTED);
  await writeState({ dataRepo: repo }, root);
  signedInWithGh();

  expect(await getCurrentUser()).toMatchObject({ login: FAKE_GH_ACCOUNT.login, name: FAKE_GH_ACCOUNT.name });
  setSignedCommitRepos([LISTED]);
  // The account is still who is signed in; the commits are the git user's.
  expect(await getCurrentUser()).toMatchObject({
    login: FAKE_GH_ACCOUNT.login,
    name: "Repo Config",
    email: "repo@example.com",
  });
});

// --- The key's passphrase -----------------------------------------------------------

const PASSPHRASE = "correct horse 'battery' $taple";

test.skipIf(!SSH_KEYGEN)("a commit is signed with a passphrase-protected key once its passphrase is kept in Settings", async () => {
  const repo = await repoWithOrigin(LISTED, { passphrase: PASSPHRASE });
  await writeState({ dataRepo: repo, signedCommitRepos: [LISTED] }, root);
  setGitEngine("cli");
  setSignedCommitRepos([LISTED]);
  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");

  // Nobody to ask: the app has no terminal, and no agent holds the key. The
  // commit fails at once rather than wait for an answer, and says what to do.
  expect(await passphraseKept()).toBe(false);
  const failed = await commitAndPush(repo, "specs/one.feature.md", "Add one").then(
    () => null,
    (e: Error) => e.message,
  );
  expect(failed).toContain(LOCKED_KEY_HINT);

  const saved = await send("PUT", "/api/signing/passphrase", { passphrase: PASSPHRASE });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ signingPassphrase: true, checked: true, key: join(root, "signing-key") });
  expect(await passphraseKept()).toBe(true);

  await commitAndPush(repo, "specs/one.feature.md", "Add one");
  expect(await signature(repo)).toBe("G");
});

test.skipIf(!SSH_KEYGEN)("a passphrase that does not unlock the signing key is refused, and none is kept", async () => {
  const repo = await repoWithOrigin(LISTED, { passphrase: PASSPHRASE });
  await writeState({ dataRepo: repo }, root);

  const res = await send("PUT", "/api/signing/passphrase", { passphrase: "not it" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe(
    `That passphrase does not unlock ${join(root, "signing-key")}`,
  );
  expect(await signingPassphrase()).toBeNull();
  expect(await checkSigningPassphrase(PASSPHRASE, repo)).toEqual({ outcome: "unlocks", key: join(root, "signing-key") });
});

test.skipIf(!SSH_KEYGEN)("the passphrase is kept apart from the settings file, never sent back, and removed on request", async () => {
  const repo = await repoWithOrigin(LISTED, { passphrase: PASSPHRASE });
  await writeState({ dataRepo: repo }, root);
  expect((await send("PUT", "/api/signing/passphrase", { passphrase: PASSPHRASE })).status).toBe(200);

  // In the secret store, for the owner alone; the script that hands it to
  // ssh-keygen holds none of it.
  expect(await Bun.file(statePath(root)).text()).not.toContain("battery");
  expect(await Bun.file(secretPath("commit-signing")).text()).toContain("battery");
  expect((await Bun.file(secretPath("commit-signing")).stat()).mode & 0o077).toBe(0);
  expect(await Bun.file(askpassPath()).text()).not.toContain("battery");
  expect(await (await send("GET", "/api/state")).text()).not.toContain("battery");

  const removed = await send("DELETE", "/api/signing/passphrase");
  expect(await removed.json()).toEqual({ signingPassphrase: false });
  expect(await passphraseKept()).toBe(false);
  expect(await signingPassphrase()).toBeNull();
});

test("a passphrase is one non-empty line; with no key to try it on, it is kept unchecked", async () => {
  const repo = await repoWithOrigin(LISTED, { key: false });
  await writeState({ dataRepo: repo }, root);
  for (const passphrase of ["", 7, "two\nlines", "x".repeat(MAX_PASSPHRASE_LENGTH + 1)]) {
    expect(passphraseRefusal(passphrase)).toBeString();
    expect((await send("PUT", "/api/signing/passphrase", { passphrase })).status).toBe(400);
  }
  expect(passphraseRefusal("x".repeat(MAX_PASSPHRASE_LENGTH))).toBeNull();
  expect(passphraseRefusal(PASSPHRASE)).toBeNull();
  const saved = await send("PUT", "/api/signing/passphrase", { passphrase: PASSPHRASE });
  expect(await saved.json()).toEqual({ signingPassphrase: true, checked: false, key: null });
  await send("DELETE", "/api/signing/passphrase");
});

test.skipIf(!SSH_KEYGEN)("a sync whose commit cannot be signed tells the page why, until one is", async () => {
  const repo = await repoWithOrigin(LISTED, { passphrase: PASSPHRASE });
  await writeState({ dataRepo: repo }, root);
  setGitEngine("cli");
  setSignedCommitRepos([LISTED]);
  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");

  expect(syncSavedChanges(repo)).rejects.toThrow(LOCKED_KEY_HINT);
  // What the Sync button and the toast show (git-operations.md "a push
  // that fails is shown"): the edit is on this computer only.
  expect(pushProblem(repo)).toContain(LOCKED_KEY_HINT);

  expect((await send("PUT", "/api/signing/passphrase", { passphrase: PASSPHRASE })).status).toBe(200);
  const synced = await syncSavedChanges(repo);
  expect(synced.message).toContain("saved scenarios committed");
  expect(await signature(repo)).toBe("G");
  expect(pushProblem(repo)).toBeNull();
});

test("only the git commands that can make a commit are told to sign", () => {
  for (const verb of ["commit", "merge", "pull"]) expect(makesCommit(verb)).toBe(true);
  for (const verb of ["push", "fetch", "add", "status", "clone", undefined]) expect(makesCommit(verb)).toBe(false);
  // Signing is asked of that one command, never written into git's config.
  expect(SIGN_CONFIG).toEqual(["-c", "commit.gpgsign=true"]);
  // The ones that stay on this computer are answered for a key's passphrase;
  // a pull talks to the remote, where ssh has questions of its own.
  expect(["commit", "merge", "pull", "push", "fetch", undefined].filter(maySign)).toEqual(["commit", "merge"]);
});

test("a failed signature names its fix, a locked key's passphrase or else where git looks for the key", () => {
  expect(signingHint('error: Load key "/keys/id": incorrect passphrase supplied to decrypt private key')).toBe(LOCKED_KEY_HINT);
  expect(signingHint("error: gpg failed to sign the data")).toBe(SIGNING_HINT);
  expect(signingHint("error: Couldn't load public key /keys/id.pub: No such file or directory")).toBe(SIGNING_HINT);
  // Off the list git only signs by its own config: a locked key is still
  // the app's to explain, anything else is git's.
  expect(lockedKey('error: Load key "/keys/id": incorrect passphrase supplied to decrypt private key')).toBe(true);
  expect(signingHint('error: Load key "/keys/id": incorrect passphrase supplied to decrypt private key', false)).toBe(LOCKED_KEY_HINT);
  expect(signingHint("error: gpg failed to sign the data", false)).toBeNull();
});

test("ssh-keygen is answered with the kept passphrase, else by the user's own askpass, and never on the terminal", async () => {
  // None kept and no askpass of the user's: the app's script stands in, with nothing to say.
  const none = await signingEnv();
  expect(none.SSH_ASKPASS).toBe(askpassPath());
  expect(none.SSH_ASKPASS_REQUIRE).toBe("force");
  expect(none.SPECDRIVEN_SIGNING_PASSPHRASE).toBeUndefined();

  process.env.SSH_ASKPASS = "/usr/local/bin/their-askpass";
  try {
    // Theirs is left in place — and used even when the app was started from a terminal.
    const theirs = await signingEnv();
    expect(theirs.SSH_ASKPASS).toBeUndefined();
    expect(theirs.SSH_ASKPASS_REQUIRE).toBe("force");

    // A passphrase kept in Settings is the answer, whatever else could give one.
    await saveSigningPassphrase(PASSPHRASE);
    const kept = await signingEnv();
    expect(kept.SSH_ASKPASS).toBe(askpassPath());
    expect(kept.SPECDRIVEN_SIGNING_PASSPHRASE).toBe(PASSPHRASE);
  } finally {
    delete process.env.SSH_ASKPASS;
  }

  await clearSigningPassphrase();
  expect(await signingPassphrase()).toBeNull();
  expect((await signingEnv()).SPECDRIVEN_SIGNING_PASSPHRASE).toBeUndefined();
});

test.skipIf(process.platform === "win32")("a signing program that never answers is stopped, and the commit fails", async () => {
  expect(signingTimeoutMs()).toBe(SIGNING_TIMEOUT_MS);
  expect(SIGNING_TIMEOUT_MS).toBe(120_000);
  // A GPG whose prompt nobody sees: it just waits.
  const repo = await repoWithOrigin(LISTED, { key: false });
  await git(repo, "config", "gpg.program", cachedExecutable("#!/bin/sh\nexec /bin/sleep 5\n"));
  await git(repo, "config", "user.signingkey", "ABCDEF12");
  setGitEngine("cli");
  setSignedCommitRepos([LISTED]);
  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");

  const before = setSigningTimeoutMs(300);
  const started = Date.now();
  try {
    const failed = await commitAndPush(repo, "specs/one.feature.md", "Add one").then(
      () => null,
      (e: Error) => e.message,
    );
    expect(failed).toContain("was stopped");
    expect(failed).toContain(SIGNING_HINT);
    expect(Date.now() - started).toBeLessThan(4_000);
  } finally {
    setSigningTimeoutMs(before);
  }
  // Nothing was committed, and the folder's next save is not left waiting.
  expect((await $`git -C ${repo} rev-parse --verify --quiet HEAD`.quiet().nothrow()).exitCode).not.toBe(0);
});

test.skipIf(!SSH_KEYGEN)("a commit git signs by its own config, off the list, fails at once on a locked key instead of waiting", async () => {
  // Git's own config signs every commit here — `commit.gpgsign` — and the
  // repository is not one Settings lists.
  const repo = await repoWithOrigin("https://github.com/acme/other.git", { passphrase: PASSPHRASE });
  await git(repo, "config", "commit.gpgsign", "true");
  await writeState({ dataRepo: repo }, root);
  setGitEngine("cli");
  await Bun.write(join(repo, "specs/one.feature.md"), "# One\n");

  // ssh-keygen used to ask on the terminal the app was started from, and
  // the commit — and every save and folder switch behind it — never ended.
  const started = Date.now();
  expect(syncSavedChanges(repo)).rejects.toThrow(LOCKED_KEY_HINT);
  expect(Date.now() - started).toBeLessThan(4_000);
  expect(pushProblem(repo)).toContain(LOCKED_KEY_HINT);

  // The passphrase kept in Settings signs there too.
  expect((await send("PUT", "/api/signing/passphrase", { passphrase: PASSPHRASE })).status).toBe(200);
  const synced = await syncSavedChanges(repo);
  expect(synced.message).toContain("saved scenarios committed");
  expect(await signature(repo)).toBe("G");
  expect(pushProblem(repo)).toBeNull();
});

test("a passphrase saved by another copy of the app is found without a restart", async () => {
  // This copy has looked, and found none.
  expect(await signingPassphrase()).toBeNull();
  expect((await signingEnv()).SPECDRIVEN_SIGNING_PASSPHRASE).toBeUndefined();

  // The desktop app beside a development server, say: it writes the same file.
  const elsewhere = createSecretFileBackend("commit-signing");
  await elsewhere.save({ passphrase: PASSPHRASE });
  expect(await signingPassphrase()).toBe(PASSPHRASE);
  expect((await signingEnv()).SPECDRIVEN_SIGNING_PASSPHRASE).toBe(PASSPHRASE);

  // And one it removed is gone here too.
  await elsewhere.clear();
  expect(await signingPassphrase()).toBeNull();
});

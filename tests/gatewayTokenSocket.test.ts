// How a hosted worker's git gets its GitHub token
// (docs/hosted-tenant-isolation.md "Step 3"): the socket the gateway
// listens on for one worker (src/gateway/tokenSocket.ts), the worker's side
// of it (src/server/hostedToken.ts), and git's credential helper between
// them (src/server/git/hostedCredential.ts) — the last with a real git
// against a stand-in GitHub that lets in the one token and nothing else.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git as plainGit, seededOrigin } from "./helpers/fixtures";
import { serveReposWithToken } from "./helpers/gitHttpServer";
import { GithubRefusal } from "../src/gateway/githubApp";
import { asUser, GATEWAY_UID, SYSTEM_PATH } from "../src/gateway/limits";
import { Spawner, userDirs, workerIsolation } from "../src/gateway/spawner";
import { peerUid, serveTokens, type TokenServer } from "../src/gateway/tokenSocket";
import { brokeredContext, HOSTED_CREDENTIAL_HELPER, isAuthFailure, subprocessRun } from "../src/server/git/cli";
import { credentialFor } from "../src/server/git/hostedCredential";
import { getAuth } from "../src/server/auth";
import { clone, commitAndPush, setGitEngine } from "../src/server/git";
import { askGateway, IDENTITY_ENV, repoOfPath, TOKEN_SOCKET_ENV } from "../src/server/hostedToken";
import { createEnvBackend, createFileBackend, setTokenBackend } from "../src/server/tokenStore";

let dir: string;
let path: string;
let server: TokenServer | null = null;
let asked: string[];

beforeEach(async () => {
  // Short: a unix socket's path has some hundred characters at most.
  dir = await mkdtemp(join(tmpdir(), "sdt-"));
  path = join(dir, "gate", "github.sock");
  asked = [];
});

afterEach(async () => {
  server?.close();
  server = null;
  delete process.env[TOKEN_SOCKET_ENV];
  delete process.env.SPECDRIVEN_GITHUB_URL;
  await rm(dir, { recursive: true, force: true });
});

/** Listen as the gateway would for one worker; acme/specs has a token, anything else a refusal. */
async function listen(opts: { uid?: number | null; peer?: (fd: number) => number | null } = {}): Promise<void> {
  server = await serveTokens({
    path,
    uid: opts.uid ?? null,
    peer: opts.peer,
    answer: async (repo) => {
      asked.push(repo);
      if (repo !== "acme/specs") throw new GithubRefusal("not-installed", `The SpecDriven GitHub App is not installed on ${repo}`);
      return { token: "ghs_hour", expiresAt: 1_800_000_000_000, write: true };
    },
  });
}

/** Send raw text to the socket and collect what comes back until it closes. */
function raw(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    let got = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(text));
    socket.on("data", (chunk: string) => (got += chunk));
    socket.on("close", () => resolve(got));
    socket.on("error", reject);
  });
}

test("a worker asks for one repository and gets its token, or the reason there is none", async () => {
  await listen();
  expect(await askGateway(path, "acme/specs")).toEqual({ token: "ghs_hour", expiresAt: 1_800_000_000_000 });
  await expect(askGateway(path, "acme/other")).rejects.toThrow("not installed on acme/other");
  expect(asked).toEqual(["acme/specs", "acme/other"]);
  // The socket is the worker's and the gateway's alone.
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("one request a connection, so what is not a request gets no token and nothing after the first line is read", async () => {
  await listen();
  expect(JSON.parse(await raw("not json\n"))).toEqual({ error: "Not a request" });
  expect(JSON.parse(await raw('{"repo":7}\n'))).toEqual({ error: "Not a request" });
  // A line that never ends is hung up on.
  expect(await raw("x".repeat(5000))).toBe("");
  const two = await raw('{"repo":"acme/specs"}\n{"repo":"acme/other"}\n');
  expect(two.trim().split("\n").length).toBe(1);
  expect(asked).toEqual(["acme/specs"]);
});

test("only the worker's uid is answered, and anyone else on the other end is hung up on unheard", async () => {
  // The kernel's word on who connected, here a stand-in's: first somebody else, then the worker.
  let from = 200_999;
  await listen({ uid: 200_101, peer: () => from });
  await expect(askGateway(path, "acme/specs", 0)).rejects.toThrow("gave no token");
  expect(asked).toEqual([]);
  from = 200_101;
  expect((await askGateway(path, "acme/specs")).token).toBe("ghs_hour");
  // Where the uid cannot be told at all, nobody is answered.
  server!.close();
  await listen({ uid: 200_101, peer: () => null });
  await expect(askGateway(path, "acme/specs", 0)).rejects.toThrow("gave no token");
  // A socket for a worker with a uid lets its group in: the folder decides whose that is.
  expect((await stat(path)).mode & 0o777).toBe(0o660);
});

test("the socket goes with the worker, and one that is not there yet is waited for a moment", async () => {
  await listen();
  server!.close();
  server = null;
  expect(existsSync(path)).toBe(false);
  await expect(askGateway(path, "acme/specs", 0)).rejects.toThrow();
  // A worker's git can ask before its gateway listens: the start of one is the start of the other.
  const early = askGateway(path, "acme/specs");
  await Bun.sleep(150);
  await listen();
  expect((await early).token).toBe("ghs_hour");
});

test("the repository is the first two parts of a url's path", () => {
  expect(repoOfPath("acme/specs.git")).toBe("acme/specs");
  expect(repoOfPath("/acme/specs.git/info/refs")).toBe("acme/specs");
  expect(repoOfPath("acme/specs")).toBe("acme/specs");
  expect(repoOfPath("acme")).toBeNull();
  expect(repoOfPath(undefined)).toBeNull();
});

test("git's helper answers git with the repository's token, and with nothing when there is none to ask for", async () => {
  await listen();
  const env = { [TOKEN_SOCKET_ENV]: path };
  expect(await credentialFor("protocol=https\nhost=github.com\npath=acme/specs.git\n", env)).toBe(
    "username=x-access-token\npassword=ghs_hour\npassword_expiry_utc=1800000000\n",
  );
  // No path (git was not told to send it) or no socket: nothing to say.
  expect(await credentialFor("protocol=https\nhost=github.com\n", env)).toBe("");
  expect(await credentialFor("protocol=https\nhost=github.com\npath=acme/specs.git\n", {})).toBe("");
  await expect(credentialFor("protocol=https\nhost=github.com\npath=acme/other.git\n", env)).rejects.toThrow("not installed");
});

test("a real git clones and pushes with the token its helper fetched, which is nowhere in its environment", async () => {
  // The remote: a bare repository with one commit, behind a GitHub that wants the token.
  const plain = subprocessRun(async () => ({ config: ["-c", "user.name=T", "-c", "user.email=t@example.com"], env: {} }));
  const origin = join(dir, "remote", "acme", "specs.git");
  const seed = join(dir, "seed");
  await mkdir(origin, { recursive: true });
  await plain(null, "init", "--bare", "-b", "main", origin);
  await mkdir(seed);
  await plain(null, "init", "-b", "main", seed);
  await writeFile(join(seed, "a.md"), "one\n");
  await plain(seed, "add", ".");
  await plain(seed, "commit", "-m", "seed");
  await plain(seed, "push", origin, "main");

  const github = serveReposWithToken(join(dir, "remote"), "ghs_hour");
  await listen();
  process.env.SPECDRIVEN_GITHUB_URL = github.url;
  process.env[TOKEN_SOCKET_ENV] = path;
  try {
    const context = brokeredContext("Octo Cat", "octo@example.com");
    expect(context.env).toEqual({});
    expect(JSON.stringify(context)).not.toContain("ghs_hour");
    expect(context.config.join(" ")).toContain(HOSTED_CREDENTIAL_HELPER);
    const git = subprocessRun(async () => context);

    const clone = join(dir, "clone");
    const cloned = await git(null, "clone", `${github.url}/acme/specs.git`, clone);
    expect(cloned.stderr + cloned.stdout).not.toContain("fatal");
    expect(cloned.exitCode).toBe(0);
    expect(await Bun.file(join(clone, "a.md")).text()).toBe("one\n");

    await writeFile(join(clone, "b.md"), "two\n");
    await git(clone, "add", ".");
    expect((await git(clone, "commit", "-m", "second")).exitCode).toBe(0);
    expect((await git(clone, "push", "origin", "main")).exitCode).toBe(0);
    const log = await plain(origin, "log", "--format=%an <%ae> %s", "main");
    expect(log.stdout.trim().split("\n")[0]).toBe("Octo Cat <octo@example.com> second");

    // Git asked for this repository by name, and GitHub saw the token only after asking who was calling.
    expect(new Set(asked)).toEqual(new Set(["acme/specs"]));
    expect(github.seen).toContain("token /acme/specs.git/git-receive-pack");
    expect(github.seen.some((line) => line.startsWith("wrong"))).toBe(false);

    // A repository the gateway has no token for: git fails as it does with no
    // credential, and the reason the gateway gave is in what it printed.
    const refused = await git(null, "clone", `${github.url}/acme/other.git`, join(dir, "other"));
    expect(refused.exitCode).not.toBe(0);
    expect(isAuthFailure(refused.stderr)).toBe(true);
    expect(refused.stderr).toContain("SpecDriven: The SpecDriven GitHub App is not installed on acme/other");
  } finally {
    github.stop();
  }
}, 60_000);

test("the bundled engine asks the gateway the same way, with no git installed", async () => {
  await seededOrigin(join(dir, "remote"), "acme/specs.git");
  const github = serveReposWithToken(join(dir, "remote"), "ghs_hour");
  await listen();
  const realPath = process.env.PATH;
  process.env.SPECDRIVEN_GITHUB_URL = github.url;
  process.env[TOKEN_SOCKET_ENV] = path;
  // What the gateway hands a worker: who the person is on GitHub, and no token.
  setTokenBackend(
    createEnvBackend({ [TOKEN_SOCKET_ENV]: path, [IDENTITY_ENV]: JSON.stringify({ id: 42, login: "octo", name: "Octo Cat", email: "octo@example.com" }) }),
  );
  try {
    expect(await getAuth()).toEqual({ token: "", login: "octo", name: "Octo Cat", email: "octo@example.com", id: 42, brokered: true });
    process.env.PATH = "/nonexistent";
    setGitEngine("js");
    const work = join(dir, "work");
    await clone(`${github.url}/acme/specs.git`, work);
    await Bun.write(join(work, "specs/added.feature.md"), "# Added\n");
    expect(await commitAndPush(work, "specs/added.feature.md", "Add one")).toEqual({ pushed: true, message: "committed and pushed" });
    expect(new Set(asked)).toEqual(new Set(["acme/specs"]));
    expect(github.seen.some((line) => line.startsWith("token /acme/specs.git/git-receive-pack"))).toBe(true);
    expect(github.seen.some((line) => line.startsWith("wrong"))).toBe(false);

    process.env.PATH = realPath;
    const log = await plainGit(join(dir, "remote/acme/specs.git"), "log", "-1", "--pretty=%s %an <%ae>");
    expect(log.stdout.toString().trim()).toBe("Add one Octo Cat <octo@example.com>");
  } finally {
    process.env.PATH = realPath;
    setGitEngine(null);
    setTokenBackend(createFileBackend());
    github.stop();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// With uids of their own (root and setpriv: the hosted image), the folder
// the spawner makes and the kernel's word on who is connecting.

const isolated = workerIsolation();
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_A = 200_111;
const UID_B = 200_112;

test.skipIf(!isolated)("the gateway's uid listens in a folder only that worker can enter, and answers that worker's uid alone", async () => {
  const data = await mkdtemp(join(tmpdir(), "sdk-"));
  await chmod(data, 0o711);
  // A worker that does nothing, started as a real one is: the spawner makes the folders.
  const entry = join(data, "idle.ts");
  await writeFile(entry, "setInterval(() => {}, 1000);\n");
  await chmod(entry, 0o644);
  const spawner = new Spawner({ dataDir: data, entry, gatewayGid: GATEWAY_UID, gatewayUid: GATEWAY_UID, sandbox: false, stdio: "ignore" });
  const dirs = userDirs(data, A);
  let gateway: ReturnType<typeof Bun.spawn> | null = null;
  // Ask through git's own helper, as some uid: what it prints, and how it ended.
  const ask = (uid: number | null) => {
    const res = Bun.spawnSync([...(uid === null ? [] : asUser(uid)), process.execPath, HOSTED_CREDENTIAL_HELPER, "get"], {
      env: { PATH: SYSTEM_PATH, [TOKEN_SOCKET_ENV]: dirs.tokenSocket, HOME: "/tmp" },
      stdin: Buffer.from("protocol=https\nhost=github.com\npath=acme/specs.git\n"),
    });
    return { out: res.stdout.toString(), err: res.stderr.toString() };
  };
  try {
    await spawner.start({ userId: A, uid: UID_A, instance: "one", env: { PATH: SYSTEM_PATH }, limits: { processes: 64, openFiles: 256 }, egressPort: null });
    const gate = await stat(dirs.gate);
    // The gateway's, with the worker's group let through, and what is made in it takes that group.
    expect([gate.uid, gate.gid, gate.mode & 0o7777]).toEqual([GATEWAY_UID, UID_A, 0o2750]);

    gateway = Bun.spawn([...asUser(GATEWAY_UID), process.execPath, join(import.meta.dir, "fixtures", "tokenServer.ts"), dirs.tokenSocket, String(UID_A)], {
      env: { PATH: SYSTEM_PATH, HOME: "/tmp" },
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = gateway.stdout as ReadableStream<Uint8Array>;
    const first = await reader.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("listening");
    const socket = await stat(dirs.tokenSocket);
    expect([socket.uid, socket.gid, socket.mode & 0o777]).toEqual([GATEWAY_UID, UID_A, 0o660]);

    // The worker's own uid: its token.
    expect(ask(UID_A).out).toContain("password=token-for-acme/specs");
    // Another worker's uid cannot so much as reach the socket.
    const other = ask(UID_B);
    expect(other.out).toBe("");
    expect(other.err).toMatch(/EACCES|permission denied/i);
    // Root can open any file, this socket too — and is hung up on, being the wrong uid.
    const root = ask(null);
    expect(root.out).toBe("");
    expect(root.err).toContain("gave no token");
    // The worker cannot put a socket of its own in the folder, or take the gateway's away.
    const meddle = Bun.spawnSync([...asUser(UID_A), "/bin/sh", "-c", `rm -f ${dirs.tokenSocket} || exit 3; touch ${dirs.gate}/x`]);
    expect(meddle.exitCode).not.toBe(0);
    expect(existsSync(dirs.tokenSocket)).toBe(true);
  } finally {
    gateway?.kill("SIGKILL");
    await spawner.stopAll();
    await rm(data, { recursive: true, force: true });
  }
}, 60_000);

test.skipIf(process.platform !== "linux")("the kernel says which uid is on the other end of a socket", async () => {
  await mkdir(join(dir, "gate"));
  const seen: (number | null)[] = [];
  const listener = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        seen.push(peerUid((socket as unknown as { fd: number }).fd));
        socket.end();
      },
      data() {},
    },
  });
  try {
    await raw("");
    expect(seen).toEqual([process.getuid!()]);
  } finally {
    listener.stop(true);
  }
});

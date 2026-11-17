// A hosted worker and the service's GitHub App together
// (docs/hosted-tenant-isolation.md "Step 3", specs/app/hosted-app.feature.md
// "A worker gets a GitHub token for one repository, for an hour"): the real
// app as a worker, started by the pool with no GitHub token of any kind,
// opens a repository on a stand-in GitHub that lets in one token — which
// its git can only have got by asking the gateway, over its own socket.
//
// With uids of their own (root and setpriv: the hosted image) the worker is
// also confined (sandbox.ts), and still reaches the socket it must.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveReposWithToken, type GuardedGitHttpServer } from "./helpers/gitHttpServer";
import { statelessToken } from "./helpers/githubTokens";
import { GithubRefusal } from "../src/gateway/githubApp";
import { SYSTEM_PATH } from "../src/gateway/limits";
import { proxyToWorker } from "../src/gateway/proxy";
import { Spawner } from "../src/gateway/spawner";
import { userDirs, workerEnv, workerIsolation, WorkerPool, type WorkerAddress } from "../src/gateway/workers";
import { subprocessRun } from "../src/server/git/cli";
import { GITHUB_APP_ENV, IDENTITY_ENV, TOKEN_SOCKET_ENV } from "../src/server/hostedToken";
import { TOKEN_ENV } from "../src/server/tokenStore";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_A = 200_121;
const isolated = workerIsolation();
const OCTO = { id: 42, login: "octo", name: "Octo Cat", email: "octo@example.com" };
/** An hour's token, as long as GitHub makes them now. */
const HOUR_TOKEN = statelessToken("hour");
/** The token a person pasted before the app: still stored, and never to reach a worker again. */
const PASTED = { token: "ghp_pasted_months_ago", login: "octo", name: null, email: null, id: 42 };

let dataDir: string;
let remote: string;
let github: GuardedGitHttpServer;
let pool: WorkerPool;
let asked: string[];
let forgotten: string[];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "sdh-"));
  remote = await mkdtemp(join(tmpdir(), "sdr-"));
  // The person's specs repository, on a GitHub that wants the hour's token.
  const plain = subprocessRun(async () => ({ config: ["-c", "user.name=T", "-c", "user.email=t@example.com"], env: {} }));
  const origin = join(remote, "acme", "specs.git");
  const seed = join(remote, "seed");
  await mkdir(origin, { recursive: true });
  await plain(null, "init", "--bare", "-b", "main", origin);
  await mkdir(join(seed, "specs"), { recursive: true });
  await plain(null, "init", "-b", "main", seed);
  await writeFile(join(seed, "specs", "one.feature.md"), "# One\n");
  await plain(seed, "add", ".");
  await plain(seed, "commit", "-m", "seed");
  await plain(seed, "push", origin, "main");
  github = serveReposWithToken(remote, HOUR_TOKEN);

  asked = [];
  forgotten = [];
  const entry = join(import.meta.dir, "..", "src", "index.ts");
  pool = new WorkerPool({
    dataDir,
    entry,
    idleMs: 60_000,
    secrets: async () => ({ github: PASTED }),
    emailOf: () => "a@example.com",
    osUid: isolated ? () => UID_A : undefined,
    spawner: isolated ? new Spawner({ dataDir, entry, stdio: "ignore" }) : undefined,
    // A confined worker reads the system's own git: the tests' PATH is a folder it may not enter.
    baseEnv: { ...process.env, PATH: isolated ? SYSTEM_PATH : process.env.PATH, SPECDRIVEN_GITHUB_URL: github.url },
    github: {
      identity: (userId) => (userId === A ? OCTO : null),
      tokenFor: async (userId, repo) => {
        asked.push(`${userId} ${repo}`);
        if (repo !== "acme/specs") throw new GithubRefusal("not-installed", `The SpecDriven GitHub App is not installed on ${repo}`);
        return { token: HOUR_TOKEN, expiresAt: Date.now() + 3_600_000, write: true };
      },
      forget: (userId) => void forgotten.push(userId),
    },
    stdio: "ignore",
  });
});

afterAll(async () => {
  await pool.stopAll();
  github.stop();
  await rm(dataDir, { recursive: true, force: true });
  await rm(remote, { recursive: true, force: true });
});

function api(worker: WorkerAddress, method: string, path: string, body?: unknown) {
  return proxyToWorker(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    worker,
    { secure: false },
  );
}

test("with the service's app, a worker is told who the person is on GitHub and where to ask, and holds no token", () => {
  const dirs = userDirs("/data", A);
  const secrets = { github: PASTED };
  const connected = workerEnv(dirs, secrets, { PATH: "/bin" }, null, [], { github: { identity: OCTO } });
  expect(connected[GITHUB_APP_ENV]).toBe("1");
  expect(JSON.parse(connected[IDENTITY_ENV]!)).toEqual(OCTO);
  expect(connected[TOKEN_SOCKET_ENV]).toBe(`/data/users/${A}/gate/github.sock`);
  // The pasted token is not handed over once the account is connected.
  expect(connected[TOKEN_ENV]).toBeUndefined();
  expect(JSON.stringify(connected)).not.toContain("ghp_");

  // Not connected yet: the token from before still works, and the worker knows the app is the way.
  const before = workerEnv(dirs, secrets, { PATH: "/bin" }, null, [], { github: { identity: null } });
  expect(before[GITHUB_APP_ENV]).toBe("1");
  expect(JSON.parse(before[TOKEN_ENV]!).token).toBe("ghp_pasted_months_ago");
  expect(before[TOKEN_SOCKET_ENV]).toBeUndefined();

  // A service without the app is as it was.
  const plain = workerEnv(dirs, secrets, { PATH: "/bin" });
  expect(plain[GITHUB_APP_ENV]).toBeUndefined();
  expect(JSON.parse(plain[TOKEN_ENV]!).token).toBe("ghp_pasted_months_ago");
});

test("a worker's git opens the repository with a token it asked the gateway for, and the token ends with the worker", async () => {
  const worker = await pool.workerFor(A);
  const dirs = userDirs(dataDir, A);
  expect(existsSync(dirs.tokenSocket)).toBe(true);
  if (isolated) {
    const gate = await stat(dirs.gate);
    expect([gate.uid, gate.gid, gate.mode & 0o7777]).toEqual([0, UID_A, 0o2750]);
    const socket = await stat(dirs.tokenSocket);
    expect([socket.gid, socket.mode & 0o777]).toEqual([UID_A, 0o660]);
  }

  const state = (await (await api(worker, "GET", "/api/state")).json()) as { auth: Record<string, unknown>; hostedGithubApp: boolean };
  expect(state.hostedGithubApp).toBe(true);
  expect(state.auth).toMatchObject({ signedIn: true, login: "octo", name: "Octo Cat" });

  // A repository the app is not installed on: no token, and the app says what to do about it.
  const refused = await api(worker, "PUT", "/api/state", { dataRepo: "https://github.com/acme/elsewhere" });
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(await refused.text()).toContain("install the SpecDriven app on this repository");

  const opened = await api(worker, "PUT", "/api/state", { dataRepo: "https://github.com/acme/specs" });
  expect(await opened.text()).not.toContain("error");
  expect(opened.status).toBe(200);
  expect(await readFile(join(dirs.repos, "specs", "specs", "one.feature.md"), "utf8")).toBe("# One\n");

  // Each repository was asked for by name, by this person's worker.
  expect(new Set(asked)).toEqual(new Set([`${A} acme/elsewhere`, `${A} acme/specs`]));
  expect(github.seen.some((line) => line.startsWith("token /acme/specs.git/"))).toBe(true);
  // The token from before the app was never offered to GitHub.
  expect(github.seen.some((line) => line.startsWith("wrong"))).toBe(false);

  await pool.stop(A);
  expect(existsSync(dirs.tokenSocket)).toBe(false);
  expect(forgotten).toEqual([A]);
}, 120_000);

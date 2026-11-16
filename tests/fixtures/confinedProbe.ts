// Stands in for the app as a worker's program (tests/gatewayWorkers.test.ts
// "a worker is confined…"): started by the spawner exactly as a worker is,
// it tries what a worker someone has taken over would try, writes down what
// happened in its own folder, and then serves its socket like any worker.

import { writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";

const env = process.env;

async function succeeds(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch {
    return false;
  }
}

function connects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// What to try, left by the test in the folder that is this worker's own.
const config = (await Bun.file(join(env.SPECDRIVEN_ROOT!, "probe-config.json")).json()) as {
  outside: string;
  proxyPort: number;
  otherPort: number;
  /** A host the proxy lets through, and one it does not. */
  allowedUrl: string;
  refusedUrl: string;
};

/** The status a request gets, going wherever this worker's environment sends it; 0 when it gets none. */
const statusOf = (url: string) =>
  fetch(url).then(
    (res) => res.status,
    () => 0,
  );

/** git's exit code for a look at a repository there; -1 when git could not be started. */
async function gitReaches(url: string): Promise<number> {
  try {
    const git = Bun.spawn(["git", "ls-remote", `${url}/acme/specs.git`], { stdout: "ignore", stderr: "ignore" });
    return await git.exited;
  } catch {
    return -1;
  }
}

const facts = {
  uid: process.getuid?.(),
  // A file anyone on the machine may read, outside this worker's folders.
  readsOutside: await succeeds(() => Bun.file(config.outside).text()),
  writesTmp: await succeeds(() => writeFile(`/tmp/planted-${process.pid}`, "x")),
  writesOwn: await succeeds(() => writeFile(join(env.TMPDIR!, "mine"), "x")),
  reachesProxy: await connects(config.proxyPort),
  reachesOther: await connects(config.otherPort),
  // The app's own requests, and git's, go where HTTPS_PROXY points.
  fetchAllowed: await statusOf(`${config.allowedUrl}/from-fetch`),
  fetchRefused: await statusOf(`${config.refusedUrl}/from-fetch`),
  gitAllowed: await gitReaches(config.allowedUrl),
  gitRefused: await gitReaches(config.refusedUrl),
  proxyEnv: env.HTTPS_PROXY ?? null,
  hasKey: Boolean(env.SPECDRIVEN_WORKER_KEY),
  inheritedPath: env.PATH ?? null,
  // What the spawner's own tools ran with must not be this program's.
  launcherEnv: env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? null,
};
await writeFile(join(env.SPECDRIVEN_ROOT!, "probe.json"), JSON.stringify(facts));

Bun.serve({ unix: env.SPECDRIVEN_UNIX_SOCKET!, fetch: () => new Response("probe") });

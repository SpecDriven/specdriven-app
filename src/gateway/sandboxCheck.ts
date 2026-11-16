// Tries the workers' confinement on this machine and says what held
// (docs/hosted-tenant-isolation.md "Check Railway first"). Whether a
// platform's kernel has Landlock, and with TCP rules, cannot be read from
// its documentation: this starts a throwaway process through the same
// launcher a worker starts through (launcher.ts), under the same kind of
// plan, and has it try what a worker must be able to do and what it must
// not.
//
//   bun src/gateway/index.ts probe     prints the result
//
// The spawner runs it at every start, as an unprivileged uid, and logs the
// line: the first deploy answers the question.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeSandbox, type SandboxResult } from "./launcher";
import { sandboxSpec, type LaunchSpec } from "./sandbox";

/** What the process inside found: each thing it tried, and whether it went as a confined worker's should. */
export interface SandboxCheck {
  applied: SandboxResult;
  /** A file in its own folder is written. */
  ownWrite: boolean;
  /** A program and a system file are read. */
  systemRead: boolean;
  /** A file outside its folders is not read, and none is made there. */
  outsideRead: boolean;
  outsideWrite: boolean;
  /** The proxy's port answers; another local port does not; no UDP socket is made. */
  proxyConnect: boolean;
  otherConnect: boolean;
  udp: boolean;
  /** A child process starts (git is one). */
  child: boolean;
}

const INSIDE = "--inside";

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

async function succeeds(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch {
    return false;
  }
}

/** Inside the confined process: try each thing and print what happened. */
async function inside(own: string, outside: string, proxyPort: number, otherPort: number): Promise<void> {
  const { createSocket } = await import("node:dgram");
  const facts = {
    ownWrite: await succeeds(() => writeFile(join(own, "mine.txt"), "mine")),
    systemRead: await succeeds(() => Bun.file("/etc/passwd").text()),
    outsideRead: await succeeds(() => Bun.file(join(outside, "theirs.txt")).text()),
    outsideWrite: await succeeds(() => writeFile(join(outside, "planted.txt"), "planted")),
    proxyConnect: await connects(proxyPort),
    otherConnect: await connects(otherPort),
    udp: await succeeds(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = createSocket("udp4");
          socket.once("error", reject);
          socket.bind(0, "127.0.0.1", () => {
            socket.close();
            resolve();
          });
        }),
    ),
    child: await succeeds(async () => {
      const proc = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
      if ((await proc.exited) !== 0) throw new Error("did not run");
    }),
  };
  console.log(JSON.stringify(facts));
}

/** Start a process under a worker's kind of plan and report what held. */
export async function checkSandbox(): Promise<SandboxCheck> {
  const base = await mkdtemp(join(tmpdir(), "sd-sandbox-check-"));
  const own = join(base, "own");
  const outside = join(base, "outside");
  const listeners = [net.createServer((s) => s.destroy()), net.createServer((s) => s.destroy())];
  try {
    await writeFile(join(base, "placeholder"), "");
    for (const dir of [own, outside]) await Bun.write(join(dir, "theirs.txt"), "theirs");
    const [proxyPort, otherPort] = await Promise.all(
      listeners.map(
        (server) =>
          new Promise<number>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
          }),
      ),
    );
    const here = import.meta.path;
    const spec: LaunchSpec = {
      argv: [process.execPath, here, INSIDE, own, outside, String(proxyPort), String(otherPort)],
      cwd: own,
      env: { PATH: process.env.PATH ?? "", HOME: own, TMPDIR: own, SPECDRIVEN_DEBUG: "1" },
      sandbox: sandboxSpec({
        own: [own],
        code: [dirname(dirname(dirname(here))), dirname(process.execPath)],
        connectPort: proxyPort!,
      }),
    };
    const proc = Bun.spawn([process.execPath, join(dirname(here), "launcher.ts"), "--report"], {
      env: { PATH: process.env.PATH ?? "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify(spec));
    await proc.stdin.end();
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const lines = out.trim().split("\n").filter(Boolean);
    if (code !== 0 || lines.length < 2) {
      throw new Error(`the confined process did not run (exit ${code}): ${(err || out).trim().slice(0, 500)}`);
    }
    return { applied: JSON.parse(lines[0]!) as SandboxResult, ...(JSON.parse(lines.at(-1)!) as Omit<SandboxCheck, "applied">) };
  } finally {
    for (const server of listeners) server.close();
    await rm(base, { recursive: true, force: true });
  }
}

/** What in a check is not as a confined worker's should be; empty when all of it is. */
export function sandboxFailures(check: SandboxCheck): string[] {
  const wrong: string[] = [];
  if (!check.ownWrite) wrong.push("it could not write in its own folder");
  if (!check.systemRead) wrong.push("it could not read the system's files");
  if (!check.child) wrong.push("it could not start a process");
  if (!check.proxyConnect) wrong.push("it could not reach the proxy's port");
  if (check.applied.files && (check.outsideRead || check.outsideWrite)) wrong.push("it reached a file outside its folders");
  if (check.applied.network && check.otherConnect) wrong.push("it connected to a port that is not the proxy's");
  if (check.applied.seccomp && check.udp) wrong.push("it made a UDP socket");
  return wrong;
}

/** One line for the log. */
export function describeCheck(check: SandboxCheck): string {
  const wrong = sandboxFailures(check);
  return `${describeSandbox(check.applied)} — ${wrong.length ? `BROKEN: ${wrong.join("; ")}` : "tried, and it holds"}`;
}

if (import.meta.main) {
  const [mode, own, outside, proxyPort, otherPort] = process.argv.slice(2);
  if (mode === INSIDE) {
    await inside(own!, outside!, Number(proxyPort), Number(otherPort));
  } else {
    try {
      const check = await checkSandbox();
      console.log(mode === "--json" ? JSON.stringify(check) : describeCheck(check));
      process.exit(sandboxFailures(check).length ? 1 : 0);
    } catch (e) {
      console.log(`the workers' confinement could not be tried: ${(e as Error).message}`);
      process.exit(1);
    }
  }
}

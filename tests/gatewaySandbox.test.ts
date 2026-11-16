// specs/app/hosted-app.feature.md "A worker is confined to its own folder
// and one way out": the plan the launcher holds a worker to
// (src/gateway/sandbox.ts) and the launcher itself (src/gateway/launcher.ts).
// The plan is plain data and is tested everywhere; applying it takes a Linux
// kernel, so that part runs in the hosted image and is skipped elsewhere.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { applySandbox, describeSandbox, probeSandbox } from "../src/gateway/launcher";
import {
  handledFsRights,
  INSPECTED,
  LANDLOCK,
  pathRights,
  rulesetAttr,
  sandboxSpec,
  SECCOMP_ARCH,
  seccompFilter,
  seccompVerdict,
  SYSCALLS,
  type SeccompArch,
} from "../src/gateway/sandbox";
import { checkSandbox, describeCheck, sandboxFailures, type SandboxCheck } from "../src/gateway/sandboxCheck";
import { DEFAULT_SPAWNER_SOCKET, workerSandbox } from "../src/gateway/spawnerMain";

const LAUNCHER = join(import.meta.dir, "..", "src", "gateway", "launcher.ts");
const EPERM = 1;
const ENOSYS = 38;
const ARCHES: SeccompArch[] = ["x64", "arm64"];
/** read, write, openat, execve, connect, bind: what any program makes all day. */
const EVERYDAY: Record<SeccompArch, number[]> = { x64: [0, 1, 257, 59, 42, 49], arm64: [63, 64, 56, 221, 203, 200] };

test("a worker's plan gives it its own folders, the system and the app's code to read, and one port", () => {
  const spec = sandboxSpec({ own: ["/data/users/u/home", "/data/users/u/tmp"], code: ["/app", "/usr/local/bin"], connectPort: 4100 });
  expect(spec.readWrite).toEqual(["/data/users/u/home", "/data/users/u/tmp"]);
  expect(spec.readOnly).toContain("/app");
  expect(spec.readOnly).toContain("/usr");
  expect(spec.readOnly).toContain("/etc");
  // Not the shared temp folder, the volume, or anyone's home.
  for (const path of ["/tmp", "/data", "/root", "/home", "/"]) {
    expect([...spec.readOnly, ...spec.readWrite, ...spec.devices]).not.toContain(path);
  }
  expect(spec.devices).toContain("/dev/null");
  expect(spec.connectPort).toBe(4100);
});

test("the file rights follow the kernel's Landlock version, and the code is never writable", () => {
  expect(handledFsRights(1)).toBe(0x1fff);
  expect(handledFsRights(2)).toBe(0x3fff);
  expect(handledFsRights(3)).toBe(0x7fff);
  expect(handledFsRights(5)).toBe(0xffff);
  const WRITE_FILE = 1 << 1;
  const MAKE_REG = 1 << 8;
  const REMOVE_FILE = 1 << 5;
  for (const abi of [1, 3, 6]) {
    const code = pathRights("readOnly", true, abi);
    expect(code & (WRITE_FILE | MAKE_REG | REMOVE_FILE)).toBe(0);
    // read file, read dir, execute
    expect(code).toBe(0b1101);
    const own = pathRights("readWrite", true, abi);
    expect(own & (WRITE_FILE | MAKE_REG | REMOVE_FILE)).toBe(WRITE_FILE | MAKE_REG | REMOVE_FILE);
    // No device files, in its own folders either.
    expect(own & ((1 << 6) | (1 << 11))).toBe(0);
    // Every right a rule names is one this version handles, or the kernel refuses the rule.
    for (const rights of [code, own, pathRights("device", false, abi)]) expect(rights & ~handledFsRights(abi)).toBe(0);
  }
  // A rule on a file names file rights only.
  expect(pathRights("device", false, 1)).toBe(0b110);
  expect(pathRights("readOnly", false, 6)).toBe(0b101);
});

test("TCP is confined from Landlock 4, and only when there is a port to allow", () => {
  expect(rulesetAttr(3, true)).toMatchObject({ size: 8, net: 0, scoped: 0 });
  expect(rulesetAttr(4, true)).toMatchObject({ size: 16, net: 3, scoped: 0 });
  expect(rulesetAttr(4, false)).toMatchObject({ size: 16, net: 0 });
  expect(rulesetAttr(6, true)).toMatchObject({ size: 24, net: 3, scoped: 3 });
});

test.each(ARCHES)("the %s system-call filter lets a program's everyday calls through", (arch) => {
  const filter = seccompFilter(arch, true);
  for (const nr of EVERYDAY[arch]) expect(seccompVerdict(filter, { arch: SECCOMP_ARCH[arch], nr })).toBe("allow");
  // seccomp and prctl themselves: a child may narrow itself further.
  expect(seccompVerdict(filter, { arch: SECCOMP_ARCH[arch], nr: INSPECTED[arch].prctl })).toBe("allow");
});

test.each(ARCHES)("the %s filter refuses the calls that reach other processes, mounts, namespaces and the kernel", (arch) => {
  const filter = seccompFilter(arch, true);
  const names = Object.keys(SYSCALLS[arch]);
  for (const name of ["ptrace", "process_vm_readv", "mount", "unshare", "setns", "bpf", "init_module", "keyctl", "open_by_handle_at", "io_uring_setup"]) {
    expect(names).toContain(name);
  }
  for (const [name, nr] of Object.entries(SYSCALLS[arch])) {
    expect([name, seccompVerdict(filter, { arch: SECCOMP_ARCH[arch], nr })]).toEqual([name, EPERM]);
  }
  // No number is listed twice, and none is one of the calls looked into.
  expect(new Set(Object.values(SYSCALLS[arch])).size).toBe(names.length);
  for (const nr of Object.values(INSPECTED[arch])) expect(Object.values(SYSCALLS[arch])).not.toContain(nr);
});

test.each(ARCHES)("the %s filter lets a thread or a child be made, never a namespace", (arch) => {
  const filter = seccompFilter(arch, true);
  const call = (nr: number, args: number[]) => seccompVerdict(filter, { arch: SECCOMP_ARCH[arch], nr, args });
  const { clone, clone3 } = INSPECTED[arch];
  const SIGCHLD = 17;
  const THREAD = 0x3d0f00; // what pthread_create asks for
  expect(call(clone, [SIGCHLD])).toBe("allow");
  expect(call(clone, [THREAD])).toBe("allow");
  for (const namespace of [0x10000000, 0x40000000, 0x00020000, 0x20000000]) {
    expect(call(clone, [namespace | SIGCHLD])).toBe(EPERM);
  }
  // clone3's flags are behind a pointer: "no such call", and the C library uses clone.
  expect(call(clone3, [0])).toBe(ENOSYS);
});

test.each(ARCHES)("the %s filter leaves a worker unix sockets and TCP, and no other kind", (arch) => {
  const filter = seccompFilter(arch, true);
  const socket = (domain: number, type: number) =>
    seccompVerdict(filter, { arch: SECCOMP_ARCH[arch], nr: INSPECTED[arch].socket, args: [domain, type] });
  const [UNIX, INET, INET6, NETLINK, PACKET] = [1, 2, 10, 16, 17];
  const [STREAM, DGRAM, RAW] = [1, 2, 3];
  const CLOEXEC_NONBLOCK = 0x80000 | 0x800;
  expect(socket(UNIX, STREAM)).toBe("allow");
  expect(socket(UNIX, DGRAM | CLOEXEC_NONBLOCK)).toBe("allow");
  expect(socket(INET, STREAM | CLOEXEC_NONBLOCK)).toBe("allow");
  expect(socket(INET6, STREAM)).toBe("allow");
  // UDP would leave past the one TCP port Landlock allows.
  expect(socket(INET, DGRAM)).toBe(EPERM);
  expect(socket(INET6, DGRAM | CLOEXEC_NONBLOCK)).toBe(EPERM);
  expect(socket(INET, RAW)).toBe(EPERM);
  // A stream socket of another protocol (MPTCP, SCTP) is not the TCP that
  // Landlock's port rule holds, and would go anywhere.
  const stream = (protocol: number) =>
    seccompVerdict(filter, { arch: SECCOMP_ARCH[arch], nr: INSPECTED[arch].socket, args: [INET, STREAM | CLOEXEC_NONBLOCK, protocol] });
  const [TCP, MPTCP, SCTP] = [6, 262, 132];
  expect(stream(0)).toBe("allow");
  expect(stream(TCP)).toBe("allow");
  expect(stream(MPTCP)).toBe(EPERM);
  expect(stream(SCTP)).toBe(EPERM);
  expect(seccompVerdict(filter, { arch: SECCOMP_ARCH[arch], nr: INSPECTED[arch].socket, args: [INET6, STREAM, MPTCP] })).toBe(EPERM);
  expect(socket(NETLINK, RAW)).toBe(EPERM);
  expect(socket(PACKET, RAW)).toBe(EPERM);

  // With no proxy to go through, the network is left as it is.
  const open = seccompFilter(arch, false);
  expect(seccompVerdict(open, { arch: SECCOMP_ARCH[arch], nr: INSPECTED[arch].socket, args: [INET, DGRAM] })).toBe("allow");
  expect(seccompVerdict(open, { arch: SECCOMP_ARCH[arch], nr: SYSCALLS[arch].ptrace! })).toBe(EPERM);
});

test("a call made as another architecture ends the process, and x86-64's second numbering is refused", () => {
  const x64 = seccompFilter("x64", true);
  const arm64 = seccompFilter("arm64", true);
  const I386 = 0x40000003;
  expect(seccompVerdict(x64, { arch: I386, nr: 0 })).toBe("kill");
  expect(seccompVerdict(x64, { arch: SECCOMP_ARCH.arm64, nr: 0 })).toBe("kill");
  expect(seccompVerdict(arm64, { arch: SECCOMP_ARCH.x64, nr: 63 })).toBe("kill");
  // x32: the same calls, numbered from 2^30, that the list above would miss.
  expect(seccompVerdict(x64, { arch: SECCOMP_ARCH.x64, nr: 0x40000000 + 101 })).toBe(EPERM);
});

test("the launcher becomes the program it is told to, in its folder and with its environment alone", async () => {
  const spec = {
    argv: [process.execPath, "-e", "console.log(JSON.stringify({ env: process.env, cwd: process.cwd() }))"],
    cwd: import.meta.dir,
    env: { ONLY: "this" },
    sandbox: null,
  };
  const proc = Bun.spawn([process.execPath, LAUNCHER], {
    env: { PATH: process.env.PATH ?? "", LEFT_BEHIND: "the launcher's own" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(spec));
  await proc.stdin.end();
  expect(await proc.exited).toBe(0);
  const seen = JSON.parse(await new Response(proc.stdout).text()) as { env: Record<string, string>; cwd: string };
  expect(seen.cwd).toBe(import.meta.dir);
  expect(seen.env.ONLY).toBe("this");
  expect(seen.env.LEFT_BEHIND).toBeUndefined();
});

test("what holds a worker is said in one line, and so is what does not", () => {
  const applied = { kernel: "6.8.0", landlock: 4, files: true, network: true, seccomp: true, notes: [] };
  const good: SandboxCheck = {
    applied,
    ownWrite: true,
    systemRead: true,
    outsideRead: false,
    outsideWrite: false,
    proxyConnect: true,
    otherConnect: false,
    udp: false,
    child: true,
  };
  expect(sandboxFailures(good)).toEqual([]);
  expect(describeCheck(good)).toContain("Landlock 4");
  expect(describeCheck(good)).toContain("it holds");
  expect(sandboxFailures({ ...good, outsideRead: true, otherConnect: true, udp: true })).toHaveLength(3);
  expect(sandboxFailures({ ...good, ownWrite: false, child: false })).toHaveLength(2);
  // A kernel without Landlock confines nothing, and that is not a failure of the worker.
  const none = { ...applied, landlock: 0, files: false, network: false, notes: ["no Landlock: files are kept apart by the uid alone"] };
  expect(sandboxFailures({ ...good, applied: none, outsideRead: true, otherConnect: true })).toEqual([]);
  expect(describeSandbox(none)).toContain("Landlock absent");
  expect(describeSandbox(none)).toContain("by the uid alone");
});

test("asking what this kernel offers changes nothing, and the answer names what is missing", async () => {
  const offered = await probeSandbox();
  expect(offered.kernel.length).toBeGreaterThan(0);
  if (process.platform === "linux") {
    expect(offered.seccomp).toBe(true);
    expect(offered.files).toBe(offered.landlock >= 1);
    expect(offered.network).toBe(offered.landlock >= 4);
  } else {
    expect(offered).toMatchObject({ landlock: 0, files: false, network: false, seccomp: false });
    expect(offered.notes.join(" ")).toContain("neither Landlock nor seccomp");
  }
  // Asking is not applying: this process can still do what a confined one cannot.
  expect(await Bun.file(import.meta.path).exists()).toBe(true);
  // The kernel's own numbers for Landlock, the same on every architecture.
  expect([LANDLOCK.createRuleset, LANDLOCK.addRule, LANDLOCK.restrictSelf]).toEqual([444, 445, 446]);
  expect([LANDLOCK.rulePathBeneath, LANDLOCK.ruleNetPort]).toEqual([1, 2]);
});

// On Linux applying the plan confines whoever asks, for good: there it is
// tried in a throwaway process (below), never in the tests' own.
test.skipIf(process.platform === "linux")("where the system has no way to confine a worker, nothing is applied and that is said", async () => {
  const result = await applySandbox(sandboxSpec({ own: ["/nowhere"], code: ["/app"], connectPort: 4100 }));
  expect(result).toMatchObject({ landlock: 0, files: false, network: false, seccomp: false });
  expect(result.notes).toHaveLength(1);
});

test("the confinement is on unless the service is told otherwise", () => {
  expect(workerSandbox({})).toBe(true);
  expect(workerSandbox({ SPECDRIVEN_WORKER_SANDBOX: "on" })).toBe(true);
  expect(workerSandbox({ SPECDRIVEN_WORKER_SANDBOX: "off" })).toBe(false);
  // The socket the gateway asks root over is in a folder made at each start, not on the volume.
  expect(DEFAULT_SPAWNER_SOCKET).toStartWith("/run/");
});

// Applying the plan takes Linux; the hosted image's tests run here.
test.skipIf(process.platform !== "linux")("on this kernel, a confined process keeps to its folder and its one port", async () => {
  const check = await checkSandbox();
  expect(sandboxFailures(check)).toEqual([]);
  expect(check.applied.seccomp).toBe(true);
  expect(check.udp).toBe(false);
  expect(check.ownWrite && check.systemRead && check.child && check.proxyConnect).toBe(true);
  if (check.applied.files) expect(check.outsideRead || check.outsideWrite).toBe(false);
  if (check.applied.network) expect(check.otherConnect).toBe(false);
}, 30_000);

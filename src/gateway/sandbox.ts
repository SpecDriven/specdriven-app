// What confines a hosted worker beyond its uid
// (docs/hosted-tenant-isolation.md "Step 2", specs/app/hosted-app.feature.md
// "A worker is confined to its own folder and one way out"). Linux lets a
// process narrow itself, for good, without being root:
//
//   - Landlock limits the files it may open and the TCP ports it may use;
//   - seccomp limits the system calls it may make.
//
// The launcher (launcher.ts) applies both to itself and then becomes the
// worker, so the worker and everything it starts are held to them. This
// file is the plan, with no system call in it: which paths, which rights,
// which calls. It is kept apart so it can be tested anywhere.
//
// What a kernel does not offer is left out rather than refused: Landlock
// came in Linux 5.13 and its TCP rules in 6.7, and the launcher says which
// it found. The uid of its own still holds either way.

/** What the spawner hands the launcher on its input (spawner.ts). */
export interface LaunchSpec {
  /** The program to become, and its arguments. */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** How to confine it first; null starts it as it is. */
  sandbox: SandboxSpec | null;
}

export interface SandboxSpec {
  /** Read and run, never change: the system's folders and the app's code. */
  readOnly: string[];
  /** Device files it may read and write. */
  devices: string[];
  /** Its own folders: everything. */
  readWrite: string[];
  /**
   * The one TCP port it may connect to, the gateway's outbound proxy
   * (egress.ts); it may listen on none. Null leaves its network alone.
   */
  connectPort: number | null;
}

/** The system's folders a Bun server and git read: programs, libraries, certificates, /proc and /sys. */
const SYSTEM_READ = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/sys"];
const DEVICES = ["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom"];

/** The plan for one worker: its own folders, the code it runs, and its one port. */
export function sandboxSpec(opts: { own: string[]; code: string[]; connectPort: number | null }): SandboxSpec {
  return {
    readOnly: [...new Set([...SYSTEM_READ, ...opts.code])],
    devices: DEVICES,
    readWrite: opts.own,
    connectPort: opts.connectPort,
  };
}

// ---------------------------------------------------------------------------
// Landlock (include/uapi/linux/landlock.h).

export const LANDLOCK = {
  /** System call numbers, the same on every architecture. */
  createRuleset: 444,
  addRule: 445,
  restrictSelf: 446,
  /** landlock_create_ruleset's flag that asks for the version instead. */
  version: 1,
  rulePathBeneath: 1,
  ruleNetPort: 2,
  netBindTcp: 1,
  netConnectTcp: 2,
  scopeAbstractUnixSocket: 1,
  scopeSignal: 2,
} as const;

const FS = {
  execute: 1 << 0,
  writeFile: 1 << 1,
  readFile: 1 << 2,
  readDir: 1 << 3,
  removeDir: 1 << 4,
  removeFile: 1 << 5,
  makeChar: 1 << 6,
  makeDir: 1 << 7,
  makeReg: 1 << 8,
  makeSock: 1 << 9,
  makeFifo: 1 << 10,
  makeBlock: 1 << 11,
  makeSym: 1 << 12,
  /** Since version 2. */
  refer: 1 << 13,
  /** Since version 3. */
  truncate: 1 << 14,
  /** Since version 5. */
  ioctlDev: 1 << 15,
} as const;

/** Every file right the kernel's Landlock version knows: all of them are denied unless a rule gives them. */
export function handledFsRights(abi: number): number {
  let rights = (1 << 13) - 1;
  if (abi >= 2) rights |= FS.refer;
  if (abi >= 3) rights |= FS.truncate;
  if (abi >= 5) rights |= FS.ioctlDev;
  return rights;
}

/** The rights that mean anything on a file that is not a folder; the kernel refuses a rule that names others. */
const FILE_RIGHTS = FS.execute | FS.writeFile | FS.readFile | FS.truncate | FS.ioctlDev;

export type PathKind = "readOnly" | "device" | "readWrite";

/** The rights a rule of this kind gives on a path, for this Landlock version. */
export function pathRights(kind: PathKind, isDirectory: boolean, abi: number): number {
  const handled = handledFsRights(abi);
  const wanted =
    kind === "readOnly"
      ? FS.execute | FS.readFile | FS.readDir
      : kind === "device"
        ? FS.readFile | FS.writeFile | FS.truncate | FS.ioctlDev
        : // Its own folders: everything but making device files.
          handled & ~(FS.makeChar | FS.makeBlock);
  return wanted & handled & (isDirectory ? ~0 : FILE_RIGHTS);
}

/**
 * The size and fields of landlock_ruleset_attr for this version: file
 * rights always, TCP from version 4 and only with a port to allow, and from
 * version 6 no signal to, and no abstract socket of, a process outside.
 */
export function rulesetAttr(abi: number, restrictNet: boolean): { size: number; fs: number; net: number; scoped: number } {
  const net = abi >= 4 && restrictNet ? LANDLOCK.netBindTcp | LANDLOCK.netConnectTcp : 0;
  const scoped = abi >= 6 ? LANDLOCK.scopeAbstractUnixSocket | LANDLOCK.scopeSignal : 0;
  return { size: abi >= 6 ? 24 : abi >= 4 ? 16 : 8, fs: handledFsRights(abi), net, scoped };
}

// ---------------------------------------------------------------------------
// seccomp: a short list of calls a Bun server and git never make, refused.
// It is a list of what is refused, not of what is allowed: an allow-list
// that misses one call the runtime makes on some path stops every worker.

export type SeccompArch = "x64" | "arm64";

const AUDIT_ARCH: Record<SeccompArch, number> = { x64: 0xc000003e, arm64: 0xc00000b7 };

/** The numbers of the refused calls on each architecture (asm/unistd_64.h, asm-generic/unistd.h). */
export const SYSCALLS: Record<SeccompArch, Record<string, number>> = {
  x64: {
    // Other processes' memory.
    ptrace: 101,
    process_vm_readv: 310,
    process_vm_writev: 311,
    kcmp: 312,
    // Mounts and roots.
    mount: 165,
    umount2: 166,
    pivot_root: 155,
    chroot: 161,
    open_tree: 428,
    move_mount: 429,
    fsopen: 430,
    fsconfig: 431,
    fsmount: 432,
    fspick: 433,
    mount_setattr: 442,
    // Namespaces: a new one is where most kernel privilege bugs start.
    unshare: 272,
    setns: 308,
    // The kernel itself.
    reboot: 169,
    kexec_load: 246,
    kexec_file_load: 320,
    init_module: 175,
    finit_module: 313,
    delete_module: 176,
    bpf: 321,
    perf_event_open: 298,
    userfaultfd: 323,
    swapon: 167,
    swapoff: 168,
    acct: 163,
    quotactl: 179,
    syslog: 103,
    iopl: 172,
    ioperm: 173,
    modify_ldt: 154,
    // The clock.
    settimeofday: 164,
    clock_settime: 227,
    adjtimex: 159,
    clock_adjtime: 305,
    // The kernel's key store, shared by every process of the container.
    add_key: 248,
    request_key: 249,
    keyctl: 250,
    // Files by handle, past any path rule.
    name_to_handle_at: 303,
    open_by_handle_at: 304,
    // io_uring does its work outside the calls a filter sees.
    io_uring_setup: 425,
    io_uring_enter: 426,
    io_uring_register: 427,
  },
  arm64: {
    ptrace: 117,
    process_vm_readv: 270,
    process_vm_writev: 271,
    kcmp: 272,
    mount: 40,
    umount2: 39,
    pivot_root: 41,
    chroot: 51,
    open_tree: 428,
    move_mount: 429,
    fsopen: 430,
    fsconfig: 431,
    fsmount: 432,
    fspick: 433,
    mount_setattr: 442,
    unshare: 97,
    setns: 268,
    reboot: 142,
    kexec_load: 104,
    kexec_file_load: 294,
    init_module: 105,
    finit_module: 273,
    delete_module: 106,
    bpf: 280,
    perf_event_open: 241,
    userfaultfd: 282,
    swapon: 224,
    swapoff: 225,
    acct: 89,
    quotactl: 60,
    syslog: 116,
    settimeofday: 170,
    clock_settime: 112,
    adjtimex: 171,
    clock_adjtime: 266,
    add_key: 217,
    request_key: 218,
    keyctl: 219,
    name_to_handle_at: 264,
    open_by_handle_at: 265,
    io_uring_setup: 425,
    io_uring_enter: 426,
    io_uring_register: 427,
  },
};

/** Calls the filter looks into rather than refuses outright. */
export const INSPECTED: Record<SeccompArch, { clone: number; clone3: number; socket: number; seccomp: number; prctl: number }> = {
  x64: { clone: 56, clone3: 435, socket: 41, seccomp: 317, prctl: 157 },
  arm64: { clone: 220, clone3: 435, socket: 198, seccomp: 277, prctl: 167 },
};

const EPERM = 1;
const ENOSYS = 38;
const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const retErrno = (errno: number) => 0x00050000 | errno;

/** Every CLONE_NEW* flag clone() takes: a new namespace of any kind. */
const CLONE_NEW_ANY = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000;

const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const SOCK_STREAM = 1;
const IPPROTO_TCP = 6;

// Classic BPF (linux/filter.h), over struct seccomp_data: the call's number
// at 0, the architecture at 4, and each 64-bit argument from 16, low half first.
const LD_ABS = 0x20;
const JEQ = 0x15;
const JGE = 0x35;
const JSET = 0x45;
const AND = 0x54;
const RET = 0x06;
const arg = (n: number) => 16 + 8 * n;

type Insn = { code: number; k: number; jt?: string; jf?: string; label?: string };

/**
 * The filter as the kernel takes it: 8 bytes an instruction. `restrictSockets`
 * also refuses every socket but a unix one and a plain TCP one — no UDP, and
 * no other protocol that rides a stream socket — so nothing leaves but
 * through the port Landlock allows.
 */
export function seccompFilter(arch: SeccompArch, restrictSockets: boolean): Uint8Array<ArrayBuffer> {
  const nr = INSPECTED[arch];
  const program: Insn[] = [
    { code: LD_ABS, k: 4 },
    { code: JEQ, k: AUDIT_ARCH[arch], jt: "arch-ok", jf: "kill" },
    { label: "kill", code: RET, k: RET_KILL_PROCESS },
    { label: "arch-ok", code: LD_ABS, k: 0 },
  ];
  // x86-64 also answers its 32-bit-pointer calls, numbered from 2^30 up.
  if (arch === "x64") program.push({ code: JGE, k: 0x40000000, jt: "refuse", jf: "listed" });
  program.push({ label: "listed", code: JEQ, k: nr.clone3, jt: "no-such-call", jf: "next" });
  for (const number of Object.values(SYSCALLS[arch])) program.push({ code: JEQ, k: number, jt: "refuse", jf: "next" });
  program.push(
    // A thread or a child, never a namespace.
    { code: JEQ, k: nr.clone, jt: "next", jf: "not-clone" },
    { code: LD_ABS, k: arg(0) },
    { code: JSET, k: CLONE_NEW_ANY, jt: "refuse", jf: "allow" },
    { label: "not-clone", code: JEQ, k: nr.socket, jt: restrictSockets ? "next" : "allow", jf: "allow" },
    { code: LD_ABS, k: arg(0) },
    { code: JEQ, k: AF_UNIX, jt: "allow", jf: "next" },
    { code: JEQ, k: AF_INET, jt: "stream-only", jf: "next" },
    { code: JEQ, k: AF_INET6, jt: "stream-only", jf: "refuse" },
    { label: "stream-only", code: LD_ABS, k: arg(1) },
    // The type's low bits; the rest are SOCK_CLOEXEC and SOCK_NONBLOCK.
    { code: AND, k: 0xf },
    { code: JEQ, k: SOCK_STREAM, jt: "next", jf: "refuse" },
    // And the protocol: a stream socket is also what MPTCP and SCTP ask
    // for, and Landlock's port rule holds plain TCP only.
    { code: LD_ABS, k: arg(2) },
    { code: JEQ, k: 0, jt: "allow", jf: "next" },
    { code: JEQ, k: IPPROTO_TCP, jt: "allow", jf: "refuse" },
    { label: "refuse", code: RET, k: retErrno(EPERM) },
    // clone3 hides its flags behind a pointer no filter can follow: the C
    // library falls back to clone when told there is no such call.
    { label: "no-such-call", code: RET, k: retErrno(ENOSYS) },
    { label: "allow", code: RET, k: RET_ALLOW },
  );

  const at = new Map<string, number>();
  program.forEach((insn, i) => insn.label && at.set(insn.label, i));
  const jump = (from: number, to: string | undefined): number => {
    if (to === undefined) return 0;
    const target = to === "next" ? from + 1 : at.get(to);
    if (target === undefined) throw new Error(`No label ${to}`);
    const offset = target - from - 1;
    if (offset < 0 || offset > 255) throw new Error(`The jump to ${to} does not fit`);
    return offset;
  };
  const bytes = new Uint8Array(program.length * 8);
  const view = new DataView(bytes.buffer);
  program.forEach((insn, i) => {
    view.setUint16(i * 8, insn.code, true);
    view.setUint8(i * 8 + 2, jump(i, insn.jt));
    view.setUint8(i * 8 + 3, jump(i, insn.jf));
    view.setUint32(i * 8 + 4, insn.k >>> 0, true);
  });
  return bytes;
}

/**
 * What the filter answers one call: "allow", "kill", or the error number it
 * refuses with. Runs the same bytes the kernel would, so a test can ask
 * about any call without a kernel that has seccomp.
 */
export function seccompVerdict(
  filter: Uint8Array,
  call: { arch: number; nr: number; args?: number[] },
): "allow" | "kill" | number {
  const data = new DataView(new ArrayBuffer(64));
  data.setUint32(0, call.nr, true);
  data.setUint32(4, call.arch >>> 0, true);
  (call.args ?? []).forEach((value, i) => data.setBigUint64(arg(i), BigInt(value), true));
  const view = new DataView(filter.buffer, filter.byteOffset, filter.byteLength);
  let acc = 0;
  for (let pc = 0; pc < filter.byteLength / 8; pc++) {
    const code = view.getUint16(pc * 8, true);
    const jt = view.getUint8(pc * 8 + 2);
    const jf = view.getUint8(pc * 8 + 3);
    const k = view.getUint32(pc * 8 + 4, true);
    if (code === LD_ABS) acc = data.getUint32(k, true);
    else if (code === AND) acc = (acc & k) >>> 0;
    else if (code === JEQ) pc += acc === k ? jt : jf;
    else if (code === JGE) pc += acc >= k ? jt : jf;
    else if (code === JSET) pc += (acc & k) !== 0 ? jt : jf;
    else if (code === RET) {
      if (k === RET_ALLOW) return "allow";
      if (k === RET_KILL_PROCESS) return "kill";
      return k & 0xffff;
    } else throw new Error(`Unknown instruction ${code}`);
  }
  throw new Error("The filter ran off its end");
}

export const SECCOMP_ARCH = AUDIT_ARCH;

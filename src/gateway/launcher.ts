// What a hosted worker starts through (spawner.ts,
// docs/hosted-tenant-isolation.md "Step 2"). The spawner, as root, drops to
// the worker's uid and runs this with an environment of PATH alone; what to
// start arrives on its input. So this runs as the worker already, and:
//
//   1. reads the plan: the program, its folder, its environment, its rules;
//   2. confines itself — Landlock for files and TCP ports, seccomp for
//      system calls (sandbox.ts) — as far as this kernel can;
//   3. becomes the worker (execve), which keeps every rule and can never
//      loosen one.
//
// Both kinds of rule bind the thread that asks, and whatever it becomes.
// Becoming the worker replaces the whole process with that one thread's
// successor, so nothing of this launcher is left outside the rules.
//
//   bun src/gateway/launcher.ts --probe   prints what this kernel offers
//   ... --report                          also prints what it applied (sandboxCheck.ts)

import { closeSync, openSync, statSync } from "node:fs";
import { release } from "node:os";
import {
  INSPECTED,
  LANDLOCK,
  pathRights,
  rulesetAttr,
  seccompFilter,
  type LaunchSpec,
  type PathKind,
  type SandboxSpec,
  type SeccompArch,
} from "./sandbox";

/** What the launcher found and applied; one line of it goes to the log. */
export interface SandboxResult {
  kernel: string;
  /** The kernel's Landlock version; 0 when it has none. */
  landlock: number;
  /** Whether files are confined, and TCP. */
  files: boolean;
  network: boolean;
  seccomp: boolean;
  /** Why something was left out. */
  notes: string[];
}

const O_PATH = 0o10000000;
const PR_SET_NO_NEW_PRIVS = 38;
const SECCOMP_SET_MODE_FILTER = 1;

type Syscall = (nr: number, a?: number, b?: number, c?: number, d?: number, e?: number, f?: number) => number;

/** The C library's syscall(), and a pointer to bytes this process holds. */
async function libc(): Promise<{ syscall: Syscall; address: (bytes: ArrayBufferView) => number }> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const lib = dlopen("libc.so.6", {
    // All six arguments every time: the kernel checks that the ones a call
    // does not use are zero (prctl), and an unset one is whatever was there.
    syscall: {
      args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
      returns: FFIType.i64,
    },
  });
  return {
    syscall: (nr, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0) => Number(lib.symbols.syscall(nr, a, b, c, d, e, f)),
    address: (bytes) => Number(ptr(bytes as NodeJS.TypedArray)),
  };
}

function seccompArch(): SeccompArch | null {
  return process.arch === "x64" || process.arch === "arm64" ? process.arch : null;
}

/** The kernel's Landlock version, or 0 where it has none or it is switched off. */
function landlockVersion(syscall: Syscall): number {
  const abi = syscall(LANDLOCK.createRuleset, 0, 0, LANDLOCK.version);
  return abi > 0 ? abi : 0;
}

/** What this kernel offers, changing nothing. */
export async function probeSandbox(): Promise<SandboxResult> {
  const result: SandboxResult = { kernel: release(), landlock: 0, files: false, network: false, seccomp: false, notes: [] };
  if (process.platform !== "linux") {
    result.notes.push(`${process.platform} has neither Landlock nor seccomp`);
    return result;
  }
  const { syscall } = await libc();
  result.landlock = landlockVersion(syscall);
  result.files = result.landlock >= 1;
  result.network = result.landlock >= 4;
  result.seccomp = seccompArch() !== null;
  if (!result.files) result.notes.push("no Landlock: files are kept apart by the uid alone");
  else if (!result.network) result.notes.push("Landlock without TCP rules (Linux 6.7 has them): the outbound proxy is not enforced");
  return result;
}

/** Confine this thread, and whatever it becomes, to the plan. */
export async function applySandbox(spec: SandboxSpec): Promise<SandboxResult> {
  const result: SandboxResult = { kernel: release(), landlock: 0, files: false, network: false, seccomp: false, notes: [] };
  if (process.platform !== "linux") {
    result.notes.push(`${process.platform} has neither Landlock nor seccomp`);
    return result;
  }
  const { syscall, address } = await libc();
  const must = (value: number, what: string): number => {
    if (value < 0) throw new Error(`${what} failed`);
    return value;
  };
  // Asked for already by setpriv; both kinds of rule need it of a process that is not root.
  must(syscall(INSPECTED[seccompArch() ?? "x64"].prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0), "no_new_privs");

  const abi = landlockVersion(syscall);
  result.landlock = abi;
  if (abi === 0) {
    result.notes.push("no Landlock: files are kept apart by the uid alone");
  } else {
    const attr = rulesetAttr(abi, spec.connectPort !== null);
    const attrBytes = new BigUint64Array([BigInt(attr.fs), BigInt(attr.net), BigInt(attr.scoped)]);
    const ruleset = must(syscall(LANDLOCK.createRuleset, address(attrBytes), attr.size, 0), "landlock_create_ruleset");
    const allow = (path: string, kind: PathKind) => {
      let isDirectory: boolean;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        // Not in this image: nothing to allow.
        return;
      }
      const rights = pathRights(kind, isDirectory, abi);
      const fd = openSync(path, O_PATH);
      try {
        // struct landlock_path_beneath_attr, packed: the rights, then the folder.
        const rule = new DataView(new ArrayBuffer(16));
        rule.setBigUint64(0, BigInt(rights), true);
        rule.setInt32(8, fd, true);
        must(syscall(LANDLOCK.addRule, ruleset, LANDLOCK.rulePathBeneath, address(rule), 0), `the Landlock rule for ${path}`);
      } finally {
        closeSync(fd);
      }
    };
    for (const path of spec.readOnly) allow(path, "readOnly");
    for (const path of spec.devices) allow(path, "device");
    for (const path of spec.readWrite) allow(path, "readWrite");
    if (attr.net !== 0 && spec.connectPort !== null) {
      // struct landlock_net_port_attr: the rights, then the port.
      const rule = new BigUint64Array([BigInt(LANDLOCK.netConnectTcp), BigInt(spec.connectPort)]);
      must(syscall(LANDLOCK.addRule, ruleset, LANDLOCK.ruleNetPort, address(rule), 0), "the Landlock rule for the proxy's port");
      result.network = true;
    } else if (spec.connectPort !== null) {
      result.notes.push("Landlock without TCP rules (Linux 6.7 has them): the outbound proxy is not enforced");
    }
    must(syscall(LANDLOCK.restrictSelf, ruleset, 0), "landlock_restrict_self");
    closeSync(ruleset);
    result.files = true;
  }

  const arch = seccompArch();
  if (!arch) {
    result.notes.push(`no seccomp filter for ${process.arch}`);
  } else {
    const filter = seccompFilter(arch, spec.connectPort !== null);
    // struct sock_fprog: how many instructions, then where they are.
    const program = new DataView(new ArrayBuffer(16));
    program.setUint16(0, filter.byteLength / 8, true);
    program.setBigUint64(8, BigInt(address(filter)), true);
    must(syscall(INSPECTED[arch].seccomp, SECCOMP_SET_MODE_FILTER, 0, address(program)), "seccomp");
    result.seccomp = true;
  }
  return result;
}

/** One line for the log: what holds this worker beyond its uid. */
export function describeSandbox(result: SandboxResult): string {
  const held = [
    result.files ? "files (Landlock)" : null,
    result.network ? "TCP to the proxy only" : null,
    result.seccomp ? "system calls (seccomp)" : null,
  ].filter(Boolean);
  const notes = result.notes.length ? `; ${result.notes.join("; ")}` : "";
  return `kernel ${result.kernel}, Landlock ${result.landlock || "absent"}: ${held.length ? held.join(", ") : "nothing beyond the uid"}${notes}`;
}

if (import.meta.main) {
  if (process.argv[2] === "--probe") {
    console.log(JSON.stringify(await probeSandbox()));
    process.exit(0);
  }
  const spec = JSON.parse(await Bun.stdin.text()) as LaunchSpec;
  if (spec.sandbox) {
    const result = await applySandbox(spec.sandbox);
    // `--report` (sandboxCheck.ts): say what was applied before becoming the program.
    if (process.argv[2] === "--report") console.log(JSON.stringify(result));
  }
  process.chdir(spec.cwd);
  if (!process.execve) throw new Error("This runtime cannot replace itself with the worker (process.execve)");
  process.execve(spec.argv[0]!, spec.argv, spec.env);
}

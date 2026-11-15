// The ways the storage core fails, as typed errors in the Effect error
// channel. Each one also says what the Promise functions built on it throw
// (toThrowable), so the facades — fsx.ts, automerge/store.ts, state.ts,
// tokenStore.ts, secrets.ts, siteTokens.ts — reject with exactly the errors
// they always did: a file error is the errno exception itself (`code`,
// `syscall`, `path`), a refused document is the caller's own error. The
// bridge (src/server/effect/bridge.ts) does the rethrowing.

import { Data } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { Throwable } from "../effect/bridge";

export type { Throwable };

/**
 * A file operation failed. `code` is the errno name when the platform gave
 * one (`ENOENT`, `EACCES`, …); `reason` is Effect's platform-neutral class
 * of the failure (`NotFound`, `PermissionDenied`, …), which is all a
 * file system other than Node's reports.
 */
export class FileIoError
  extends Data.TaggedError("FileIoError")<{
    readonly op: string;
    readonly path: string;
    readonly reason: string;
    readonly code: string | undefined;
    readonly cause: unknown;
  }>
  implements Throwable
{
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : `${this.op} failed for ${this.path}`;
  }

  /** True when nothing readable is at the path: missing, a directory, or under a non-directory. */
  get absent(): boolean {
    if (this.code !== undefined) {
      return this.code === "ENOENT" || this.code === "EISDIR" || this.code === "ENOTDIR";
    }
    return this.reason === "NotFound";
  }

  toThrowable(): unknown {
    return this.cause instanceof Error ? this.cause : this;
  }
}

/** A platform error as a FileIoError that keeps the errno exception it came from. */
export const fileIoError =
  (op: string, path: string) =>
  (error: PlatformError): FileIoError => {
    const cause = error.reason.cause;
    const code = (cause as { code?: unknown } | undefined)?.code;
    return new FileIoError({
      op,
      path,
      reason: error.reason._tag,
      code: typeof code === "string" ? code : undefined,
      cause: cause ?? error,
    });
  };

/** A store-relative document directory that would leave the store. */
export class InvalidDocPath
  extends Data.TaggedError("InvalidDocPath")<{ readonly dirRel: string }>
  implements Throwable
{
  override get message(): string {
    return "invalid document path";
  }

  toThrowable(): unknown {
    return new Error("invalid document path");
  }
}

/**
 * The caller's check refused a document as it was loaded — one written in a
 * schema newer than this app reads (dataFormat.ts DataTooNewError), which is
 * `cause`.
 */
export class DocumentRejected
  extends Data.TaggedError("DocumentRejected")<{
    readonly fileName: string;
    readonly cause: unknown;
  }>
  implements Throwable
{
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : `document ${this.fileName} was rejected`;
  }

  toThrowable(): unknown {
    return this.cause;
  }
}

/**
 * A credential backend handed to the app (the desktop's safeStorage, a
 * hosted worker's read-only one, a test's) failed; `cause` is what it threw.
 */
export class BackendError
  extends Data.TaggedError("BackendError")<{
    readonly op: "load" | "save" | "clear";
    readonly cause: unknown;
  }>
  implements Throwable
{
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : `credential ${this.op} failed`;
  }

  toThrowable(): unknown {
    return this.cause;
  }
}

/** A name that cannot be a secret store's: it would not be one file name. */
export class InvalidSecretName
  extends Data.TaggedError("InvalidSecretName")<{ readonly storeName: string }>
  implements Throwable
{
  override get message(): string {
    return `"${this.storeName}" is not a secret store name`;
  }

  toThrowable(): unknown {
    return new Error(this.message);
  }
}

export type PersistenceError =
  | FileIoError
  | InvalidDocPath
  | DocumentRejected
  | BackendError
  | InvalidSecretName;

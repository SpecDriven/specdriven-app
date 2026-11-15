// File operations for the storage core, as Effects over Effect's FileSystem
// service. The file system is a dependency, so the same programs run on
// Node's (runtime.ts, under Bun and Electron alike) and on a stand-in a test
// provides. Every failure is a FileIoError that keeps the errno exception.
//
// The first five are the habits src/server/fsx.ts documents — writes create
// missing parent directories, reads of missing paths are null rather than
// failures — and fsx.ts is their Promise form.

import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { dirname } from "node:path";
import { fileIoError, type FileIoError } from "./errors";

/** A file operation of the storage core: it needs a file system and fails with a FileIoError. */
export type FileEffect<A> = Effect.Effect<A, FileIoError, FileSystem>;

/** A directory entry, as `readdir` with file types reports it. */
export interface Entry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

// Node's own UTF-8 decoding, as `readFile(path, "utf8")` does it: a leading
// byte-order mark stays in the text (a TextDecoder would drop it).
function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

/** A file's bytes. */
export const readBytes = (path: string): FileEffect<Uint8Array> =>
  FileSystem.use((fs) =>
    fs.readFile(path).pipe(Effect.mapError(fileIoError("readFile", path))),
  );

/** Write bytes to a file whose directory exists. */
export const writeBytes = (path: string, bytes: Uint8Array): FileEffect<void> =>
  FileSystem.use((fs) =>
    fs.writeFile(path, bytes).pipe(Effect.mapError(fileIoError("writeFile", path))),
  );

/** File contents as UTF-8; fails when there is nothing readable at the path. */
export const readTextStrict = (path: string): FileEffect<string> =>
  Effect.map(readBytes(path), utf8);

/**
 * File contents as UTF-8, or null when there is nothing readable at the
 * path (missing, a directory, or under a non-directory segment).
 */
export const readText = (path: string): FileEffect<string | null> =>
  readTextStrict(path).pipe(
    Effect.catch((error): FileEffect<string | null> =>
      error.absent ? Effect.succeed(null) : Effect.fail(error),
    ),
  );

/** Create a directory and any missing parents. */
export const makeDirectories = (path: string): FileEffect<void> =>
  FileSystem.use((fs) =>
    fs.makeDirectory(path, { recursive: true }).pipe(Effect.mapError(fileIoError("mkdir", path))),
  );

/** Write text to a file whose directory exists. */
export const writeString = (path: string, content: string): FileEffect<void> =>
  FileSystem.use((fs) =>
    fs.writeFileString(path, content).pipe(Effect.mapError(fileIoError("writeFile", path))),
  );

/** Bun.write-style write: missing parent directories are created first. */
export const writeText = (path: string, content: string): FileEffect<void> =>
  Effect.andThen(makeDirectories(dirname(path)), writeString(path, content));

/** Move a file or directory. */
export const rename = (from: string, to: string): FileEffect<void> =>
  FileSystem.use((fs) =>
    fs.rename(from, to).pipe(Effect.mapError(fileIoError("rename", from))),
  );

/** Remove a file; nothing there is not a failure. */
export const removeFile = (path: string): FileEffect<void> =>
  FileSystem.use((fs) =>
    fs.remove(path, { force: true }).pipe(Effect.mapError(fileIoError("rm", path))),
  );

/** Remove a directory and all it holds; nothing there is not a failure. */
export const removeTree = (path: string): FileEffect<void> =>
  FileSystem.use((fs) =>
    fs.remove(path, { recursive: true, force: true }).pipe(Effect.mapError(fileIoError("rm", path))),
  );

/**
 * Replace a file in one step: the content goes to a sibling temp file,
 * then takes the path over by rename, so a reader never sees a torn or
 * empty file while a write is under way (the settings file, which several
 * requests read and write at once). The temp file never outlives a write
 * that failed or was interrupted.
 */
export const replaceText = (path: string, content: string): FileEffect<void> =>
  Effect.suspend(() => {
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    return makeDirectories(dirname(path)).pipe(
      Effect.andThen(
        writeString(tmp, content).pipe(
          Effect.andThen(rename(tmp, path)),
          Effect.onError(() => Effect.ignore(removeFile(tmp))),
        ),
      ),
    );
  });

/** Owner-only and the like: set a file's permission bits. */
export const chmod = (path: string, mode: number): FileEffect<void> =>
  FileSystem.use((fs) =>
    fs.chmod(path, mode).pipe(Effect.mapError(fileIoError("chmod", path))),
  );

type Kind = "File" | "Directory" | "Other";

const kindOf = (path: string): Effect.Effect<Kind | null, never, FileSystem> =>
  FileSystem.use((fs) =>
    fs.stat(path).pipe(
      Effect.map((info): Kind => (info.type === "File" || info.type === "Directory" ? info.type : "Other")),
      Effect.catch(() => Effect.succeed(null)),
    ),
  );

/** True when a plain file exists at the path (directories don't count). */
export const fileExists = (path: string): Effect.Effect<boolean, never, FileSystem> =>
  Effect.map(kindOf(path), (kind) => kind === "File");

/** True when a directory exists at the path. */
export const directoryExists = (path: string): Effect.Effect<boolean, never, FileSystem> =>
  Effect.map(kindOf(path), (kind) => kind === "Directory");

/** When the path was last modified, in milliseconds; 0 when it cannot be read. */
export const modifiedMs = (path: string): Effect.Effect<number, never, FileSystem> =>
  FileSystem.use((fs) =>
    fs.stat(path).pipe(
      Effect.map((info) => Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() })),
      Effect.catch(() => Effect.succeed(0)),
    ),
  );

/** The names in a directory. */
export const listNames = (path: string): FileEffect<string[]> =>
  FileSystem.use((fs) =>
    fs.readDirectory(path).pipe(Effect.mapError(fileIoError("readdir", path))),
  );

/** The entries of a directory with their types — a symbolic link is neither file nor directory. */
export const listEntries = (path: string): FileEffect<Entry[]> =>
  FileSystem.use((fs) =>
    fs.readDirectoryEntries(path).pipe(
      Effect.map((entries) =>
        entries.map((entry) => ({
          name: entry.name,
          isFile: entry.type === "File",
          isDirectory: entry.type === "Directory",
        })),
      ),
      Effect.mapError(fileIoError("readdir", path)),
    ),
  );

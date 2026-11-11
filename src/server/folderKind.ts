// What kind of folder a path names (specs/ui/app-start.feature.md "one
// field opens a specification folder or a code repository"): the first-run
// screen has one field for both, and tells them apart by what is inside.
//
// - A specification folder holds a `.specdriven` folder AND a `specs`
//   folder. A `specs` symlink does not count: that is the link a code
//   repository carries to the specs it implements (src/server/specsLink.ts).
// - A code repository holds neither pair, and a file a well-known build
//   tool reads — Maven's pom.xml, npm's package.json, and so on.
// - An empty folder named `specs-…` is probably a specification folder
//   someone just made; the screen asks, and on a yes the two folders are
//   added (initSpecFolder).
// - Anything else cannot be told, and the screen asks which it is.
//
// Reading only: nothing here writes, except initSpecFolder, which the
// caller runs once the user agreed.

import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { looksLikeRepoUrl, parseGitHubUrl } from "./repo";
import { SPECS_FOLDER } from "./walk";

/** The folder a specification folder keeps the app's own data in. */
const SPEC_DATA_FOLDER = ".specdriven";

/** What an empty folder's name starts with when it is meant for specs. */
const SPECS_NAME_PREFIX = "specs-";

export type FolderKindVerdict =
  /** A repository url: cloned and opened as a specification folder. */
  | "url"
  /** `.specdriven` and `specs` are both there. */
  | "spec"
  /** No spec folders, and a build tool's file. */
  | "code"
  /** Empty, and named `specs-…`: ask whether to set it up for specs. */
  | "empty-specs"
  /** A folder that is neither: ask which kind it is. */
  | "unknown"
  /** Nothing at the path. */
  | "missing"
  /** Something other than a folder. */
  | "not-a-folder";

export interface FolderKindResult {
  kind: FolderKindVerdict;
  /** What to open: the input as typed, a leading `~` expanded. */
  open: string;
  /** The folder's absolute path; the input itself for a url. */
  path: string;
  /** The folder's own name, for the questions the screen asks. */
  name: string;
  /** For "code": the build tool whose file was found, e.g. "Maven". */
  buildTool?: string;
}

/**
 * Files at a repository's root that say a build tool works there, with the
 * tool's name. Exact names first; BUILD_FILE_SUFFIXES covers the tools whose
 * file carries the project's name (.NET, Xcode).
 */
export const BUILD_FILES: ReadonlyArray<readonly [file: string, tool: string]> = [
  ["pom.xml", "Maven"],
  ["mvnw", "Maven"],
  ["build.gradle", "Gradle"],
  ["build.gradle.kts", "Gradle"],
  ["settings.gradle", "Gradle"],
  ["settings.gradle.kts", "Gradle"],
  ["gradlew", "Gradle"],
  ["build.xml", "Ant"],
  ["build.sbt", "sbt"],
  ["package.json", "npm"],
  ["deno.json", "Deno"],
  ["deno.jsonc", "Deno"],
  ["bun.lock", "Bun"],
  ["bun.lockb", "Bun"],
  ["Cargo.toml", "Cargo"],
  ["go.mod", "Go"],
  ["pyproject.toml", "Python"],
  ["setup.py", "Python"],
  ["requirements.txt", "pip"],
  ["Pipfile", "Pipenv"],
  ["Gemfile", "Bundler"],
  ["Rakefile", "Rake"],
  ["composer.json", "Composer"],
  ["mix.exs", "Mix"],
  ["pubspec.yaml", "Dart"],
  ["Package.swift", "Swift Package Manager"],
  ["CMakeLists.txt", "CMake"],
  ["meson.build", "Meson"],
  ["Makefile", "Make"],
  ["makefile", "Make"],
  ["GNUmakefile", "Make"],
  ["justfile", "just"],
  ["Justfile", "just"],
  ["WORKSPACE", "Bazel"],
  ["WORKSPACE.bazel", "Bazel"],
  ["MODULE.bazel", "Bazel"],
  ["BUILD.bazel", "Bazel"],
  ["stack.yaml", "Stack"],
  ["build.zig", "Zig"],
];

const BUILD_FILE_SUFFIXES: ReadonlyArray<readonly [suffix: string, tool: string]> = [
  [".sln", ".NET"],
  [".csproj", ".NET"],
  [".fsproj", ".NET"],
  [".vbproj", ".NET"],
  [".xcodeproj", "Xcode"],
  [".xcworkspace", "Xcode"],
  [".cabal", "Cabal"],
  [".gemspec", "RubyGems"],
];

/** What a folder may hold and still count as empty: git's own, and Finder's. */
const IGNORED_WHEN_EMPTY = new Set([".git", ".DS_Store", "Thumbs.db", "desktop.ini"]);

/** The build tool whose file is among `names`, or null. */
export function buildToolAmong(names: readonly string[]): string | null {
  const have = new Set(names);
  for (const [file, tool] of BUILD_FILES) if (have.has(file)) return tool;
  for (const name of names) {
    for (const [suffix, tool] of BUILD_FILE_SUFFIXES) if (name.endsWith(suffix)) return tool;
  }
  return null;
}

/** A leading `~` or `~/` as the home folder; anything else untouched. */
export function expandHome(input: string): string {
  return input === "~" || input.startsWith("~/") || input.startsWith("~\\") ? homedir() + input.slice(1) : input;
}

/**
 * Classify `input` — a path (relative ones against `rootDir`, as the data
 * folder setting reads them) or a repository url.
 */
export async function folderKind(input: string, rootDir: string): Promise<FolderKindResult> {
  const typed = input.trim();
  if (parseGitHubUrl(typed) || looksLikeRepoUrl(typed)) {
    return { kind: "url", open: typed, path: typed, name: typed };
  }
  const open = expandHome(typed);
  const path = resolve(rootDir, open);
  const base = { open, path, name: basename(path) };

  const s = await stat(path).catch(() => null);
  if (s === null) return { kind: "missing", ...base };
  if (!s.isDirectory()) return { kind: "not-a-folder", ...base };

  const names = await readdir(path).catch(() => [] as string[]);
  if (names.includes(SPEC_DATA_FOLDER) && names.includes(SPECS_FOLDER)) {
    const [data, specs] = await Promise.all([
      stat(join(path, SPEC_DATA_FOLDER)).catch(() => null),
      // lstat: a code repository's `specs` link is not a specs folder.
      lstat(join(path, SPECS_FOLDER)).catch(() => null),
    ]);
    if (data?.isDirectory() && specs?.isDirectory()) return { kind: "spec", ...base };
  }
  const buildTool = buildToolAmong(names);
  if (buildTool) return { kind: "code", ...base, buildTool };
  const empty = names.every((n) => IGNORED_WHEN_EMPTY.has(n));
  if (empty && base.name.startsWith(SPECS_NAME_PREFIX)) return { kind: "empty-specs", ...base };
  return { kind: "unknown", ...base };
}

/**
 * Make a folder a specification folder: `.specdriven` and `specs` inside
 * it, each left alone when already there. The folder itself must exist.
 */
export async function initSpecFolder(dir: string): Promise<void> {
  await mkdir(join(dir, SPEC_DATA_FOLDER), { recursive: true });
  await mkdir(join(dir, SPECS_FOLDER), { recursive: true });
}

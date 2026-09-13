// Open a test link in IntelliJ IDEA (specs/traceability.feature.md "Open
// test in idea"). A test link is a GitHub `blob` url with a line anchor
// (src/server/testName.ts); with the setting on, clicking one hands the
// file to the IDE instead of the browser:
//
//   idea --line 42 /abs/path/to/Foo.java
//
// `idea` must be on PATH — on a Mac, a symlink to the app's launcher:
//   ln -s "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea" /usr/local/bin/idea
//
// The absolute path is the url's path under the project's code repo
// (project-settings.json `code-repo`, src/server/members.ts) — the local
// checkout of the repository the url names. Node APIs only: this module
// also runs under Electron (src/server/run.ts).

import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { fileExists } from "./fsx";
import { which } from "./run";
import { parseTestUrl } from "./testName";

/** The IDEA launcher a test link is opened with. */
export const IDEA_BIN = "idea";

/** The one-line remedy the app shows when `idea` is not on PATH. */
export const IDEA_SYMLINK_HINT =
  'ln -s "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea" /usr/local/bin/idea';

// Injection seam (the CLI ones in src/server/agent.ts): tests run on a
// PATH without idea and must never launch it; null restores the probe.
let ideaAvailability: (() => boolean) | null = null;

export function setIdeaAvailability(fn: (() => boolean) | null): (() => boolean) | null {
  const previous = ideaAvailability;
  ideaAvailability = fn;
  return previous;
}

export function ideaAvailable(): boolean {
  return ideaAvailability ? ideaAvailability() : which(IDEA_BIN) !== null;
}

/** A test link resolved to the local checkout: the file and the line. */
export interface LocalTest {
  file: string;
  line: number;
}

/**
 * The local file a test link names, under `codeRepo`, or null when no file
 * there matches. A url does not tell its ref from its path — a branch name
 * may hold slashes — so every split is tried, shortest ref first, and the
 * first path that exists is the one (the same search
 * src/server/testName.ts runs against GitHub). A path that would escape
 * the code repo is never followed.
 */
export async function localTestFile(codeRepo: string, url: string): Promise<LocalTest | null> {
  const target = parseTestUrl(url);
  if (!target) return null;
  const root = resolve(codeRepo);
  for (let split = 1; split < target.segments.length; split++) {
    const path = target.segments.slice(split).map(decodeSegment).join("/");
    const file = resolve(root, path);
    const inside = relative(root, file);
    if (!inside || inside.startsWith("..") || inside.startsWith(sep)) continue;
    if (await fileExists(file)) return { file, line: target.line };
  }
  return null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Launches the IDE on a file and line; resolves once the launcher is running. */
export type IdeaOpener = (file: string, line: number) => Promise<void>;

/**
 * The real launcher. `idea` is the IDE itself when it isn't already running
 * — it stays alive as long as the window does — so it is started detached
 * and never waited for; only a failure to start (no such binary, not
 * executable) is reported.
 */
const spawnIdea: IdeaOpener = (file, line) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(IDEA_BIN, ["--line", String(line), file], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (e) => reject(e));
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });

// Injection seam: tests record what would be launched instead of launching it.
let opener: IdeaOpener | null = null;

export function setIdeaOpener(fn: IdeaOpener | null): IdeaOpener | null {
  const previous = opener;
  opener = fn;
  return previous;
}

/** Open `file` at `line` in IDEA. */
export function openInIdea(file: string, line: number): Promise<void> {
  return (opener ?? spawnIdea)(file, line);
}

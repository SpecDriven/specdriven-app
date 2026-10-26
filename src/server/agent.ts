// Coding agent integration (specs/agents/claude.feature.md): a named code gen
// session takes the selected specs and builds one prompt from them. The
// targets: the app's own coding agent pane, driven by whichever agent
// plugin is installed (specs/agents/agent-plugins.feature.md); or Claude
// Code Desktop, opened on the data repo through its `claude://code/new` deep
// link with a short bootstrap prompt that titles the session and points it
// at the full prompt saved on disk. Node APIs only — this module also runs
// under Electron (src/server/run.ts).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeTextFile } from "./fsx";
import { run } from "./run";
import type { RunOptions, RunResult } from "./run";
import { settingsDirectory } from "./state";

/** One spec picked into the session: its repo-relative file and its text. */
export interface SpecInput {
  fileName: string;
  content: string;
  /** True when content carries only the selected scenarios, not the whole
      spec — the prompt says so, so Claude doesn't take it for the full file. */
  partial?: boolean;
}

/**
 * What a plugin bundles into the session after the specs
 * (src/plugins/host/services.ts SessionParts) — the Event Models plugin's
 * model, the map the specs belong to: the model open on its tab when the
 * session started, or one whose slice links a selected spec.
 */
export interface SessionSection {
  /** After `## `, e.g. `Event Model: models/cart.model.json`. */
  heading: string;
  /** What the prompt asks to implement when the session has no specs. */
  noun: { one: string; many: string };
  /** The section's body, verbatim. */
  lines: string[];
}

/**
 * Where a session runs (src/server/members.ts `code-repo`): the code repo
 * when the data repo's project-settings.json names one, else the data repo
 * itself. The prompt tells Claude where the specs are when they are not in
 * the working directory.
 */
export interface SessionPlace {
  /** The data repo the specs were read from. */
  dataRepo: string;
  /** The code repo the session works in; absent means the data repo. */
  codeRepo?: string;
}

/** The folder a session runs in for a place. */
export function sessionWorkDir(place: SessionPlace): string {
  return place.codeRepo ?? place.dataRepo;
}

/** Injectable subprocess runner, so tests never spawn a real CLI. */
export type Runner = (cmd: string, args: string[], options?: RunOptions) => Promise<RunResult>;

/**
 * The generated prompt: the session name, the instruction, then every
 * selected spec verbatim under a heading that names its file — and after
 * the specs, whatever the plugins bundle with them (an Event Model, as its
 * slices' map and its JSON).
 */
export function buildSessionPrompt(
  name: string,
  specs: SpecInput[],
  place?: SessionPlace,
  sections: SessionSection[] = [],
): string {
  const noun = sections[0]?.noun ?? { one: "specification", many: "specifications" };
  const what =
    specs.length > 0
      ? `Implement the following ${specs.length === 1 ? "specification" : "specifications"}.`
      : `Implement the following ${sections.length === 1 ? noun.one : noun.many}.`;
  const lines = [`SpecDriven code gen session: ${name}`, "", what, "Work in the current directory and exit when done."];
  // With a code repo, the session runs away from the specs; say where they
  // are, and that the code — not the specs — is what to change.
  if (place?.codeRepo) {
    lines.push(
      `The current directory is the code repository. The specifications live in the SpecDriven data repository at ${place.dataRepo}; edit the code, not the specifications.`,
    );
  }
  for (const spec of specs) {
    const heading = `## Spec: ${spec.fileName}${spec.partial ? " (selected scenarios only)" : ""}`;
    lines.push("", heading, "", spec.content.trimEnd());
  }
  for (const section of sections) {
    lines.push("", `## ${section.heading}`, "", ...section.lines);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Claude Code Desktop (roadmap/start-session-in-claude-code-desktop.md)
//
// Claude.app registers `claude://`; its router's `code` host has a `/new`
// route taking `q` (the prompt, sliced to CLAUDE_DESKTOP_PROMPT_MAX chars)
// and repeatable `folder`. Read out of the shipped bundle (1.46388.3), not
// from docs, so version-coupled. The full prompt can outgrow the cap, and
// the `resume` route drops a CLI-given session name — so the prompt goes to
// a file, and a short bootstrap prompt tells the session to title itself
// (through the desktop's own set_session_title tool) and read that file.

/** Claude.app's router slices `q` to this many chars; the bootstrap stays far below. */
export const CLAUDE_DESKTOP_PROMPT_MAX = 14336;
/** The agent recorded in a desktop session's session.json. */
export const DESKTOP_AGENT = "claude-code-desktop";
/** The agent recorded for a session run in the app's own coding agent pane
    (specs/agents/agent-pane.feature.md, src/server/agentChat.ts). */
export const PANE_AGENT = "pane";
/** The same pane, driven by Pi, as recorded before agent plugins. */
export const PI_PANE_AGENT = "pi-pane";
/** The same pane, driven by Codex, as recorded before agent plugins. */
export const CODEX_PANE_AGENT = "codex-pane";
/** Session records live in <settings dir>/sessions/<id>/ — beside the
    settings file, never inside the data repo, which is pushed to git. */
export const SESSIONS_SUBDIR = "sessions";
/** Longest session name the title instruction carries. */
export const SESSION_TITLE_MAX = 120;

/** The opener's own words for a failed launch, for the client's error box. */
function failureDetail(result: RunResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

/** Where the local session records go for an app root: <settings dir>/sessions. */
export async function sessionsDirectory(rootDir: string): Promise<string> {
  return join(await settingsDirectory(rootDir), SESSIONS_SUBDIR);
}

/**
 * The name as it can sit inside the quoted title instruction: one line,
 * control characters gone, quotes and backslashes escaped, cut at
 * SESSION_TITLE_MAX.
 */
export function sessionTitle(name: string): string {
  const oneLine = name
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.slice(0, SESSION_TITLE_MAX).replace(/[\\"]/g, "\\$&");
}

/**
 * The short `q` prompt: the session name, the title instruction, then a
 * pointer to the full prompt on disk. Never starts with "/" — the router
 * rejects a `q` that looks like a slash command.
 */
export function buildDesktopBootstrapPrompt(name: string, promptPath: string): string {
  const title = sessionTitle(name);
  const lines = [
    `SpecDriven code gen session: ${title}`,
    "",
    `First set this session's title to "${title}".`,
    "",
    `Then read the session prompt at ${promptPath} and implement the specifications it contains.`,
    "Work in the current directory and exit when done.",
  ];
  const text = lines.join("\n") + "\n";
  // The first line is a fixed literal, so this only guards a future edit.
  return text.startsWith("/") ? ` ${text}` : text;
}

/**
 * claude://code/new?q=…&folder=… — encodeURIComponent rather than
 * URLSearchParams, whose "+" for spaces is not what every reader decodes.
 */
export function claudeDesktopUrl(bootstrap: string, folder: string): string {
  return `claude://code/new?q=${encodeURIComponent(bootstrap)}&folder=${encodeURIComponent(folder)}`;
}

/** The OS command that hands a url to the app registered for its scheme. */
export function desktopOpener(platform: string = process.platform): {
  cmd: string;
  args: (url: string) => string[];
} {
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: (url) => [url] };
    case "linux":
      return { cmd: "xdg-open", args: (url) => [url] };
    case "win32":
      // cmd.exe treats "&" in the url as a command separator and execFile
      // cannot quote it away — escape as "^&" (or use
      // `rundll32 url.dll,FileProtocolHandler`) before Claude Code Desktop
      // is offered on Windows; claudeDesktopInstalled keeps it off for now.
      return { cmd: "cmd", args: (url) => ["/c", "start", "", url] };
    default:
      throw new Error(`no way to open a url on ${platform}`);
  }
}

/**
 * Whether Claude.app is installed where macOS puts it (/Applications or
 * ~/Applications). Other platforms answer false for now — the deep link
 * was verified on macOS only.
 */
export function claudeDesktopInstalled(
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): boolean {
  if (platform !== "darwin") return false;
  return exists("/Applications/Claude.app") || exists(join(home, "Applications", "Claude.app"));
}

// Injection seams (the folderChooser pattern): tests and the desktop shell
// swap the availability probe and the opener runner; null restores the
// defaults.
let availability: (() => boolean) | null = null;
let desktopRunner: Runner | null = null;

export function setDesktopAvailability(fn: (() => boolean) | null): (() => boolean) | null {
  const previous = availability;
  availability = fn;
  return previous;
}

export function claudeDesktopAvailable(): boolean {
  return availability ? availability() : claudeDesktopInstalled();
}

export function setDesktopRunner(runner: Runner | null): Runner | null {
  const previous = desktopRunner;
  desktopRunner = runner;
  return previous;
}

/** The local, non-git record of a desktop session
    (specs/launch-ai-agent-session.feature.md "Coding Session Entity"). */
export interface SessionRecord {
  id: string;
  name: string;
  /** ISO 8601 start time. */
  startedAt: string;
  agent: typeof DESKTOP_AGENT | typeof PANE_AGENT | typeof PI_PANE_AGENT | typeof CODEX_PANE_AGENT;
  dataRepo: string;
  /** The code repo the session was opened on; absent when it ran in the
      data repo (src/server/members.ts `code-repo`). */
  codeRepo?: string;
  specs: { fileName: string; partial: boolean }[];
}

export interface DesktopSessionResult {
  name: string;
  id: string;
  /** Where the full prompt was written — the bootstrap points Claude here. */
  promptPath: string;
}

export interface DesktopLaunchOptions {
  /** <settings dir>/sessions — see sessionsDirectory. */
  sessionsDir: string;
  /** Default: the injected desktop runner, then run. */
  runner?: Runner;
  platform?: string;
  /** Default: a fresh uuid. */
  id?: string;
  /** Default: now. */
  now?: Date;
  /** What the plugins bundle after the specs (buildSessionPrompt). */
  sections?: SessionSection[];
}

/**
 * Open one code gen session in Claude Code Desktop: write the full prompt
 * and a session record under <sessionsDir>/<id>/, then hand the deep link to
 * the OS. A failed opener becomes an Error carrying its words.
 */
export async function launchDesktopSession(
  place: string | SessionPlace,
  name: string,
  specs: SpecInput[],
  options: DesktopLaunchOptions,
): Promise<DesktopSessionResult> {
  const where = typeof place === "string" ? { dataRepo: place } : place;
  const dir = sessionWorkDir(where);
  const id = options.id ?? randomUUID();
  const now = options.now ?? new Date();
  const runner = options.runner ?? desktopRunner ?? run;
  const sessionDir = join(options.sessionsDir, id);
  const promptPath = join(sessionDir, "prompt.md");
  await writeTextFile(promptPath, buildSessionPrompt(name, specs, where, options.sections ?? []));
  const record: SessionRecord = {
    id,
    name,
    startedAt: now.toISOString(),
    agent: DESKTOP_AGENT,
    dataRepo: where.dataRepo,
    ...(where.codeRepo ? { codeRepo: where.codeRepo } : {}),
    specs: specs.map((s) => ({ fileName: s.fileName, partial: s.partial === true })),
  };
  await writeTextFile(join(sessionDir, "session.json"), JSON.stringify(record, null, 2) + "\n");
  const url = claudeDesktopUrl(buildDesktopBootstrapPrompt(name, promptPath), dir);
  const opener = desktopOpener(options.platform);
  const result = await runner(opener.cmd, opener.args(url), { cwd: dir });
  if (result.exitCode !== 0) {
    const detail = failureDetail(result);
    throw new Error(
      detail
        ? `Could not open Claude Code Desktop: ${detail}`
        : `Could not open Claude Code Desktop (${opener.cmd} exited with code ${result.exitCode})`,
    );
  }
  return { name, id, promptPath };
}

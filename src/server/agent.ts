// Claude agent integration (specs/agents/claude.spec.md): a named code gen
// session takes the selected specs, builds one prompt from them and hands it
// to the Claude CLI in print mode (`claude -p …`), which executes and exits.

import { run, which } from "./run";
import type { RunOptions, RunResult } from "./run";

/** The Claude CLI binary the session shells out to. */
export const CLAUDE_BIN = "claude";

export function claudeAvailable(): boolean {
  return which(CLAUDE_BIN) !== null;
}

/** One spec picked into the session: its repo-relative file and its text. */
export interface SpecInput {
  fileName: string;
  content: string;
  /** True when content carries only the selected scenarios, not the whole
      spec — the prompt says so, so Claude doesn't take it for the full file. */
  partial?: boolean;
}

export interface CodeGenResult {
  name: string;
  /** What the CLI printed — shown as the session's outcome. */
  output: string;
}

/** Injectable subprocess runner, so tests never spawn a real CLI. */
export type Runner = (cmd: string, args: string[], options?: RunOptions) => Promise<RunResult>;

/**
 * The generated prompt: the session name, the instruction, then every
 * selected spec verbatim under a heading that names its file.
 */
export function buildSessionPrompt(name: string, specs: SpecInput[]): string {
  const lines = [
    `SpecDriven code gen session: ${name}`,
    "",
    `Implement the following ${specs.length === 1 ? "specification" : "specifications"}.`,
    "Work in the current directory and exit when done.",
  ];
  for (const spec of specs) {
    const heading = `## Spec: ${spec.fileName}${spec.partial ? " (selected scenarios only)" : ""}`;
    lines.push("", heading, "", spec.content.trimEnd());
  }
  return lines.join("\n") + "\n";
}

/**
 * Run one code gen session: prompt in, `claude -p` out. A non-zero exit
 * becomes an Error whose message carries the CLI's own words, for the
 * client's error box.
 */
export async function runCodeGenSession(
  dir: string,
  name: string,
  specs: SpecInput[],
  runner: Runner = run,
): Promise<CodeGenResult> {
  const prompt = buildSessionPrompt(name, specs);
  const result = await runner(CLAUDE_BIN, ["-p", prompt], { cwd: dir });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      detail
        ? `Claude exited with code ${result.exitCode}: ${detail}`
        : `Claude exited with code ${result.exitCode}`,
    );
  }
  return { name, output: result.stdout };
}

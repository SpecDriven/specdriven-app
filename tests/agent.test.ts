// Automates specs/agents/claude.spec.md: a named code gen session builds
// one prompt from the selected specs and passes it to the Claude CLI to
// execute and exit; an error code surfaces as an error for the error box.

import { describe, expect, test } from "bun:test";
import { buildSessionPrompt, runCodeGenSession, CLAUDE_BIN } from "../src/server/agent";
import type { Runner, SpecInput } from "../src/server/agent";
import type { RunOptions, RunResult } from "../src/server/run";

const SPECS: SpecInput[] = [
  { fileName: "billing/quotes.feature.md", content: "# Quotes\n\n## Basic quote @v1\n" },
  { fileName: "search.feature.md", content: "# Search\n\nRanked hits.\n" },
];

function fakeRunner(result: Partial<RunResult>) {
  const calls: { cmd: string; args: string[]; options?: RunOptions }[] = [];
  const runner: Runner = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { exitCode: 0, stdout: "", stderr: "", ...result };
  };
  return { runner, calls };
}

describe("buildSessionPrompt", () => {
  test("carries the session name and every spec verbatim", () => {
    const prompt = buildSessionPrompt("implement quotes", SPECS);
    expect(prompt).toContain("SpecDriven code gen session: implement quotes");
    for (const spec of SPECS) {
      expect(prompt).toContain(`## Spec: ${spec.fileName}`);
      expect(prompt).toContain(spec.content.trimEnd());
    }
  });

  test("says specification for one spec, specifications for several", () => {
    expect(buildSessionPrompt("s", [SPECS[0]!])).toContain("the following specification.");
    expect(buildSessionPrompt("s", SPECS)).toContain("the following specifications.");
  });

  // A spec cut down to selected scenarios says so in its heading, so Claude
  // doesn't take the excerpt for the whole file.
  test("a partial spec's heading marks it as selected scenarios only", () => {
    const prompt = buildSessionPrompt("s", [{ ...SPECS[0]!, partial: true }, SPECS[1]!]);
    expect(prompt).toContain("## Spec: billing/quotes.feature.md (selected scenarios only)");
    expect(prompt).toContain("## Spec: search.feature.md\n");
  });
});

describe("runCodeGenSession", () => {
  test("passes the prompt to the CLI in print mode, in the data dir", async () => {
    const { runner, calls } = fakeRunner({ stdout: "done\n" });
    const result = await runCodeGenSession("/data", "implement quotes", SPECS, runner);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(CLAUDE_BIN);
    expect(calls[0]!.args[0]).toBe("-p");
    expect(calls[0]!.args[1]).toBe(buildSessionPrompt("implement quotes", SPECS));
    expect(calls[0]!.options?.cwd).toBe("/data");
    expect(result).toEqual({ name: "implement quotes", output: "done\n" });
  });

  test("an error code becomes an error carrying the CLI's words", async () => {
    const { runner } = fakeRunner({ exitCode: 2, stderr: "no API key\n" });
    expect(runCodeGenSession("/data", "s", SPECS, runner)).rejects.toThrow(
      "Claude exited with code 2: no API key",
    );
  });

  test("a silent failure still reports the exit code", async () => {
    const { runner } = fakeRunner({ exitCode: 1 });
    expect(runCodeGenSession("/data", "s", SPECS, runner)).rejects.toThrow(
      "Claude exited with code 1",
    );
  });

  test("stdout stands in when stderr is empty", async () => {
    const { runner } = fakeRunner({ exitCode: 3, stdout: "usage: claude …\n" });
    expect(runCodeGenSession("/data", "s", SPECS, runner)).rejects.toThrow(
      "Claude exited with code 3: usage: claude …",
    );
  });
});

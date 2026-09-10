// Automates specs/agents/claude.spec.md: a named code gen session builds
// one prompt from the selected specs, for the agent it runs in. And
// specs/roadmap/start-session-in-claude-code-desktop.md: the prompt opens as
// a new session in Claude Code Desktop — saved to disk, with a short
// bootstrap prompt in the deep link that titles the session; a failed launch
// surfaces as an error for the error box.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDesktopBootstrapPrompt,
  buildSessionPrompt,
  claudeDesktopInstalled,
  claudeDesktopUrl,
  CLAUDE_DESKTOP_PROMPT_MAX,
  DESKTOP_AGENT,
  desktopOpener,
  launchDesktopSession,
  SESSION_TITLE_MAX,
  sessionTitle,
} from "../src/server/agent";
import type { Runner, SpecInput } from "../src/server/agent";
import type { RunOptions, RunResult } from "../src/server/run";

const SPECS: SpecInput[] = [
  { fileName: "specs/billing/quotes.feature.md", content: "# Quotes\n\n## Basic quote @v1\n" },
  { fileName: "specs/search.feature.md", content: "# Search\n\nRanked hits.\n" },
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

  // With a code repo the session runs away from the specs, so the prompt
  // says where they are and that the code is what to change.
  test("a code repo session is told where the specs live", () => {
    const apart = buildSessionPrompt("s", SPECS, { dataRepo: "/data", codeRepo: "/code" });
    expect(apart).toContain("The current directory is the code repository.");
    expect(apart).toContain("data repository at /data");
    expect(apart).toContain("edit the code, not the specifications");
    const together = buildSessionPrompt("s", SPECS, { dataRepo: "/data" });
    expect(together).not.toContain("code repository");
    expect(together).toBe(buildSessionPrompt("s", SPECS));
  });

  // A spec cut down to selected scenarios says so in its heading, so Claude
  // doesn't take the excerpt for the whole file.
  test("a partial spec's heading marks it as selected scenarios only", () => {
    const prompt = buildSessionPrompt("s", [{ ...SPECS[0]!, partial: true }, SPECS[1]!]);
    expect(prompt).toContain("## Spec: specs/billing/quotes.feature.md (selected scenarios only)");
    expect(prompt).toContain("## Spec: specs/search.feature.md\n");
  });
});

// Claude Code Desktop (specs/roadmap/start-session-in-claude-code-desktop.md):
// the `q` of the deep link is a short bootstrap — Claude.app slices it, so
// the specs themselves never travel in the url — and it carries the title
// instruction, which is how the user's name survives the hand-off.
describe("buildDesktopBootstrapPrompt", () => {
  const PROMPT_PATH = "/Users/me/.specdriven/sessions/abc/prompt.md";

  test("names the session, asks for the title, points at the prompt file", () => {
    const text = buildDesktopBootstrapPrompt("implement quotes", PROMPT_PATH);
    expect(text).toContain("SpecDriven code gen session: implement quotes");
    expect(text).toContain('First set this session\'s title to "implement quotes".');
    expect(text).toContain(`read the session prompt at ${PROMPT_PATH}`);
    expect(text).toContain("Work in the current directory and exit when done.");
  });

  test("stays far below the desktop's prompt cap, even with a long name", () => {
    const text = buildDesktopBootstrapPrompt("x".repeat(1000), PROMPT_PATH);
    expect(text.length).toBeLessThan(CLAUDE_DESKTOP_PROMPT_MAX / 10);
  });

  // The router rejects a `q` that starts with "/" as a slash command.
  test("never starts with a slash, whatever the name", () => {
    for (const name of ["/clear", "//x", "/"]) {
      expect(buildDesktopBootstrapPrompt(name, PROMPT_PATH).startsWith("/")).toBe(false);
    }
  });

  test("the title is one escaped line, cut at the maximum", () => {
    expect(sessionTitle('say "hi"\nthen\tgo')).toBe('say \\"hi\\" then go');
    expect(sessionTitle("  padded  ")).toBe("padded");
    expect(sessionTitle("y".repeat(500))).toHaveLength(SESSION_TITLE_MAX);
    expect(buildDesktopBootstrapPrompt("a\nb", PROMPT_PATH)).toContain('title to "a b".');
  });
});

describe("claudeDesktopUrl", () => {
  test("is claude://code/new with q and folder that decode back", () => {
    const bootstrap = "First set the title to \"A & B #1\".\nThen read /tmp/p.md";
    const folder = "/Users/me/my specs";
    const url = new URL(claudeDesktopUrl(bootstrap, folder));
    expect(url.protocol).toBe("claude:");
    expect(url.host).toBe("code");
    expect(url.pathname).toBe("/new");
    expect(url.searchParams.get("q")).toBe(bootstrap);
    expect(url.searchParams.get("folder")).toBe(folder);
    expect(url.hash).toBe("");
    // Spaces are %20, not "+": not every reader treats "+" as a space.
    expect(url.search).not.toContain("+");
  });
});

describe("desktopOpener", () => {
  test("hands the url to the platform's opener", () => {
    expect(desktopOpener("darwin").cmd).toBe("open");
    expect(desktopOpener("darwin").args("claude://x")).toEqual(["claude://x"]);
    expect(desktopOpener("linux").cmd).toBe("xdg-open");
    expect(desktopOpener("win32").args("claude://x")).toEqual(["/c", "start", "", "claude://x"]);
    expect(() => desktopOpener("sunos")).toThrow();
  });
});

describe("claudeDesktopInstalled", () => {
  test("looks for Claude.app in /Applications and ~/Applications on macOS", () => {
    const seen: string[] = [];
    const only = (path: string) => (p: string) => {
      seen.push(p);
      return p === path;
    };
    expect(claudeDesktopInstalled("darwin", only("/Applications/Claude.app"), "/Users/me")).toBe(true);
    expect(
      claudeDesktopInstalled("darwin", only("/Users/me/Applications/Claude.app"), "/Users/me"),
    ).toBe(true);
    expect(claudeDesktopInstalled("darwin", () => false, "/Users/me")).toBe(false);
    expect(seen).toContain("/Users/me/Applications/Claude.app");
  });

  test("is off on other platforms for now", () => {
    expect(claudeDesktopInstalled("linux", () => true, "/home/me")).toBe(false);
    expect(claudeDesktopInstalled("win32", () => true, "C:\\Users\\me")).toBe(false);
  });
});

describe("launchDesktopSession", () => {
  const ID = "13213666-0000-4000-8000-000000000000";
  const NOW = new Date("2026-09-04T22:30:30.000Z");

  async function withSessionsDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "specdriven-sessions-"));
    try {
      return await body(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("saves the prompt and a session record, then opens the deep link", async () =>
    withSessionsDir(async (sessionsDir) => {
      const { runner, calls } = fakeRunner({});
      const result = await launchDesktopSession("/data", "implement quotes", SPECS, {
        sessionsDir,
        runner,
        platform: "darwin",
        id: ID,
        now: NOW,
      });
      const promptPath = join(sessionsDir, ID, "prompt.md");
      expect(result).toEqual({ name: "implement quotes", id: ID, promptPath });
      expect(await readFile(promptPath, "utf8")).toBe(buildSessionPrompt("implement quotes", SPECS));
      expect(JSON.parse(await readFile(join(sessionsDir, ID, "session.json"), "utf8"))).toEqual({
        id: ID,
        name: "implement quotes",
        startedAt: NOW.toISOString(),
        agent: DESKTOP_AGENT,
        dataRepo: "/data",
        specs: [
          { fileName: "specs/billing/quotes.feature.md", partial: false },
          { fileName: "specs/search.feature.md", partial: false },
        ],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cmd).toBe("open");
      expect(calls[0]!.options?.cwd).toBe("/data");
      const url = new URL(calls[0]!.args[0]!);
      expect(url.host).toBe("code");
      expect(url.searchParams.get("folder")).toBe("/data");
      expect(url.searchParams.get("q")).toBe(
        buildDesktopBootstrapPrompt("implement quotes", promptPath),
      );
    }));

  test("a code repo is where the session opens, and the record names it", async () =>
    withSessionsDir(async (sessionsDir) => {
      const { runner, calls } = fakeRunner({});
      await launchDesktopSession(
        { dataRepo: "/data", codeRepo: "/code" },
        "s",
        SPECS,
        { sessionsDir, runner, platform: "darwin", id: ID, now: NOW },
      );
      const record = JSON.parse(await readFile(join(sessionsDir, ID, "session.json"), "utf8"));
      expect(record.dataRepo).toBe("/data");
      expect(record.codeRepo).toBe("/code");
      expect(calls[0]!.options?.cwd).toBe("/code");
      expect(new URL(calls[0]!.args[0]!).searchParams.get("folder")).toBe("/code");
      expect(await readFile(join(sessionsDir, ID, "prompt.md"), "utf8")).toBe(
        buildSessionPrompt("s", SPECS, { dataRepo: "/data", codeRepo: "/code" }),
      );
    }));

  test("a partial spec is recorded as such", async () =>
    withSessionsDir(async (sessionsDir) => {
      const { runner } = fakeRunner({});
      await launchDesktopSession("/data", "s", [{ ...SPECS[0]!, partial: true }], {
        sessionsDir,
        runner,
        platform: "darwin",
        id: ID,
      });
      const record = JSON.parse(await readFile(join(sessionsDir, ID, "session.json"), "utf8"));
      expect(record.specs).toEqual([{ fileName: "specs/billing/quotes.feature.md", partial: true }]);
      expect(typeof record.startedAt).toBe("string");
    }));

  test("a failed opener becomes an error carrying its words", async () =>
    withSessionsDir(async (sessionsDir) => {
      const { runner } = fakeRunner({
        exitCode: 1,
        stderr: "No application knows how to open URL claude://code/new\n",
      });
      expect(
        launchDesktopSession("/data", "s", SPECS, { sessionsDir, runner, platform: "darwin" }),
      ).rejects.toThrow("Could not open Claude Code Desktop: No application knows how to open URL");
    }));
});

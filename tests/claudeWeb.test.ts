// A session in Claude Code on the web (src/frontend/claudeWeb.ts): the link
// that carries the prompt, and what one click does with the tab and the
// clipboard. The browser's parts are passed in, so there is no DOM here.
import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CODE_LINK_MAX,
  CLAUDE_CODE_LINK_MAX_WINDOWS_DESKTOP,
  CLAUDE_CODE_WEB_URL,
  claudeCodeWebUrl,
  claudeWebEnv,
  openPendingTab,
  startClaudeWebSession,
} from "../src/frontend/claudeWeb";
import type { ClaudeWebStart } from "../src/frontend/claudeWeb";

const SHORT = "SpecDriven code gen session: Quote\n\nImplement a & b.\n";
const LONG = "x".repeat(CLAUDE_CODE_LINK_MAX);

/** A run with everything stubbed, and a log of what happened in which order. */
function run(over: Partial<ClaudeWebStart> & { prompt: Promise<string> }, tabBlocked = false) {
  const log: string[] = [];
  const start: ClaudeWebStart = {
    copy: async (text) => {
      log.push("copy asked");
      await text;
      log.push("copied");
      return true;
    },
    openPending: () => {
      log.push("tab opened");
      if (tabBlocked) return null;
      return { go: (url) => log.push(`tab to ${url}`), close: () => log.push("tab closed") };
    },
    openUrl: (url) => log.push(`browser to ${url}`),
    desktop: false,
    max: CLAUDE_CODE_LINK_MAX,
    ...over,
  };
  return { log, outcome: startClaudeWebSession(start) };
}

describe("claudeCodeWebUrl", () => {
  test("the prompt rides in q with its newlines, spaces and ampersands encoded", () => {
    expect(claudeCodeWebUrl("hello!")).toBe("https://claude.ai/code?q=hello!");
    const url = claudeCodeWebUrl(SHORT)!;
    expect(url.startsWith(`${CLAUDE_CODE_WEB_URL}?q=`)).toBe(true);
    expect(url).not.toMatch(/[\n +]/);
    expect(new URL(url).searchParams.get("q")).toBe(SHORT);
  });

  test("a prompt whose link would pass the cap gets no link", () => {
    const fits = "y".repeat(CLAUDE_CODE_LINK_MAX - `${CLAUDE_CODE_WEB_URL}?q=`.length);
    expect(claudeCodeWebUrl(fits)).toHaveLength(CLAUDE_CODE_LINK_MAX);
    expect(claudeCodeWebUrl(`${fits}y`)).toBeNull();
    // A newline is three characters of link, so the cap counts the link, not the prompt.
    expect(claudeCodeWebUrl("\n".repeat(CLAUDE_CODE_LINK_MAX / 2))).toBeNull();
    expect(claudeCodeWebUrl("hello", 10)).toBeNull();
  });
});

describe("claudeWebEnv", () => {
  test("the desktop app is told apart, and on Windows its links are short", () => {
    expect(claudeWebEnv("Mozilla/5.0 (Macintosh) Chrome/140 Safari/537")).toEqual({
      desktop: false,
      max: CLAUDE_CODE_LINK_MAX,
    });
    expect(claudeWebEnv("Mozilla/5.0 (Macintosh) SpecDriven/0.1 Electron/44.9.3")).toEqual({
      desktop: true,
      max: CLAUDE_CODE_LINK_MAX,
    });
    expect(claudeWebEnv("Mozilla/5.0 (Windows NT 10.0) Electron/44.9.3")).toEqual({
      desktop: true,
      max: CLAUDE_CODE_LINK_MAX_WINDOWS_DESKTOP,
    });
    // A browser on Windows opens its own tabs, with a browser's limits.
    expect(claudeWebEnv("Mozilla/5.0 (Windows NT 10.0) Chrome/140").max).toBe(CLAUDE_CODE_LINK_MAX);
  });
});

describe("openPendingTab", () => {
  test("an empty tab opens at once, without a handle on the app, and goes where it is sent", () => {
    const calls: string[] = [];
    const tab = {
      opener: {} as unknown,
      location: { replace: (url: string) => void calls.push(`replace ${url}`) },
      close: () => void calls.push("close"),
    };
    const pending = openPendingTab((url, target) => {
      calls.push(`open ${url} ${target}`);
      return tab;
    })!;
    expect(calls).toEqual(["open about:blank _blank"]);
    expect(tab.opener).toBeNull();
    pending.go("https://claude.ai/code?q=hi");
    pending.close();
    expect(calls.slice(1)).toEqual(["replace https://claude.ai/code?q=hi", "close"]);
  });

  test("a blocked pop-up is no tab", () => {
    expect(openPendingTab(() => null)).toBeNull();
  });
});

describe("startClaudeWebSession", () => {
  test("in a browser the copy is asked for and the tab opened before the prompt is there", async () => {
    let arrive!: (text: string) => void;
    const { log, outcome } = run({ prompt: new Promise<string>((resolve) => (arrive = resolve)) });
    // Both happened in the click's own turn, the prompt still on its way.
    expect(log).toEqual(["copy asked", "tab opened"]);
    arrive(SHORT);
    const url = claudeCodeWebUrl(SHORT)!;
    expect(await outcome).toEqual({ kind: "opened", url });
    expect(log).toContain(`tab to ${url}`);
  });

  test("a prompt that fits its link opens Claude Code with it, copied or not", async () => {
    const { log, outcome } = run({ prompt: Promise.resolve(SHORT), copy: async () => false });
    const url = claudeCodeWebUrl(SHORT)!;
    expect(await outcome).toEqual({ kind: "opened", url });
    expect(log).toEqual(["tab opened", `tab to ${url}`]);
  });

  test("a prompt too long for a link is pasted, the tab on Claude Code without it", async () => {
    const { log, outcome } = run({ prompt: Promise.resolve(LONG) });
    expect(await outcome).toEqual({ kind: "paste", url: CLAUDE_CODE_WEB_URL });
    expect(log.at(-1)).toBe(`tab to ${CLAUDE_CODE_WEB_URL}`);
    expect(log.indexOf("copied")).toBeLessThan(log.indexOf(`tab to ${CLAUDE_CODE_WEB_URL}`));
  });

  test("too long and not copied closes the tab and hands the prompt back to copy", async () => {
    const { log, outcome } = run({ prompt: Promise.resolve(LONG), copy: async () => false });
    expect(await outcome).toEqual({ kind: "copy", prompt: LONG });
    expect(log).toEqual(["tab opened", "tab closed"]);
  });

  test("a blocked tab leaves a link, with the prompt when it fits and to paste into when not", async () => {
    const fits = run({ prompt: Promise.resolve(SHORT) }, true);
    expect(await fits.outcome).toEqual({ kind: "link", url: claudeCodeWebUrl(SHORT)!, paste: false });
    const long = run({ prompt: Promise.resolve(LONG) }, true);
    expect(await long.outcome).toEqual({ kind: "link", url: CLAUDE_CODE_WEB_URL, paste: true });
    const neither = run({ prompt: Promise.resolve(LONG), copy: async () => false }, true);
    expect(await neither.outcome).toEqual({ kind: "copy", prompt: LONG });
  });

  test("a prompt that fails to build closes the tab and throws its own error", async () => {
    const failed = Promise.reject(new Error("spec not found"));
    const { log, outcome } = run({
      prompt: failed,
      // copyWhenReady throws the text's failure too; it is reported once.
      copy: async (text) => {
        await text;
        return true;
      },
    });
    await expect(outcome).rejects.toThrow("spec not found");
    expect(log).toEqual(["tab opened", "tab closed"]);
  });

  test("the desktop app opens no tab ahead, and the browser only once the prompt is copied", async () => {
    let arrive!: (text: string) => void;
    const { log, outcome } = run({
      prompt: new Promise<string>((resolve) => (arrive = resolve)),
      desktop: true,
    });
    expect(log).toEqual(["copy asked"]);
    arrive(SHORT);
    const url = claudeCodeWebUrl(SHORT)!;
    expect(await outcome).toEqual({ kind: "opened", url });
    expect(log).toEqual(["copy asked", "copied", `browser to ${url}`]);
  });

  test("the desktop app pastes a long prompt, and opens nothing when it could not copy it", async () => {
    const pasted = run({ prompt: Promise.resolve(LONG), desktop: true });
    expect(await pasted.outcome).toEqual({ kind: "paste", url: CLAUDE_CODE_WEB_URL });
    expect(pasted.log.at(-1)).toBe(`browser to ${CLAUDE_CODE_WEB_URL}`);
    const stuck = run({ prompt: Promise.resolve(LONG), desktop: true, copy: async () => false });
    expect(await stuck.outcome).toEqual({ kind: "copy", prompt: LONG });
    expect(stuck.log).toEqual([]);
    // The short Windows cap sends a prompt a browser would link to the clipboard.
    const windows = run({ prompt: Promise.resolve("z".repeat(3000)), desktop: true, max: CLAUDE_CODE_LINK_MAX_WINDOWS_DESKTOP });
    expect((await windows.outcome).kind).toBe("paste");
  });
});

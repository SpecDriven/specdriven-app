// A session in Claude Code on the web (specs/app/launch-ai-agent-session
// .feature.md, specs/app/hosted-app.feature.md): the app runs nothing — it
// opens claude.ai/code in the person's own browser, where they are signed
// in, with the prompt in the link's `q`. claude.ai cannot be framed or
// called from another site, so a link the browser opens is the only way in.
// The prompt is copied as well: it holds the specs' full text and can outgrow
// a link, and then it is pasted.
//
// Pure, with the browser's parts passed in, so bun test runs it without a
// DOM (tests/claudeWeb.test.ts); the server imports the target's name.

/** The "Run in" value, and the stored session target, for Claude Code on the web. */
export const CLAUDE_WEB_TARGET = "claude-web";

/** Claude Code on the web; `?q=` carries a prompt into its box. */
export const CLAUDE_CODE_WEB_URL = "https://claude.ai/code";

/**
 * The longest link the prompt may ride in, in characters of the whole link.
 * `?q=` is not in Anthropic's documentation, so neither is its limit; this
 * is a guess kept well under what proxies in front of a site accept. Past
 * it the prompt is pasted from the clipboard instead.
 */
export const CLAUDE_CODE_LINK_MAX = 8000;

/** The desktop app on Windows hands links to the shell, which takes about 2,000 characters. */
export const CLAUDE_CODE_LINK_MAX_WINDOWS_DESKTOP = 2000;

/** What to call the destination in labels and notes. */
export const CLAUDE_WEB_LABEL = "Claude Code on the web";

/**
 * The link that opens Claude Code with the prompt in its box, or null when
 * the link would pass `max`. encodeURIComponent, as claudeDesktopUrl does
 * (src/server/agent.ts): "+" for a space is not what every reader decodes.
 */
export function claudeCodeWebUrl(prompt: string, max: number = CLAUDE_CODE_LINK_MAX): string | null {
  const url = `${CLAUDE_CODE_WEB_URL}?q=${encodeURIComponent(prompt)}`;
  return url.length <= max ? url : null;
}

/**
 * Where the app runs, as far as opening a link goes. In the desktop app
 * window.open never opens a window: an http(s) url goes to the default
 * browser and anything else is dropped (src/electron/linkRouting.ts), so
 * there is no tab to open ahead of the prompt, and no pop-up blocker either.
 */
export function claudeWebEnv(userAgent: string): { desktop: boolean; max: number } {
  const desktop = userAgent.includes("Electron");
  return {
    desktop,
    max: desktop && userAgent.includes("Windows") ? CLAUDE_CODE_LINK_MAX_WINDOWS_DESKTOP : CLAUDE_CODE_LINK_MAX,
  };
}

/** A tab opened during the click, before there is anywhere to send it. */
export interface PendingTab {
  go(url: string): void;
  close(): void;
}

/** The little of a window a pending tab needs. */
interface TabWindow {
  opener: unknown;
  location: { replace(url: string): void };
  close(): void;
}

/**
 * Open an empty tab now, to point at Claude once the prompt is built: a
 * browser lets a click open a tab, but not what the click's fetch does
 * later (Safari above all). Null when the browser blocked it. The tab never
 * gets a handle on this window.
 */
export function openPendingTab(
  open: (url: string, target: string) => TabWindow | null = (url, target) => window.open(url, target),
): PendingTab | null {
  const tab = open("about:blank", "_blank");
  if (!tab) return null;
  tab.opener = null;
  return {
    go: (url) => tab.location.replace(url),
    close: () => tab.close(),
  };
}

export interface ClaudeWebStart {
  /** The prompt, still on its way from the server. */
  prompt: Promise<string>;
  /** Copy a text still on its way — copyWhenReady (src/frontend/clipboard.ts). */
  copy: (text: Promise<string>) => Promise<boolean>;
  /** A browser: the empty tab, opened in the click. Null when blocked. */
  openPending: () => PendingTab | null;
  /** The desktop app: hand a url to the default browser. */
  openUrl: (url: string) => void;
  desktop: boolean;
  max: number;
}

export type ClaudeWebOutcome =
  /** Claude Code is open with the prompt in its box. */
  | { kind: "opened"; url: string }
  /** Claude Code is open; the prompt was too long for a link and is on the clipboard. */
  | { kind: "paste"; url: string }
  /** The browser blocked the tab: a link to click, to paste into when `paste`. */
  | { kind: "link"; url: string; paste: boolean }
  /** Too long for a link and not copied either: nothing opened, the prompt is in hand to copy. */
  | { kind: "copy"; prompt: string };

/**
 * Start a session in Claude Code on the web. Call it in the click's own
 * turn, before any await: the clipboard is handed the prompt and the tab is
 * opened while the click still counts. A prompt that fails to arrive closes
 * the tab and is thrown.
 */
export async function startClaudeWebSession(start: ClaudeWebStart): Promise<ClaudeWebOutcome> {
  // A failed prompt fails the copy too; it is thrown once, below.
  const copied = start.copy(start.prompt).catch(() => false);
  const tab = start.desktop ? null : start.openPending();
  let prompt: string;
  try {
    prompt = await start.prompt;
  } catch (e) {
    tab?.close();
    throw e;
  }
  const link = claudeCodeWebUrl(prompt, start.max);
  if (start.desktop) {
    // Nothing blocks the default browser, so the copy is let finish first:
    // the browser coming forward takes the focus a clipboard write wants.
    const ok = await copied;
    if (link) {
      start.openUrl(link);
      return { kind: "opened", url: link };
    }
    if (!ok) return { kind: "copy", prompt };
    start.openUrl(CLAUDE_CODE_WEB_URL);
    return { kind: "paste", url: CLAUDE_CODE_WEB_URL };
  }
  if (tab && link) {
    tab.go(link);
    return { kind: "opened", url: link };
  }
  const ok = await copied;
  if (!tab) {
    if (link) return { kind: "link", url: link, paste: false };
    return ok ? { kind: "link", url: CLAUDE_CODE_WEB_URL, paste: true } : { kind: "copy", prompt };
  }
  if (!ok) {
    tab.close();
    return { kind: "copy", prompt };
  }
  tab.go(CLAUDE_CODE_WEB_URL);
  return { kind: "paste", url: CLAUDE_CODE_WEB_URL };
}

// The line under the session button after a session went to Claude Code on
// the web (src/frontend/ClaudeWebNote.tsx). Static markup only — bun test
// has no DOM.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaudeWebNote } from "../src/frontend/ClaudeWebNote";
import { CLAUDE_CODE_WEB_URL, claudeCodeWebUrl } from "../src/frontend/claudeWeb";
import type { ClaudeWebOutcome } from "../src/frontend/claudeWeb";

const noop = () => undefined;
const note = (outcome: ClaudeWebOutcome, desktop = false) =>
  renderToStaticMarkup(<ClaudeWebNote outcome={outcome} desktop={desktop} onCopy={noop} />);

describe("ClaudeWebNote", () => {
  test("says the tab is open and what is left to do there", () => {
    const opened = note({ kind: "opened", url: claudeCodeWebUrl("hi")! });
    expect(opened).toBe("Opened in Claude Code in a new tab — pick the repository and send.");
    const pasted = note({ kind: "paste", url: CLAUDE_CODE_WEB_URL });
    expect(pasted).toContain("too long for a link");
    expect(pasted).toContain("paste it into Claude Code, opened in a new tab");
  });

  test("the desktop app says the browser, not a tab", () => {
    expect(note({ kind: "opened", url: claudeCodeWebUrl("hi")! }, true)).toContain("in your browser");
    expect(note({ kind: "paste", url: CLAUDE_CODE_WEB_URL }, true)).toContain("opened in your browser");
  });

  test("a blocked tab leaves a link that opens Claude Code in a tab of its own", () => {
    const url = claudeCodeWebUrl("a & b")!;
    const withPrompt = note({ kind: "link", url, paste: false });
    expect(withPrompt).toContain(`<a href="${url.replace(/&/g, "&amp;")}" target="_blank" rel="noreferrer">open Claude Code</a>`);
    expect(withPrompt).toContain("blocked the new tab");
    const toPaste = note({ kind: "link", url: CLAUDE_CODE_WEB_URL, paste: true });
    expect(toPaste).toContain(`<a href="${CLAUDE_CODE_WEB_URL}" target="_blank" rel="noreferrer">open Claude Code</a>`);
    expect(toPaste).toContain("Prompt copied");
    expect(toPaste).toContain("paste it");
  });

  test("a prompt that went nowhere offers one classed button to copy it", () => {
    const stuck = note({ kind: "copy", prompt: "x" });
    expect(stuck).toContain("could not be copied");
    expect(stuck).toContain('<button type="button" class="btn btn-secondary">Copy prompt</button>');
    expect(stuck).not.toContain("<a ");
  });
});

// The line under the session button once a session was sent to Claude Code
// on the web (src/frontend/claudeWeb.ts): what happened, and — where the
// browser would not open the tab or take the copy — the one thing left to
// click. Pure markup, so bun test renders it without a DOM.

import type { ClaudeWebOutcome } from "./claudeWeb";

export function ClaudeWebNote({
  outcome,
  desktop,
  onCopy,
}: {
  outcome: ClaudeWebOutcome;
  /** The desktop app opens the default browser, not a tab of its own. */
  desktop: boolean;
  /** Copy a prompt that is in hand, from the click on the note's button. */
  onCopy: (prompt: string) => void;
}) {
  const where = desktop ? "in your browser" : "in a new tab";
  switch (outcome.kind) {
    case "opened":
      // "Send" is theirs: a link fills the box, it does not start the work.
      return <>Opened in Claude Code {where} — pick the repository and send.</>;
    case "paste":
      return <>Prompt copied — it is too long for a link; paste it into Claude Code, opened {where}.</>;
    case "link":
      return outcome.paste ? (
        <>
          Prompt copied —{" "}
          <a href={outcome.url} target="_blank" rel="noreferrer">
            open Claude Code
          </a>{" "}
          and paste it.
        </>
      ) : (
        <>
          The browser blocked the new tab —{" "}
          <a href={outcome.url} target="_blank" rel="noreferrer">
            open Claude Code
          </a>{" "}
          with the prompt.
        </>
      );
    case "copy":
      return (
        <>
          The prompt is too long for a link and could not be copied.{" "}
          <button type="button" className="btn btn-secondary" onClick={() => onCopy(outcome.prompt)}>
            Copy prompt
          </button>
        </>
      );
  }
}

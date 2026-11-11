// The agent pane's account chip (specs/agents/agent-pane.feature.md "The
// pane header says whether the agent spends an account or the API"): the
// header always shows the plug (API) or the person (an account), and the
// tooltip says which, then keeps the agent's words.
import { expect, test } from "bun:test";
import { accountChipDetail, accountChipKind, accountChipWord } from "../src/frontend/agentAccount";
import type { ChatAccount } from "../src/server/agentTypes";

test("the account chip shows the plug for a key, a token, a proxy or a provider, the person for an account", () => {
  const chip = (billing: ChatAccount["billing"], label: string) => accountChipKind({ billing, label, detail: "" });
  expect(chip("api", "API:PROXY")).toBe("api");
  expect(chip("api", "Auth token")).toBe("api");
  expect(chip("api", "API billing")).toBe("api");
  expect(chip("provider", "Amazon Bedrock")).toBe("api");
  expect(chip("plan", "Claude Max")).toBe("account");
  expect(chip("plan", "Claude plan")).toBe("account");
  expect(chip("none", "Not logged in")).toBe("account");
});

test("the account chip's tooltip says API or Account, then the sign-in, who and where from, once", () => {
  expect(
    accountChipDetail({ billing: "plan", label: "Claude Max", detail: "Claude subscription · a@b.c · credential: claude.ai login" }),
  ).toBe("Account · Claude Max · Claude subscription · a@b.c · credential: claude.ai login");
  expect(accountChipDetail({ billing: "api", label: "API:PROXY", detail: "API:localhost:4000" })).toBe(
    "API:PROXY · API:localhost:4000",
  );
  expect(
    accountChipDetail({ billing: "none", label: "Not logged in", detail: "Not logged in — sign in in Settings" }),
  ).toBe("Account · Not logged in — sign in in Settings");
  // The agent's own words already lead with the word: it is not said twice.
  expect(accountChipDetail({ billing: "api", label: "API billing", detail: "" })).toBe("API billing");
  expect(accountChipDetail({ billing: "provider", label: "Amazon Bedrock", detail: "" })).toBe("API · Amazon Bedrock");
  expect(accountChipDetail({ billing: "plan", label: "Account", detail: "" })).toBe("Account");
  // The same word names the chip for a screen reader, the icon being silent.
  expect(accountChipWord({ billing: "provider", label: "Amazon Bedrock", detail: "" })).toBe("API");
  expect(accountChipWord({ billing: "api", label: "API:PROXY", detail: "" })).toBe("API");
  expect(accountChipWord({ billing: "plan", label: "Claude Max", detail: "" })).toBe("Account");
  expect(accountChipWord({ billing: "none", label: "Not logged in", detail: "" })).toBe("Account");
});

// --- The chip with no session open --------------------------------------------

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AgentPane, pickedAgent } from "../src/frontend/AgentPane";
import { agentChat, agentChatState } from "../src/frontend/agentChat";
import { CLAUDE_AGENT, CODEX_AGENT } from "./fixtures/agents";

const paneHtml = () =>
  renderToStaticMarkup(
    createElement(AgentPane, { compact: false, demo: false, codeRepo: "/w/code", dataRepo: "/w/data", onClose: () => {} }),
  );
/** The account chip's own markup: the span and the icon inside it. */
const chipHtml = (html: string) => html.match(/<span class="chip muted agent-account"[\s\S]*?<\/span>/)?.[0] ?? "";
const choicesWith = (account?: ChatAccount) => ({ models: [], model: null, effort: null, ...(account ? { account } : {}) });

test("with no session open, the header shows the plug or the person for the agent a new session starts on", () => {
  agentChat.setAgents([CLAUDE_AGENT, CODEX_AGENT]);
  try {
    agentChat.setChoices("claude", choicesWith({ billing: "api", label: "API:PROXY", detail: "API calls go to localhost:6655" }));
    let html = paneHtml();
    expect(html).toContain("Coding agent");
    let chip = chipHtml(html);
    expect(chip).toMatch(/data-kind="api" data-billing="api"[^>]*aria-label="API: API:PROXY"/);
    expect(chip).toContain("lucide-plug");
    // An icon alone: the words are the tooltip's and the accessible name's.
    expect(chip).not.toMatch(/>\s*(API|ACNT)\s*</);
    agentChat.setChoices("claude", choicesWith({ billing: "none", label: "Not logged in", detail: "Sign in…" }));
    html = paneHtml();
    chip = chipHtml(html);
    expect(chip).toMatch(/data-kind="account" data-billing="none"[^>]*aria-label="Account: Not logged in"/);
    expect(chip).toContain("lucide-circle-user-round");
    expect(chip).not.toContain("lucide-plug");
    // An agent that cannot say yet shows nothing rather than a guess.
    agentChat.setChoices("claude", choicesWith());
    expect(paneHtml()).not.toContain("agent-account");
  } finally {
    agentChat.setChoices("claude", undefined);
    agentChat.setAgents([]);
  }
});

test("the header's agent with no session is the one picked, while usable, else the first usable", () => {
  const agents = [CODEX_AGENT, CLAUDE_AGENT];
  expect(pickedAgent(agents, null)?.id).toBe("claude");
  expect(pickedAgent(agents, "codex")?.id).toBe("codex");
  expect(pickedAgent(agents, "gone")?.id).toBe("claude");
  expect(pickedAgent([{ ...CLAUDE_AGENT, available: false }], null)).toBeNull();
});

test("a sign-in change asks again for every list already loaded, so the chip follows it", async () => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return Response.json({ choices: choicesWith({ billing: "plan", label: "Claude account", detail: "Claude account" }) });
  }) as unknown as typeof fetch;
  try {
    agentChat.setChoices("claude", choicesWith({ billing: "api", label: "API", detail: "" }));
    await agentChat.reloadChoices();
    expect(asked).toEqual(["/api/agent/agents/claude/choices"]);
    expect(accountChipKind(agentChatState().choices.claude!.account!)).toBe("account");
  } finally {
    globalThis.fetch = realFetch;
    agentChat.setChoices("claude", undefined);
  }
});

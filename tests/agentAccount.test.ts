// The agent pane's account chip (specs/agents/agent-pane.feature.md "The
// pane header says whether the agent spends an account or the API"): the
// header always reads API or ACNT, and the tooltip keeps the agent's words.
import { expect, test } from "bun:test";
import { accountChipDetail, accountChipText } from "../src/frontend/agentAccount";
import type { ChatAccount } from "../src/server/agentTypes";

test("the account chip reads API for a key, a token, a proxy or a provider, ACNT for an account", () => {
  const chip = (billing: ChatAccount["billing"], label: string) => accountChipText({ billing, label, detail: "" });
  expect(chip("api", "API:PROXY")).toBe("API");
  expect(chip("api", "Auth token")).toBe("API");
  expect(chip("api", "API billing")).toBe("API");
  expect(chip("provider", "Amazon Bedrock")).toBe("API");
  expect(chip("plan", "Claude Max")).toBe("ACNT");
  expect(chip("plan", "Claude plan")).toBe("ACNT");
  expect(chip("none", "Not logged in")).toBe("ACNT");
});

test("the account chip's tooltip names the sign-in, then who and where from, once", () => {
  expect(
    accountChipDetail({ billing: "plan", label: "Claude Max", detail: "Claude subscription · a@b.c · credential: claude.ai login" }),
  ).toBe("Claude Max · Claude subscription · a@b.c · credential: claude.ai login");
  expect(accountChipDetail({ billing: "api", label: "API:PROXY", detail: "API:localhost:4000" })).toBe(
    "API:PROXY · API:localhost:4000",
  );
  expect(
    accountChipDetail({ billing: "none", label: "Not logged in", detail: "Not logged in — sign in in Settings" }),
  ).toBe("Not logged in — sign in in Settings");
  expect(accountChipDetail({ billing: "api", label: "API billing", detail: "" })).toBe("API billing");
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
const choicesWith = (account?: ChatAccount) => ({ models: [], model: null, effort: null, ...(account ? { account } : {}) });

test("with no session open, the header shows API or ACNT for the agent a new session starts on", () => {
  agentChat.setAgents([CLAUDE_AGENT, CODEX_AGENT]);
  try {
    agentChat.setChoices("claude", choicesWith({ billing: "api", label: "API:PROXY", detail: "API calls go to localhost:6655" }));
    let html = paneHtml();
    expect(html).toContain("Coding agent");
    expect(html).toMatch(/class="chip muted agent-account" data-billing="api"[^>]*aria-label="API: API:PROXY"[^>]*>API</);
    agentChat.setChoices("claude", choicesWith({ billing: "none", label: "Not logged in", detail: "Sign in…" }));
    html = paneHtml();
    expect(html).toMatch(/data-billing="none"[^>]*>ACNT</);
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
    expect(accountChipText(agentChatState().choices.claude!.account!)).toBe("ACNT");
  } finally {
    globalThis.fetch = realFetch;
    agentChat.setChoices("claude", undefined);
  }
});

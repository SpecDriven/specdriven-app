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

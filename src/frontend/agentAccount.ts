// The coding agent pane's account chip (specs/agents/agent-pane.feature.md
// "The pane header says whether the agent spends an account or the API"):
// one short word at the right of the header, whatever the agent's own
// account answer calls the sign-in, and that answer in the tooltip.
import type { ChatAccount } from "../server/agentTypes";

export type AccountChipText = "API" | "ACNT";

/** API while calls are billed through the API — a key, a bearer token, a
    proxy or a cloud provider; ACNT while an account's plan pays, or while
    the account is not signed in yet (the chip then turns red). */
export function accountChipText(account: ChatAccount): AccountChipText {
  return account.billing === "api" || account.billing === "provider" ? "API" : "ACNT";
}

/** The tooltip: the agent's own words for the sign-in, then who and where
    from, without saying the same thing twice. */
export function accountChipDetail(account: ChatAccount): string {
  const { label, detail } = account;
  if (!detail || detail === label) return label;
  if (!label || detail.startsWith(label)) return detail;
  return `${label} · ${detail}`;
}

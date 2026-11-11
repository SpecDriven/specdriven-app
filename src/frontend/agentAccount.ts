// The coding agent pane's account chip (specs/agents/agent-pane.feature.md
// "The pane header says whether the agent spends an account or the API"):
// one icon at the right of the header — a plug or a person — whatever the
// agent's own account answer calls the sign-in, and that answer in the
// tooltip.
import type { ChatAccount } from "../server/agentTypes";

export type AccountChipKind = "api" | "account";

/** `api` (the plug) while calls are billed through the API — a key, a bearer
    token, a proxy or a cloud provider; `account` (the person) while an
    account's plan pays, or while the account is not signed in yet (the chip
    then turns red). */
export function accountChipKind(account: ChatAccount): AccountChipKind {
  return account.billing === "api" || account.billing === "provider" ? "api" : "account";
}

/** The word the icon stands for: it leads the tooltip and the chip's
    accessible name. */
export function accountChipWord(account: ChatAccount): "API" | "Account" {
  return accountChipKind(account) === "api" ? "API" : "Account";
}

/** The tooltip: the word the icon stands for, then the agent's own words
    for the sign-in, then who and where from, without saying the same thing
    twice. */
export function accountChipDetail(account: ChatAccount): string {
  const { label, detail } = account;
  const own =
    !detail || detail === label ? label : !label || detail.startsWith(label) ? detail : `${label} · ${detail}`;
  const word = accountChipWord(account);
  if (!own) return word;
  return own.toLowerCase().startsWith(word.toLowerCase()) ? own : `${word} · ${own}`;
}

// The "Ticket link" fields of the scenario dialog and the feature's ticket
// dialog (specs/external-links/project-management-jira-linear-etc.feature.md).
// Three inputs — url, tool, ticket — make one ExternalLink; this module holds
// the rules for turning what was typed into a link (or a reason it isn't one
// yet) and for guessing the tool and ticket from a pasted url. Pure and
// DOM-free so the rules can be tested on their own.

import { isExternalLink } from "../server/parser";
import { cleanLine } from "../server/text";
import type { ExternalLink } from "../server/parser";

/** The three fields as typed, before they make a link. */
export interface LinkDraft {
  program: string;
  ticket: string;
  url: string;
}

export const EMPTY_LINK_DRAFT: LinkDraft = { program: "", ticket: "", url: "" };

export function linkDraftOf(link: ExternalLink | null | undefined): LinkDraft {
  return link ? { program: link.program, ticket: link.ticket, url: link.url } : EMPTY_LINK_DRAFT;
}

export function isBlankLinkDraft(draft: LinkDraft): boolean {
  return !draft.program.trim() && !draft.ticket.trim() && !draft.url.trim();
}

/** What the chip shows: `Jira:ABC-123` — the spec's `<program>:<ticket>`. */
export function externalLinkLabel(link: ExternalLink): string {
  return `${link.program}:${link.ticket}`;
}

export interface ResolvedLink {
  /** The link the fields hold; null when they are all empty (no link). */
  link: ExternalLink | null;
  /** Set when the fields hold something that is not a link yet. */
  error?: string;
}

/**
 * The link a draft makes. All three empty is "no link"; anything partial or
 * malformed is an error with the message the field shows, and blocks a save
 * rather than being dropped or written half-done.
 */
export function resolveLinkDraft(draft: LinkDraft): ResolvedLink {
  const program = cleanLine(draft.program);
  const ticket = draft.ticket.trim();
  const url = draft.url.trim();
  if (!program && !ticket && !url) return { link: null };
  if (!url) return { link: null, error: "Enter the ticket's url." };
  if (!/^https?:\/\/\S+$/.test(url)) return { link: null, error: `Not a web link: "${url}"` };
  if (!program) return { link: null, error: "Choose the tool the ticket lives in (Jira, Linear…)." };
  if (!ticket) return { link: null, error: "Enter the ticket id (ABC-123)." };
  const link = { program, ticket, url };
  if (!isExternalLink(link)) {
    return {
      link: null,
      error:
        "The tool name can't contain ':' or brackets, the ticket id can't contain brackets, and the url can't contain spaces or parentheses.",
    };
  }
  return { link };
}

/** A ticket key like ABC-123 / ENG-42, as Jira, Linear and YouTrack mint them. */
const KEY_RE = /\b([A-Z][A-Z0-9_]*-\d+)\b/;

/**
 * The tool and ticket a url gives away, for pre-filling the other two fields
 * when a url is pasted. Hosts the usual tools live on are recognized; any
 * other url still yields a ticket when its path carries an ABC-123 key.
 */
export function suggestLink(url: string): Partial<Pick<ExternalLink, "program" | "ticket">> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return {};
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  const segments = path.split("/").filter(Boolean);
  const after = (marker: string) => {
    const at = segments.indexOf(marker);
    return at >= 0 ? segments[at + 1] : undefined;
  };
  const key = (s: string | undefined) => s?.match(KEY_RE)?.[1];
  if (host.endsWith(".atlassian.net") || host.includes("jira")) {
    return {
      program: "Jira",
      ticket: key(after("browse")) ?? key(parsed.searchParams.get("selectedIssue") ?? "") ?? key(path),
    };
  }
  if (host === "linear.app" || host.endsWith(".linear.app")) {
    return { program: "Linear", ticket: key(after("issue")) ?? key(path) };
  }
  if (host === "github.com" || host === "www.github.com") {
    const number = after("issues") ?? after("pull") ?? after("discussions");
    return { program: "GitHub", ticket: number && /^\d+$/.test(number) ? `#${number}` : undefined };
  }
  if (host === "gitlab.com" || host.includes("gitlab")) {
    const number = after("issues") ?? after("merge_requests");
    return { program: "GitLab", ticket: number && /^\d+$/.test(number) ? `#${number}` : undefined };
  }
  if (host.endsWith("asana.com")) {
    const number = [...segments].reverse().find((s) => /^\d+$/.test(s));
    return { program: "Asana", ticket: number };
  }
  if (host.endsWith("trello.com")) {
    const number = segments[2]?.match(/^(\d+)-/)?.[1];
    return { program: "Trello", ticket: number ? `#${number}` : undefined };
  }
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
    const number = after("edit");
    return { program: "Azure DevOps", ticket: number && /^\d+$/.test(number) ? `#${number}` : undefined };
  }
  if (host.includes("youtrack")) {
    return { program: "YouTrack", ticket: key(after("issue")) ?? key(path) };
  }
  if (host.endsWith("shortcut.com")) {
    const number = after("story");
    return { program: "Shortcut", ticket: number && /^\d+$/.test(number) ? `#${number}` : undefined };
  }
  if (host.includes("monday.com")) {
    const number = after("pulses");
    return { program: "Monday", ticket: number && /^\d+$/.test(number) ? `#${number}` : undefined };
  }
  return { ticket: key(path) };
}

/**
 * The ticket id a url yields on its own — what the url-only fields use, since
 * there is no ticket field to type one into. The tools' own key (ABC-123)
 * first; failing that the url's last path segment, which is what a tool with
 * numeric or slug ids leaves there.
 */
export function ticketFromUrl(url: string): string {
  const guess = suggestLink(url).ticket;
  if (guess) return guess;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "";
  }
  const last = parsed.pathname.split("/").filter(Boolean).pop();
  if (!last) return "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    decoded = last;
  }
  return /[[\]]/.test(decoded) ? "" : decoded;
}

/**
 * The draft with a new url when the tool comes from Settings, not from a
 * dropdown beside the field: only the url is shown, so the tool is the one
 * Settings names and the ticket is whatever the url gives away. A link
 * recorded under another tool keeps it — editing its url must not rename the
 * ticket it already points at.
 */
export function withLinkUrlForTool(draft: LinkDraft, url: string, tool: string): LinkDraft {
  const guessed = withLinkUrl(draft, url);
  // A ticket that is still the one derived from the old url follows the new
  // one; one the user typed themselves stays.
  const derived = ticketFromUrl(url);
  const followed = !guessed.ticket.trim() || guessed.ticket === ticketFromUrl(draft.url);
  return {
    url,
    program: draft.program.trim() || tool,
    ticket: followed ? derived : guessed.ticket,
  };
}

/**
 * The draft with a new url — and, for the fields the url gives away, the tool
 * and ticket it suggests. A field the user filled in themselves is never
 * overwritten by a guess; a field still holding what the previous url
 * suggested follows the new url, so a url typed a character at a time ends
 * with the whole ticket id (ABC-124), not the prefix the first keystrokes
 * suggested (ABC-1).
 */
export function withLinkUrl(draft: LinkDraft, url: string): LinkDraft {
  const guess = suggestLink(url);
  const previous = suggestLink(draft.url);
  const follow = (current: string, was: string | undefined, next: string | undefined) =>
    !current.trim() || current === was ? (next ?? current) : current;
  return {
    url,
    program: follow(draft.program, previous.program, guess.program),
    ticket: follow(draft.ticket, previous.ticket, guess.ticket),
  };
}

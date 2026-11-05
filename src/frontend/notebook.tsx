// The engineering notebook's side of the sidebar
// (specs/app/engineering-notebook.feature.md): what turns a list of markdown
// pages into a dated log — the month headings the entries sit under, the day
// each row shows, and the chip that says whether an entry is an observation
// or a decision. Pure, so the list can be rendered and asserted without a DOM
// (tests/notebook.test.tsx); everything that talks to the server stays in
// App.tsx with the other page tabs.

import { Eye, Gavel } from "lucide-react";
import type { PageListing } from "../server/pages";

/**
 * An entry is an observation or a decision. One that says neither — a plain
 * markdown file dropped into the folder by hand, or a `**Kind:**` line naming
 * something else — reads as an observation rather than as nothing.
 */
export type EntryKind = "Observation" | "Decision";

export function entryKindOf(page: PageListing): EntryKind {
  return page.kind === "Decision" ? "Decision" : "Observation";
}

/** The chip beside an entry's title, in the list and in its header. */
/** The kind as a glyph alone — a sidebar row's leading slot. */
export function EntryKindGlyph({ kind, size = 13 }: { kind: EntryKind; size?: number }) {
  const Icon = kind === "Decision" ? Gavel : Eye;
  return <Icon size={size} className={`entry-glyph entry-glyph-${kind.toLowerCase()}`} role="img" aria-label={kind} />;
}

export function EntryKindChip({ kind, size = 11 }: { kind: EntryKind; size?: number }) {
  const Icon = kind === "Decision" ? Gavel : Eye;
  return (
    <span className={`entry-kind entry-kind-${kind.toLowerCase()}`}>
      <Icon size={size} aria-hidden="true" /> {kind}
    </span>
  );
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "September 2026" — the heading a month's entries sit under. */
export function monthOf(date: string | undefined): string {
  if (!date) return "Undated";
  const [year, month] = date.split("-");
  const at = Number(month) - 1;
  return MONTH_NAMES[at] ? `${MONTH_NAMES[at]} ${year}` : "Undated";
}

/** The day an entry's row shows — the date's day of the month, or nothing. */
export function dayOf(date: string | undefined): string {
  const day = date?.split("-")[2];
  return day ? String(Number(day)) : "";
}

/**
 * The notebook's entries grouped by the month they were written in, newest
 * month first and the entries inside it in the order the server sent them —
 * newest first. An entry with no date at all falls into an "Undated" group at
 * the end rather than being hidden: the markdown is the interchange format,
 * and a file somebody wrote by hand must still be reachable.
 *
 * The shape matches the subfolder grouping the other page tabs use, so one
 * list renders both.
 */
export function entryGroups(pages: PageListing[]): { dir: string; pages: PageListing[] }[] {
  const groups = new Map<string, PageListing[]>();
  for (const page of pages) {
    const month = monthOf(page.date);
    const list = groups.get(month) ?? [];
    list.push(page);
    groups.set(month, list);
  }
  return [...groups]
    .sort(([a, ai], [b, bi]) =>
      a === "Undated"
        ? 1
        : b === "Undated"
          ? -1
          : (bi[0]?.date ?? "").localeCompare(ai[0]?.date ?? ""),
    )
    .map(([dir, list]) => ({ dir, pages: list }));
}

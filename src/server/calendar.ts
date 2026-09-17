// Add a task to Google Calendar (specs/app/tasks.feature.md "Add task to
// Google Calendar"): how long a task is estimated to take, written on the
// task as one metadata line — `**Estimate:** 1h 30m` — and the prefilled
// Google Calendar event the estimate becomes. Pure over strings and dates:
// no node, no DOM, so the client builds the link and the server parses the
// line from the same code.

/** The longest estimate a task can carry: a week, in minutes. */
export const MAX_ESTIMATE_MINUTES = 7 * 24 * 60;

/** The picker's choices when nothing proposes an estimate: 15m … 8h. */
export const ESTIMATE_PRESETS: readonly number[] = [15, 30, 60, 120, 240, 480];

const HOURS = String.raw`(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)`;
const MINUTES = String.raw`(\d+)\s*(?:m|mins?|minutes?)`;
const ESTIMATE_RE = new RegExp(
  `^(?:${HOURS}(?:\\s*${MINUTES})?|${MINUTES.replace("(\\d+)", "(\\d+)")}|(\\d+))$`,
  "i",
);

/**
 * The minutes an estimate stands for, or null when the text is not one.
 * Read: `30m`, `2h`, `1.5h`, `1h30m`, `1 hour 30 minutes`, and a bare
 * number of minutes, so the picker's field is forgiving. Not read, on
 * purpose: days, "half day", ranges — a hand-written `**Estimate:** two
 * days` stays in the task's body as ordinary text, the way a
 * `**Status:** Blocked` does, rather than being swallowed and lost.
 */
export function parseEstimate(text: string): number | null {
  const m = text.trim().match(ESTIMATE_RE);
  if (!m) return null;
  const [, hours, hoursMinutes, onlyMinutes, bare] = m;
  let minutes: number;
  if (hours !== undefined) {
    minutes = Math.round(Number(hours) * 60) + (hoursMinutes ? Number(hoursMinutes) : 0);
  } else if (onlyMinutes !== undefined) {
    minutes = Number(onlyMinutes);
  } else {
    minutes = Number(bare);
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ESTIMATE_MINUTES) return null;
  return minutes;
}

/** The canonical form of an estimate: `30m`, `2h`, `1h 30m`. */
export function formatEstimate(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// The metadata line, shaped like the assignment's (src/server/parser.ts
// formatAssigned): bold label, the estimate, nothing else on the line.
const ESTIMATE_LINE_RE = /^\s{0,3}\*\*Estimate:\*\*\s*(.+?)\s*$/i;

/** The markdown line an estimate is written as. */
export function formatEstimateLine(minutes: number): string {
  return `**Estimate:** ${formatEstimate(minutes)}`;
}

/** The minutes a line of markdown estimates, or null when it is not one. */
export function parseEstimateLine(line: string): number | null {
  const m = line.match(ESTIMATE_LINE_RE);
  if (!m) return null;
  return parseEstimate(m[1]!);
}

/**
 * The default start for the event: the next quarter hour from now, seconds
 * dropped — a moment already on the quarter is kept. Chosen on the client,
 * whose clock and zone are the person's; the server may run elsewhere.
 */
export function nextQuarterHour(now: Date): Date {
  const next = new Date(now.getTime());
  next.setSeconds(0, 0);
  const over = next.getMinutes() % 15;
  if (over !== 0 || now.getSeconds() !== 0) {
    next.setMinutes(next.getMinutes() - over + 15);
  }
  return next;
}

/** A moment as Google's `dates` parameter spells it, in UTC: `20260916T141500Z`. */
function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** The `dates` parameter: start and end, UTC, a `/` between. */
export function calendarDates(start: Date, minutes: number): string {
  const end = new Date(start.getTime() + minutes * 60_000);
  return `${utcStamp(start)}/${utcStamp(end)}`;
}

export interface CalendarEvent {
  title: string;
  start: Date;
  /** How long the event runs — the task's estimate. */
  minutes: number;
  /** The event's description; a link in it is what Google shows as one. */
  details: string;
}

/**
 * The link that opens Google Calendar on a prefilled event — Google's
 * `render?action=TEMPLATE` form. Both times carry `Z`, so no `ctz` is
 * sent: with one, Google labels the event "GMT+00:00" instead of converting
 * it. Nothing is written to the person's calendar until they save the
 * event there.
 */
export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: calendarDates(event.start, event.minutes),
    details: event.details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** A moment as an `<input type="datetime-local">` holds it: local `yyyy-mm-ddThh:mm`. */
export function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** The moment a `datetime-local` value names, in the local zone, or null. */
export function fromLocalInput(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const date = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    0,
    0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

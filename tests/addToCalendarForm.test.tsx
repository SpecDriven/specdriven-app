// Add a task to Google Calendar (src/frontend/AddToCalendarForm.tsx): the
// calendar chip's form — the estimate and where it came from, the presets,
// the start, and the link that is the submit. Static markup only.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AddToCalendarForm } from "../src/frontend/AddToCalendarForm";
import type { AddToCalendarFormProps } from "../src/frontend/AddToCalendarForm";

const noop = () => undefined;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const URL_ = "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Ship+v2";

const base: AddToCalendarFormProps = {
  estimateText: "1h 30m",
  onEstimateChange: noop,
  startLocal: "2026-09-16T14:15",
  onStartChange: noop,
  proposal: "stored",
  url: URL_,
  onSubmit: noop,
  onCancel: noop,
};

const link = (markup: string) => markup.match(/<a class="button-link"([^>]*)>([^<]*)<\/a>/);

describe("AddToCalendarForm", () => {
  test("offers the stored estimate, a start time, and the Google Calendar link", () => {
    const markup = html(<AddToCalendarForm {...base} />);
    expect(markup).toContain("The estimate on the task");
    expect(markup).toMatch(/<input type="text" aria-label="Estimate"[^>]*value="1h 30m"/);
    expect(markup).toMatch(/<input type="datetime-local" aria-label="Start" value="2026-09-16T14:15"/);
    const a = link(markup)!;
    expect(a[1]).toContain(`href="${URL_.replace(/&/g, "&amp;")}"`);
    expect(a[1]).toContain('target="_blank"');
    expect(a[2]).toBe("Add to Google Calendar");
    expect(markup).toContain(">Cancel</button>");
  });

  test("says when Claude proposed the estimate, and asks while it thinks", () => {
    expect(html(<AddToCalendarForm {...base} proposal="claude" />)).toContain("Suggested by Claude");
    const loading = html(<AddToCalendarForm {...base} proposal="loading" estimateText="" url={null} />);
    expect(loading).toContain("Asking Claude");
    expect(loading).toMatch(/<input type="text" aria-label="Estimate" placeholder="1h 30m" disabled=""[^>]*value=""/);
    expect(loading).not.toContain('aria-label="Estimate presets"');
  });

  test("falls back to the presets when no proposal comes", () => {
    const markup = html(<AddToCalendarForm {...base} proposal="manual" estimateText="" url={null} />);
    expect(markup).toContain("How long will this take?");
    expect(markup).not.toContain("Suggested by Claude");
    const presets = [...markup.matchAll(/<button type="button" class="chip[^"]*" aria-pressed="(true|false)">([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
    expect(presets).toEqual([
      ["15m", "false"], ["30m", "false"], ["1h", "false"], ["2h", "false"], ["4h", "false"], ["8h", "false"],
    ]);
    const chosen = html(<AddToCalendarForm {...base} proposal="manual" estimateText="2h" />);
    expect(chosen).toMatch(/class="chip" aria-pressed="true">2h</);
  });

  test("an estimate that does not parse disables the link", () => {
    const markup = html(<AddToCalendarForm {...base} estimateText="two days" url={null} />);
    expect(markup).toContain("Write an estimate like 30m, 2h or 1h 30m.");
    expect(markup).toMatch(/aria-label="Estimate"[^>]*aria-invalid="true"[^>]*value="two days"/);
    const a = link(markup)!;
    expect(a[1]).not.toContain("href=");
    expect(a[1]).toContain('aria-disabled="true"');
  });
});

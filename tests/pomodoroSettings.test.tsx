// Pomodoro settings (src/frontend/PomodoroSettings.tsx): the lengths, the
// sound and the tick, which used to be the Start session dialog's Pomodoro
// tab and are now a habit of the person at this keyboard. Static markup only.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PomodoroSettingsForm,
  formOf,
  parsePomodoroForm,
} from "../src/frontend/PomodoroSettings";
import { DEFAULT_PREFS } from "../src/frontend/pomodoro";

const noop = () => undefined;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const submit = (markup: string) => markup.match(/<button type="submit"([^>]*)>([^<]*)<\/button>/);

describe("PomodoroSettingsForm", () => {
  const props = { prefs: DEFAULT_PREFS, onSave: noop, onPreview: noop, onCancel: noop };

  test("offers the four lengths, the sounds with a preview, the tick, and Save", () => {
    const markup = html(<PomodoroSettingsForm {...props} />);
    expect(markup).toContain("<h3>Pomodoro settings</h3>");
    const numbers = [...markup.matchAll(/<input type="number"[^>]*aria-label="([^"]*)"[^>]*value="(\d+)"/g)].map((m) => [m[1], m[2]]);
    expect(numbers).toEqual([
      ["Focus minutes", "25"],
      ["Short break minutes", "5"],
      ["Long break minutes", "15"],
      ["Pomodoros between long breaks", "4"],
    ]);
    expect([...markup.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual(["bell", "chime", "ding", "woodblock", "none"]);
    expect(markup).toMatch(/<option value="bell"[^>]*selected=""/);
    expect(markup).toContain('aria-label="Preview sound"');
    expect(markup).toContain('role="switch"');
    expect(submit(markup)![2]).toBe("Save");
    // No name: a pomodoro is started by a click, not by filling a form in.
    expect(markup).not.toContain('aria-label="Session name"');
  });

  test("shows the stored preferences, and no preview for silence", () => {
    const markup = html(<PomodoroSettingsForm {...props} prefs={{ ...DEFAULT_PREFS, workMinutes: 50, sound: "none", tick: true }} />);
    expect(markup).toMatch(/aria-label="Focus minutes"[^>]*value="50"/);
    expect(markup).toMatch(/<option value="none"[^>]*selected=""/);
    expect(markup).toMatch(/<button[^>]*aria-label="Preview sound"[^>]*disabled=""/);
    expect(markup).toMatch(/role="switch"[^>]*checked=""/);
  });

  test("while a pomodoro runs, says the change lands on the next one", () => {
    const markup = html(<PomodoroSettingsForm {...props} running />);
    expect(markup).toContain("keeps the lengths it started with");
    // Still editable: only the running interval is fixed.
    expect(markup).toContain('type="number"');
    expect(submit(markup)![2]).toBe("Save");
  });

  test("the form's text becomes clamped preferences", () => {
    const form = { ...formOf(DEFAULT_PREFS), workMinutes: "999", shortBreakMinutes: "", longBreakEvery: "0", sound: "siren" as never, tick: true };
    expect(parsePomodoroForm(form, DEFAULT_PREFS)).toEqual({ ...DEFAULT_PREFS, workMinutes: 180, shortBreakMinutes: 5, longBreakEvery: 1, tick: true });
    expect(formOf({ ...DEFAULT_PREFS, longBreakMinutes: 20 }).longBreakMinutes).toBe("20");
  });
});

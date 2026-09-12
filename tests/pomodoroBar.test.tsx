// The Pomodoro bar (src/frontend/PomodoroBar.tsx): what it says in each
// phase, and the one action each phase offers. Static markup only.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PomodoroBarView, PomodoroIdleView, PomodoroToggleView } from "../src/frontend/PomodoroBar";
import type { PomodoroBarViewProps } from "../src/frontend/PomodoroBar";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const MIN = 60_000;

const base: PomodoroBarViewProps = {
  phase: "work",
  nextKind: "shortBreak",
  remainingMs: 24 * MIN + 59_000,
  progress: 0.4,
  dots: { filled: 2, total: 4 },
  totalWorkMs: 50 * MIN,
  flash: false,
};

const buttons = (markup: string) =>
  [...markup.matchAll(/<div class="pomodoro-actions"><button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe("PomodoroBarView", () => {
  test("during focus — the phase, the clock, progress, dots, total, and Abandon", () => {
    const markup = html(<PomodoroBarView {...base} />);
    expect(markup).toContain("Focus");
    expect(markup).toContain(">24:59</time>");
    expect(markup).toContain('style="width:40%"');
    expect(markup).toContain('aria-label="2 of 4 pomodoros"');
    expect(markup.match(/class="dot on"/g)).toHaveLength(2);
    expect(markup.match(/class="dot"/g)).toHaveLength(2);
    expect(markup).toContain("Focus 50m");
    expect(buttons(markup)).toEqual(["Abandon"]);
    expect(markup).not.toContain(" break");
    expect(markup).not.toContain(" flash");
  });

  test("during a break — Skip, the break class, and a coffee", () => {
    const markup = html(<PomodoroBarView {...base} phase="shortBreak" remainingMs={4 * MIN + 59_000} />);
    expect(markup).toContain('class="pomodoro-bar break"');
    expect(markup).toContain("Short break");
    expect(markup).toContain(">04:59</time>");
    expect(buttons(markup)).toEqual(["Skip"]);
    expect(html(<PomodoroBarView {...base} phase="longBreak" />)).toContain("Long break");
  });

  test("between intervals — no clock, and the button that starts what comes next", () => {
    const between = { ...base, phase: null, remainingMs: 0, progress: 0 };
    expect(html(<PomodoroBarView {...between} nextKind="shortBreak" />)).toContain(">Start break<");
    expect(html(<PomodoroBarView {...between} nextKind="longBreak" />)).toContain(">Start long break<");
    const work = html(<PomodoroBarView {...between} nextKind="work" />);
    expect(work).toContain(">Start pomodoro<");
    expect(work).toContain(">--:--</time>");
    expect(work).toContain("Between pomodoros");
  });

  test("flashes when told to, and the menu offers the settings and to stop", () => {
    const markup = html(<PomodoroBarView {...base} flash menuOpen />);
    expect(markup).toContain('class="pomodoro-bar flash"');
    expect(markup).toContain("Stop Pomodoro");
    expect(markup).toContain("Pomodoro settings…");
    expect(html(<PomodoroBarView {...base} />)).not.toContain("Stop Pomodoro");
  });

  test("the bar can be closed without stopping the timer", () => {
    const markup = html(<PomodoroBarView {...base} />);
    expect(markup).toContain('aria-label="Hide the Pomodoro bar"');
    expect(markup).toContain('title="Hide the bar — the timer keeps running"');
    // Hiding is not stopping: that stays in the ⋯ menu.
    expect(markup).not.toContain("Stop Pomodoro");
  });

  test("the rail chip is the clock alone, and a timer icon between intervals", () => {
    const chip = html(<PomodoroBarView {...base} compact />);
    expect(chip).toContain("pomodoro-chip");
    expect(chip).toContain(">24:59</button>");
    expect(chip).not.toContain("pomodoro-actions");
    const between = html(<PomodoroBarView {...base} compact phase={null} />);
    expect(between).toContain('aria-label="Pomodoro: between intervals"');
    expect(between).toContain("<svg");
  });
});

describe("PomodoroIdleView", () => {
  test("with no timer running, one button starts a pomodoro — no name, no dialog", () => {
    const markup = html(<PomodoroIdleView workMinutes={25} />);
    expect(markup).toContain('class="pomodoro-bar idle"');
    expect(markup).toContain("Start a pomodoro");
    expect(markup).toContain(">25m<");
    expect(markup).toContain('title="Start a pomodoro — 25 minutes of focus"');
    // Nothing to fill in, and nothing to stop.
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("Stop Pomodoro");
  });

  test("the length shown follows the preferences, and the menu holds the settings", () => {
    expect(html(<PomodoroIdleView workMinutes={50} />)).toContain(">50m<");
    const open = html(<PomodoroIdleView workMinutes={25} menuOpen />);
    expect(open).toContain("Pomodoro settings…");
    expect(open).not.toContain("Stop Pomodoro");
  });

  test("the rail's idle chip is a timer icon that starts one", () => {
    const chip = html(<PomodoroIdleView workMinutes={25} compact />);
    expect(chip).toContain("pomodoro-chip idle");
    expect(chip).toContain('aria-label="Start a pomodoro — 25 minutes of focus"');
    expect(chip).toContain("<svg");
    expect(chip).not.toContain("pomodoro-actions");
  });

  test("the idle bar closes too", () => {
    expect(html(<PomodoroIdleView workMinutes={25} />)).toContain(
      'aria-label="Hide the Pomodoro bar"',
    );
  });
});

// The header's icon (src/frontend/pomodoroPref.ts): the whole feature as one
// button in the sidebar header, left of the coding agent's Bot.
describe("PomodoroToggleView", () => {
  test("closed and idle — a bare timer icon that opens the bar", () => {
    const markup = html(<PomodoroToggleView />);
    expect(markup).toContain('class="ibtn pomodoro-toggle"');
    expect(markup).toContain('aria-label="Show the Pomodoro"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("<svg");
    // None of the bar's real estate: no clock, no progress, no dots, no actions.
    expect(markup).not.toContain("pomodoro-toggle-clock");
    expect(markup).not.toContain("pomodoro-progress");
    expect(markup).not.toContain("pomodoro-dots");
    expect(markup).not.toContain("pomodoro-actions");
  });

  test("open, the same icon closes the bar again", () => {
    const markup = html(<PomodoroToggleView shown />);
    expect(markup).toContain('class="ibtn pomodoro-toggle active"');
    expect(markup).toContain('aria-label="Hide the Pomodoro"');
    expect(markup).toContain('aria-pressed="true"');
  });

  test("while a pomodoro runs, the icon carries its clock", () => {
    const markup = html(<PomodoroToggleView phase="work" remainingMs={24 * MIN + 59_000} />);
    expect(markup).toContain('class="pomodoro-toggle-clock">24:59</span>');
    expect(markup).toContain('aria-label="Show the Pomodoro — Focus, 24:59 left"');
  });

  test("a break reads as one, and the flash carries over", () => {
    const markup = html(<PomodoroToggleView phase="shortBreak" remainingMs={4 * MIN} flash />);
    expect(markup).toContain('class="ibtn pomodoro-toggle break flash"');
    expect(markup).toContain("Short break, 04:00 left");
  });
});

// The Pomodoro bar (src/frontend/PomodoroBar.tsx): what it says in each
// phase, and the one action each phase offers. Static markup only.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PomodoroBarView } from "../src/frontend/PomodoroBar";
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
  test("during focus: the phase, the clock, progress, dots, total, and Abandon", () => {
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

  test("during a break: Skip, the break class, and a coffee", () => {
    const markup = html(<PomodoroBarView {...base} phase="shortBreak" remainingMs={4 * MIN + 59_000} />);
    expect(markup).toContain('class="pomodoro-bar break"');
    expect(markup).toContain("Short break");
    expect(markup).toContain(">04:59</time>");
    expect(buttons(markup)).toEqual(["Skip"]);
    expect(html(<PomodoroBarView {...base} phase="longBreak" />)).toContain("Long break");
  });

  test("between intervals: no clock, and the button that starts what comes next", () => {
    const between = { ...base, phase: null, remainingMs: 0, progress: 0 };
    expect(html(<PomodoroBarView {...between} nextKind="shortBreak" />)).toContain(">Start break<");
    expect(html(<PomodoroBarView {...between} nextKind="longBreak" />)).toContain(">Start long break<");
    const work = html(<PomodoroBarView {...between} nextKind="work" />);
    expect(work).toContain(">Start pomodoro<");
    expect(work).toContain(">--:--</time>");
    expect(work).toContain("Between pomodoros");
  });

  test("flashes when told to, and the menu offers to end the session", () => {
    const markup = html(<PomodoroBarView {...base} flash menuOpen />);
    expect(markup).toContain('class="pomodoro-bar flash"');
    expect(markup).toContain("End session");
    expect(html(<PomodoroBarView {...base} />)).not.toContain("End session");
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

// The Pomodoro bar (roadmap/support-for-human-code-sessions.md): the running
// session at the foot of the sidebar — the phase, the clock, a progress
// line, the cycle's dots, the focus so far, and the one action the moment
// allows. Abandon voids a pomodoro (an interruption); Skip cuts a break;
// between intervals the button starts the next one. A collapsed sidebar
// shows the clock alone as a chip in the rail.
//
// PomodoroBarView is pure over what it shows, so bun test can render it
// (tests/pomodoroBar.test.tsx); PomodoroBar binds it to the store.

import { useState } from "react";
import { Coffee, MoreHorizontal, Square, Timer } from "lucide-react";
import { Menu } from "./Menu";
import { Tooltip } from "./Tooltip";
import {
  INTERVAL_LABEL,
  formatClock,
  formatDuration,
  pomodoro,
  progressOf,
  remainingMs,
  startLabel,
  totalWorkMs,
  usePomodoro,
} from "./pomodoro";
import { cycleDots, nextIntervalKind, openInterval } from "../server/humanSessionRules";
import type { IntervalKind } from "../server/humanSessionRules";

export interface PomodoroBarViewProps {
  /** The running interval's kind, or null between intervals. */
  phase: IntervalKind | null;
  /** What the next interval would be, for the button between intervals. */
  nextKind: IntervalKind;
  remainingMs: number;
  /** 0..1 through the running interval. */
  progress: number;
  dots: { filled: number; total: number };
  totalWorkMs: number;
  flash: boolean;
  busy?: boolean;
  /** The rail's chip instead of the bar. */
  compact?: boolean;
  menuOpen?: boolean;
  onMenu?: (open: boolean) => void;
  onAbandon?: () => void;
  onSkip?: () => void;
  onStartNext?: () => void;
  onEnd?: () => void;
  /** The chip's click: bring the sidebar back. */
  onExpand?: () => void;
}

export function PomodoroBarView(p: PomodoroBarViewProps) {
  const clock = formatClock(p.remainingMs);
  const label = p.phase ? INTERVAL_LABEL[p.phase] : "Between pomodoros";
  const onBreak = p.phase === "shortBreak" || p.phase === "longBreak";
  if (p.compact) {
    return (
      <Tooltip label={p.phase ? `${label} — ${clock} left` : `Pomodoro: ${startLabel(p.nextKind).toLowerCase()}`}>
        <button
          type="button"
          className={`rail-btn pomodoro-chip${onBreak ? " break" : ""}${p.flash ? " flash" : ""}`}
          aria-label={p.phase ? `Pomodoro: ${clock} ${label}` : "Pomodoro: between intervals"}
          onClick={p.onExpand}
        >
          {p.phase ? clock : <Timer size={16} aria-hidden="true" />}
        </button>
      </Tooltip>
    );
  }
  return (
    <div
      className={`pomodoro-bar${onBreak ? " break" : ""}${p.flash ? " flash" : ""}`}
      role="group"
      aria-label="Pomodoro"
    >
      <div className="pomodoro-head">
        <span className="pomodoro-phase">
          {onBreak ? <Coffee size={12} aria-hidden="true" /> : <Timer size={12} aria-hidden="true" />}
          {label}
        </span>
        <Menu
          open={p.menuOpen === true}
          onClose={() => p.onMenu?.(false)}
          label="Pomodoro menu"
          className="pomodoro-menu"
          containerSelector=".pomodoro-bar"
          items={[
            {
              id: "end",
              label: "End session",
              icon: <Square size={13} />,
              danger: true,
              onSelect: () => p.onEnd?.(),
            },
          ]}
        />
        <button
          type="button"
          className="ibtn pomodoro-menu-btn"
          aria-label="Pomodoro menu"
          aria-haspopup="menu"
          aria-expanded={p.menuOpen === true}
          onClick={() => p.onMenu?.(!p.menuOpen)}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </div>
      <time className="pomodoro-clock" aria-live="off">
        {p.phase ? clock : "--:--"}
      </time>
      <div className="pomodoro-progress" aria-hidden="true">
        <i style={{ width: `${Math.round(p.progress * 100)}%` }} />
      </div>
      <div className="pomodoro-meta">
        <span
          className="pomodoro-dots"
          role="img"
          aria-label={`${p.dots.filled} of ${p.dots.total} pomodoros`}
        >
          {Array.from({ length: p.dots.total }, (_, i) => (
            <i key={i} className={`dot${i < p.dots.filled ? " on" : ""}`} />
          ))}
        </span>
        <span className="pomodoro-total">Focus {formatDuration(p.totalWorkMs)}</span>
      </div>
      <div className="pomodoro-actions">
        {p.phase === "work" ? (
          <button type="button" disabled={p.busy} onClick={p.onAbandon} title="Void this pomodoro — it does not count">
            Abandon
          </button>
        ) : onBreak ? (
          <button type="button" disabled={p.busy} onClick={p.onSkip} title="Cut the break short">
            Skip
          </button>
        ) : (
          <button type="button" className="next" disabled={p.busy} onClick={p.onStartNext}>
            {startLabel(p.nextKind)}
          </button>
        )}
      </div>
    </div>
  );
}

/** The bar over the store; nothing while no session runs. */
export function PomodoroBar({ compact, onExpand }: { compact?: boolean; onExpand?: () => void }) {
  const store = usePomodoro();
  const [menuOpen, setMenuOpen] = useState(false);
  const session = store.session;
  if (!session) return null;
  const open = openInterval(session);
  return (
    <PomodoroBarView
      phase={open?.kind ?? null}
      nextKind={nextIntervalKind(session)}
      remainingMs={remainingMs(session, store.now)}
      progress={progressOf(session, store.now)}
      dots={cycleDots(session)}
      totalWorkMs={totalWorkMs(session, store.now)}
      flash={store.now < store.flashUntil}
      busy={store.busy}
      compact={compact}
      menuOpen={menuOpen}
      onMenu={setMenuOpen}
      onAbandon={() => void pomodoro.abandon()}
      onSkip={() => void pomodoro.skipBreak()}
      onStartNext={() => void pomodoro.startInterval()}
      onEnd={() => {
        setMenuOpen(false);
        void pomodoro.endSession();
      }}
      onExpand={onExpand}
    />
  );
}

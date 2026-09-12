// The Pomodoro bar (specs/app/pomodoro.feature.md): the timer at the foot of
// the sidebar — the phase, the clock, a progress line, the cycle's dots, the
// focus so far, and the one action the moment allows. Abandon voids a
// pomodoro (an interruption); Skip cuts a break; between intervals the button
// starts the next one. A collapsed sidebar shows the clock alone as a chip in
// the rail.
//
// With no timer running the bar is an invitation instead: one click starts a
// pomodoro, with no dialog and no name — the timer is a feature of the app,
// not of a session. The ⋯ menu holds the settings, which apply to the next
// interval, never the running one.
//
// The bar is a lot of a narrow sidebar, so it is a pane you open rather than
// furniture: PomodoroToggleView is one small icon in the sidebar's header,
// left of the coding agent's Bot, and the bar opens directly beneath it
// (src/frontend/pomodoroPref.ts). The icon carries the clock while a pomodoro
// runs, so closing the bar never loses sight of the timer. Whether the
// Pomodoro is here at all is the Settings switch, off by default.
//
// PomodoroBarView, PomodoroIdleView and PomodoroToggleView are pure over what
// they show, so bun test can render them (tests/pomodoroBar.test.tsx);
// PomodoroBar and PomodoroToggle bind them to the store.

import { useState } from "react";
import { ChevronDown, Coffee, MoreHorizontal, Play, Settings2, Square, Timer } from "lucide-react";
import { Menu } from "./Menu";
import { Tooltip } from "./Tooltip";
import {
  INTERVAL_LABEL,
  formatClock,
  formatDuration,
  pomodoro,
  progressOf,
  readPrefs,
  remainingMs,
  startLabel,
  totalWorkMs,
  usePomodoro,
} from "./pomodoro";
import type { PomodoroPrefs } from "./pomodoro";
import { PomodoroSettingsDialog } from "./PomodoroSettings";
import { applyPomodoroShown, usePomodoroEnabled, usePomodoroShown } from "./pomodoroPref";
import { cycleDots, nextIntervalKind, openInterval } from "./pomodoroRules";
import type { IntervalKind } from "./pomodoroRules";

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
  onStop?: () => void;
  onSettings?: () => void;
  /** Close the bar; the timer keeps running behind the header's icon. */
  onHide?: () => void;
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
              id: "settings",
              label: "Pomodoro settings…",
              icon: <Settings2 size={13} />,
              onSelect: () => p.onSettings?.(),
            },
            {
              id: "stop",
              label: "Stop Pomodoro",
              icon: <Square size={13} />,
              danger: true,
              onSelect: () => p.onStop?.(),
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
        {/* Close the bar without stopping the timer: the header's icon
            carries the clock (src/frontend/pomodoroPref.ts). */}
        <button
          type="button"
          className="ibtn pomodoro-hide-btn"
          aria-label="Hide the Pomodoro bar"
          title="Hide the bar — the timer keeps running"
          onClick={p.onHide}
        >
          <ChevronDown size={14} aria-hidden="true" />
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

export interface PomodoroIdleViewProps {
  /** The focus length the next pomodoro would run for, in minutes. */
  workMinutes: number;
  compact?: boolean;
  menuOpen?: boolean;
  onMenu?: (open: boolean) => void;
  onStart?: () => void;
  onSettings?: () => void;
  /** Close the bar. */
  onHide?: () => void;
}

/** With no timer running: one click starts a pomodoro. */
export function PomodoroIdleView(p: PomodoroIdleViewProps) {
  const label = `Start a pomodoro — ${p.workMinutes} ${p.workMinutes === 1 ? "minute" : "minutes"} of focus`;
  if (p.compact) {
    return (
      <Tooltip label={label}>
        <button type="button" className="rail-btn pomodoro-chip idle" aria-label={label} onClick={p.onStart}>
          <Timer size={16} aria-hidden="true" />
        </button>
      </Tooltip>
    );
  }
  return (
    <div className="pomodoro-bar idle" role="group" aria-label="Pomodoro">
      <button type="button" className="pomodoro-start" title={label} onClick={p.onStart}>
        <Play size={12} aria-hidden="true" />
        Start a pomodoro
        <span className="pomodoro-start-mins">{p.workMinutes}m</span>
      </button>
      <Menu
        open={p.menuOpen === true}
        onClose={() => p.onMenu?.(false)}
        label="Pomodoro menu"
        className="pomodoro-menu"
        containerSelector=".pomodoro-bar"
        items={[
          {
            id: "settings",
            label: "Pomodoro settings…",
            icon: <Settings2 size={13} />,
            onSelect: () => p.onSettings?.(),
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
      <button
        type="button"
        className="ibtn pomodoro-hide-btn"
        aria-label="Hide the Pomodoro bar"
        title="Hide the bar"
        onClick={p.onHide}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export interface PomodoroToggleViewProps {
  /** The running interval's kind, or null when no interval is open. */
  phase?: IntervalKind | null;
  /** Left in the running interval — shown on the icon so nothing is lost. */
  remainingMs?: number;
  flash?: boolean;
  /** True while the bar is out: the icon then closes it again. */
  shown?: boolean;
  onToggle?: () => void;
}

/**
 * The Pomodoro in the sidebar's header, left of the coding agent's Bot: one
 * small icon that opens and closes the bar beneath it. A running pomodoro
 * shows its clock beside the timer, so a closed bar costs the detail and
 * never the timer.
 */
export function PomodoroToggleView(p: PomodoroToggleViewProps) {
  const phase = p.phase ?? null;
  const onBreak = phase === "shortBreak" || phase === "longBreak";
  const clock = phase ? formatClock(p.remainingMs ?? 0) : null;
  const what = p.shown ? "Hide" : "Show";
  const label = phase
    ? `${what} the Pomodoro — ${INTERVAL_LABEL[phase]}, ${clock} left`
    : `${what} the Pomodoro`;
  const className =
    `ibtn pomodoro-toggle${p.shown ? " active" : ""}` +
    `${onBreak ? " break" : ""}${p.flash ? " flash" : ""}`;
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-pressed={p.shown === true}
        onClick={p.onToggle}
      >
        {onBreak ? <Coffee size={15} aria-hidden="true" /> : <Timer size={15} aria-hidden="true" />}
        {clock && <span className="pomodoro-toggle-clock">{clock}</span>}
      </button>
    </Tooltip>
  );
}

/** The header's toggle over the store, for the sidebar header in App.tsx. */
export function PomodoroToggle() {
  const store = usePomodoro();
  const enabled = usePomodoroEnabled();
  const shown = usePomodoroShown();
  if (!enabled) return null;
  const running = store.timer ? openInterval(store.timer) : null;
  return (
    <PomodoroToggleView
      phase={running?.kind ?? null}
      remainingMs={store.timer ? remainingMs(store.timer, store.now) : 0}
      flash={store.now < store.flashUntil}
      shown={shown}
      onToggle={() => applyPomodoroShown(!shown)}
    />
  );
}

/**
 * The bar over the store: the running timer, or the invitation to start one.
 * `settingsOpen` is lifted so App can open the settings from the palette too.
 *
 * Nothing renders while the Settings switch is off, and only the icon renders
 * while the bar is folded away (src/frontend/pomodoroPref.ts).
 */
export function PomodoroBar({
  compact,
  onExpand,
  settingsOpen,
  onSettingsOpen,
}: {
  compact?: boolean;
  onExpand?: () => void;
  settingsOpen?: boolean;
  onSettingsOpen?: (open: boolean) => void;
}) {
  const store = usePomodoro();
  const enabled = usePomodoroEnabled();
  const shown = usePomodoroShown();
  const [menuOpen, setMenuOpen] = useState(false);
  const [ownSettings, setOwnSettings] = useState(false);
  const open = settingsOpen ?? ownSettings;
  const setOpen = onSettingsOpen ?? setOwnSettings;
  const timer = store.timer;
  // Off in Settings: the Pomodoro is not part of this app. The settings
  // dialog still opens if something asks for it — the palette hides its entry
  // too, but a dialog already open must not vanish mid-edit.
  if (!enabled && !open) return null;
  const settings = open ? (
    <PomodoroSettingsDialog
      prefs={store.prefs}
      running={timer !== null && openInterval(timer) !== null}
      onSave={(prefs: PomodoroPrefs) => {
        pomodoro.savePrefs(prefs);
        setOpen(false);
      }}
      onClose={() => setOpen(false)}
    />
  ) : null;
  if (!enabled) return settings;
  // Closed: the header's own icon (PomodoroToggle) is the whole feature, and
  // the sidebar gets its rows back. The rail is already icons, so a collapsed
  // sidebar keeps its chip either way.
  if (!shown && !compact) return settings;
  if (!timer) {
    return (
      <>
        <PomodoroIdleView
          workMinutes={store.prefs.workMinutes}
          compact={compact}
          menuOpen={menuOpen}
          onMenu={setMenuOpen}
          onStart={() => pomodoro.start(readPrefs())}
          onSettings={() => {
            setMenuOpen(false);
            setOpen(true);
          }}
          onHide={() => applyPomodoroShown(false)}
        />
        {settings}
      </>
    );
  }
  const running = openInterval(timer);
  return (
    <>
      <PomodoroBarView
        phase={running?.kind ?? null}
        nextKind={nextIntervalKind(timer)}
        remainingMs={remainingMs(timer, store.now)}
        progress={progressOf(timer, store.now)}
        dots={cycleDots(timer)}
        totalWorkMs={totalWorkMs(timer, store.now)}
        flash={store.now < store.flashUntil}
        compact={compact}
        menuOpen={menuOpen}
        onMenu={setMenuOpen}
        onAbandon={() => pomodoro.abandon()}
        onSkip={() => pomodoro.skipBreak()}
        onStartNext={() => pomodoro.startInterval()}
        onStop={() => {
          setMenuOpen(false);
          pomodoro.stop();
        }}
        onSettings={() => {
          setMenuOpen(false);
          setOpen(true);
        }}
        onHide={() => applyPomodoroShown(false)}
        onExpand={onExpand}
      />
      {settings}
    </>
  );
}

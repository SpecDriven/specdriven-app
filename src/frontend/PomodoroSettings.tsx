// Pomodoro settings (specs/app/pomodoro.feature.md): the interval lengths,
// the sound that announces the end of one, and whether to hear the clock
// tick. These were the body of the Start session dialog's Pomodoro tab;
// starting a pomodoro now takes one click, so they live behind the bar's ⋯
// menu instead, and are a habit of the person at this keyboard rather than a
// property of any session.
//
// Saving while a pomodoro runs is allowed and affects the next interval: the
// running one keeps the settings it started with.
//
// The form is pure over what it shows, so bun test can render it without a
// DOM (tests/pomodoroSettings.test.tsx).

import { useState } from "react";
import { backdropDismiss } from "./backdropDismiss";
import { Play } from "lucide-react";
import { clampMinutes } from "./pomodoro";
import type { PomodoroPrefs } from "./pomodoro";
import { POMODORO_EVERY_MAX, POMODORO_MINUTES_MAX } from "./pomodoroRules";
import { SOUND_LABEL, SOUND_NAMES, normalizeSoundName, preview } from "./sounds";
import type { SoundName } from "./sounds";
import { useFocusTrap } from "./useFocusTrap";

export interface PomodoroForm {
  workMinutes: string;
  shortBreakMinutes: string;
  longBreakMinutes: string;
  longBreakEvery: string;
  sound: SoundName;
  tick: boolean;
}

export function formOf(prefs: PomodoroPrefs): PomodoroForm {
  return {
    workMinutes: String(prefs.workMinutes),
    shortBreakMinutes: String(prefs.shortBreakMinutes),
    longBreakMinutes: String(prefs.longBreakMinutes),
    longBreakEvery: String(prefs.longBreakEvery),
    sound: prefs.sound,
    tick: prefs.tick,
  };
}

/** The form's text as preferences: each number clamped, the rest checked. */
export function parsePomodoroForm(draft: PomodoroForm, base: PomodoroPrefs): PomodoroPrefs {
  return {
    workMinutes: clampMinutes(draft.workMinutes, base.workMinutes),
    shortBreakMinutes: clampMinutes(draft.shortBreakMinutes, base.shortBreakMinutes),
    longBreakMinutes: clampMinutes(draft.longBreakMinutes, base.longBreakMinutes),
    longBreakEvery: clampMinutes(draft.longBreakEvery, base.longBreakEvery, POMODORO_EVERY_MAX),
    sound: normalizeSoundName(draft.sound) ?? base.sound,
    tick: draft.tick,
    autoStart: base.autoStart,
  };
}

export interface PomodoroSettingsFormProps {
  prefs: PomodoroPrefs;
  /** True while a pomodoro runs: say that the change lands on the next one. */
  running?: boolean;
  onSave: (prefs: PomodoroPrefs) => void;
  onPreview?: (sound: SoundName) => void;
  onCancel: () => void;
}

/** The fields themselves — the lengths, the sound, the tick. */
export function PomodoroSettingsForm({
  prefs,
  running,
  onSave,
  onPreview = preview,
  onCancel,
}: PomodoroSettingsFormProps) {
  const [form, setForm] = useState<PomodoroForm>(() => formOf(prefs));
  const field = (key: keyof PomodoroForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const minutes = (key: "workMinutes" | "shortBreakMinutes" | "longBreakMinutes", label: string) => (
    <label className="pomodoro-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={POMODORO_MINUTES_MAX}
        value={form[key]}
        aria-label={`${label} minutes`}
        onChange={field(key)}
      />
    </label>
  );
  return (
    <>
      <h3>Pomodoro settings</h3>
      <p className="hint">
        {running
          ? "The pomodoro that is running keeps the lengths it started with; these apply to the next one."
          : "Focus for one pomodoro at a time, then take a break; a pomodoro cannot be paused, only abandoned."}
      </p>
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(parsePomodoroForm(form, prefs));
        }}
      >
        <div className="pomodoro-fields">
          {minutes("workMinutes", "Focus")}
          {minutes("shortBreakMinutes", "Short break")}
          {minutes("longBreakMinutes", "Long break")}
          <label className="pomodoro-field">
            <span>Long break every</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={POMODORO_EVERY_MAX}
              value={form.longBreakEvery}
              aria-label="Pomodoros between long breaks"
              onChange={field("longBreakEvery")}
            />
          </label>
        </div>
        <label className="pomodoro-field sound-row">
          <span>Sound when an interval ends</span>
          <span className="sound-pick">
            <select value={form.sound} aria-label="Sound" onChange={field("sound")}>
              {SOUND_NAMES.map((s) => (
                <option key={s} value={s}>
                  {SOUND_LABEL[s]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ibtn"
              aria-label="Preview sound"
              title="Preview"
              disabled={form.sound === "none"}
              onClick={() => onPreview(form.sound)}
            >
              <Play size={13} aria-hidden="true" />
            </button>
          </span>
        </label>
        <label className="pomodoro-switch-row">
          <span>
            Tick during focus
            <span className="hint">A soft tick each second, the way the kitchen timer did.</span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={form.tick}
              onChange={(e) => setForm((f) => ({ ...f, tick: e.target.checked }))}
            />
            <span className="switch-track" aria-hidden="true" />
          </span>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </>
  );
}

export interface PomodoroSettingsDialogProps {
  prefs: PomodoroPrefs;
  running?: boolean;
  onSave: (prefs: PomodoroPrefs) => void;
  onClose: () => void;
}

/** The form in the app's modal frame. */
export function PomodoroSettingsDialog({ prefs, running, onSave, onClose }: PomodoroSettingsDialogProps) {
  const trapRef = useFocusTrap(true);
  return (
    <div
      className="dialog-backdrop"
      {...backdropDismiss(onClose)}
      onKeyDown={(e) => {
        // ESC closes only this dialog (specs/ui/ui.feature.md "Dialogs").
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="dialog modal-dialog pomodoro-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Pomodoro settings"
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <PomodoroSettingsForm prefs={prefs} running={running} onSave={onSave} onCancel={onClose} />
      </div>
    </div>
  );
}

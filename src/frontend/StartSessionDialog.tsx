// The Start session dialog (roadmap/support-for-human-code-sessions.md):
// one dialog, two kinds of session. The AI tab is the session dialog as it
// was — a name, "Run in", the selection it runs over
// (specs/launch-ai-agent-session.feature.md) — and the Pomodoro tab names a
// session the person runs themself: the interval lengths, the sound that
// announces a break, and whether to hear the clock tick. The Pomodoro tab
// needs no specs selected and no code generation switched on.
//
// The pieces are pure and exported so bun test can render them without a
// DOM (tests/startSessionDialog.test.tsx).

import { useEffect, useRef, useState } from "react";
import { Play, Square, Timer } from "lucide-react";
import { PromptChoices, confirmLabelOf, initialChoiceOf } from "./ModalPrompts";
import type { PromptOptions } from "./ModalPrompts";
import { clampMinutes } from "./pomodoro";
import type { PomodoroPrefs } from "./pomodoro";
import { SOUND_LABEL, SOUND_NAMES, normalizeSoundName } from "./sounds";
import type { SoundName } from "./sounds";
import { useFocusTrap } from "./useFocusTrap";
import { POMODORO_EVERY_MAX, POMODORO_MINUTES_MAX } from "../server/humanSessionRules";

export type StartTab = "ai" | "pomodoro";

export const START_TAB_LABEL: Record<StartTab, string> = {
  ai: "AI session",
  pomodoro: "Pomodoro",
};

/** Why the AI tab is off, if it is: the same gating the old button had. */
export function aiTabState(a: {
  codeGen: boolean;
  specCount: number;
  sessionRunning: boolean;
}): { enabled: boolean; hint: string | null } {
  if (!a.codeGen) return { enabled: false, hint: "Code generation is switched off in Settings." };
  if (a.sessionRunning) return { enabled: false, hint: "A session is already starting." };
  if (a.specCount === 0) {
    return { enabled: false, hint: "Select a spec in the sidebar, or single scenarios on their cards." };
  }
  return { enabled: true, hint: null };
}

/** The Pomodoro form's text as preferences: each number clamped, the rest checked. */
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

/** The two-way pick at the top of the dialog. */
export function StartSessionTabs({ tab, onChange }: { tab: StartTab; onChange: (tab: StartTab) => void }) {
  return (
    <div className="seg start-tabs" role="tablist" aria-label="Kind of session">
      {(["ai", "pomodoro"] as StartTab[]).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          className={`seg-opt${t === tab ? " on" : ""}`}
          aria-selected={t === tab}
          onClick={() => onChange(t)}
        >
          {t === "ai" ? <Play size={12} aria-hidden="true" /> : <Timer size={12} aria-hidden="true" />}
          {START_TAB_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

export interface AiTabProps {
  /** The dialog the AI session used to open on its own: title, hint, name, "Run in". */
  dialog: PromptOptions;
  state: { enabled: boolean; hint: string | null };
  /** The name and the picked "Run in" value (null when there was no choice). */
  onConfirm: (name: string, choice: string | null) => void;
  onCancel: () => void;
}

/** The AI session's fields — what ModalDialog renders for promptWithChoice. */
export function AiSessionFields({ dialog, state, onConfirm, onCancel }: AiTabProps) {
  const [draft, setDraft] = useState(dialog.initial ?? "");
  const [choice, setChoice] = useState<string | null>(initialChoiceOf(dialog));
  const inputRef = useRef<HTMLInputElement>(null);
  // The suggested name is there to be replaced: selected once, so typing
  // overwrites it (ModalDialog does the same).
  useEffect(() => {
    if (dialog.initial) inputRef.current?.select();
  }, [dialog.initial]);
  const choices = dialog.choices ?? [];
  return (
    <>
      <h3>{dialog.title}</h3>
      {dialog.hint && <p className="hint">{dialog.hint}</p>}
      {state.hint && <p className="hint start-off">{state.hint}</p>}
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!state.enabled || !draft.trim()) return;
          onConfirm(draft.trim(), choice);
        }}
      >
        <div className="input-row">
          <input
            autoFocus
            ref={inputRef}
            value={draft}
            placeholder={dialog.placeholder}
            aria-label="Session name"
            disabled={!state.enabled}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        {choices.length > 0 && (
          <PromptChoices label={dialog.choicesLabel} choices={choices} value={choice} onChange={setChoice} />
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={!state.enabled || !draft.trim()}>
            {confirmLabelOf(dialog, choice)}
          </button>
        </div>
      </form>
    </>
  );
}

export interface PomodoroTabProps {
  prefs: PomodoroPrefs;
  /** A Pomodoro session is already on: offer to end it instead. */
  running: boolean;
  initialName: string;
  onConfirm: (name: string, prefs: PomodoroPrefs) => void;
  onPreview: (sound: SoundName) => void;
  onEnd: () => void;
  onCancel: () => void;
}

/** The Pomodoro session's fields: a name, the intervals, the sound. */
export function PomodoroFields({ prefs, running, initialName, onConfirm, onPreview, onEnd, onCancel }: PomodoroTabProps) {
  const [name, setName] = useState(initialName);
  const [form, setForm] = useState<PomodoroForm>(() => formOf(prefs));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (initialName) inputRef.current?.select();
  }, [initialName]);
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
  if (running) {
    return (
      <>
        <h3>Start a Pomodoro</h3>
        <p className="hint">A Pomodoro session is running — its timer is at the bottom of the sidebar.</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onEnd}>
            <Square size={12} aria-hidden="true" /> End session
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <h3>Start a Pomodoro</h3>
      <p className="hint">
        Focus for one pomodoro at a time, then take a break; a pomodoro cannot be paused, only abandoned.
        The time is kept on this machine.
      </p>
      <form
        className="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onConfirm(name.trim(), parsePomodoroForm(form, prefs));
        }}
      >
        <div className="input-row">
          <input
            autoFocus
            ref={inputRef}
            value={name}
            placeholder="e.g. write the quotes spec"
            aria-label="Session name"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
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
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={!name.trim()}>
            Start Pomodoro
          </button>
        </div>
      </form>
    </>
  );
}

export interface StartSessionDialogProps {
  initialTab: StartTab;
  ai: Omit<AiTabProps, "onCancel">;
  pomodoro: Omit<PomodoroTabProps, "onCancel">;
  onClose: () => void;
}

export function StartSessionDialog({ initialTab, ai, pomodoro, onClose }: StartSessionDialogProps) {
  const [tab, setTab] = useState<StartTab>(initialTab);
  const trapRef = useFocusTrap(true);
  return (
    <div
      className="dialog-backdrop"
      onClick={onClose}
      onKeyDown={(e) => {
        // ESC closes only this dialog (specs/ui.spec.md "Dialogs").
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="dialog modal-dialog start-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tab === "ai" ? ai.dialog.title : "Start a Pomodoro"}
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <StartSessionTabs tab={tab} onChange={setTab} />
        {tab === "ai" ? (
          <AiSessionFields key="ai" {...ai} onCancel={onClose} />
        ) : (
          <PomodoroFields key="pomodoro" {...pomodoro} onCancel={onClose} />
        )}
      </div>
    </div>
  );
}

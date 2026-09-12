// The Start session dialog (specs/launch-ai-agent-session.feature.md): a
// name, "Run in", and the selection the session runs over. It is about
// handing specs to a coding agent, and nothing else — timing your own work is
// the Pomodoro (src/frontend/PomodoroBar.tsx), a feature of the app with its
// own button, not a kind of session.
//
// The pieces are pure and exported so bun test can render them without a
// DOM (tests/startSessionDialog.test.tsx).

import { useEffect, useRef, useState } from "react";
import { PromptChoices, confirmLabelOf, initialChoiceOf } from "./ModalPrompts";
import type { PromptOptions } from "./ModalPrompts";
import { useFocusTrap } from "./useFocusTrap";

/** Why the dialog's confirm is off, if it is: the gating the button had. */
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

export interface AiTabProps {
  /** The dialog's title, hint, name and "Run in". */
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

export interface StartSessionDialogProps {
  ai: Omit<AiTabProps, "onCancel">;
  onClose: () => void;
}

export function StartSessionDialog({ ai, onClose }: StartSessionDialogProps) {
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
        aria-label={ai.dialog.title}
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <AiSessionFields {...ai} onCancel={onClose} />
      </div>
    </div>
  );
}

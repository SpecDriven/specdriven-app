// In-app prompt/confirm dialogs (specs/ui/ui.feature.md "Dialogs"):
// promise-based stand-ins for window.prompt / window.confirm. The desktop
// runtime has no native prompt() at all (specs/app/desktop-app.feature.md
// "Dialogs"), and the native boxes never matched the design system anyway.

import { useEffect, useRef, useState } from "react";
import { backdropDismiss } from "./backdropDismiss";
import type { ReactNode } from "react";
import { useFocusTrap } from "./useFocusTrap";

export interface PromptOptions {
  title: string;
  /** Secondary line under the title, e.g. naming rules. */
  hint?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Confirming a blank field answers "" rather than staying disabled — for clearing a value. */
  allowEmpty?: boolean;
  /**
   * Native picker (specs/ui/app-start.feature.md "picking the data directory
   * with the native folder chooser"): shown as a Browse… button beside the
   * input; a non-null result replaces the draft, null (canceled) leaves it
   * alone.
   */
  browse?: () => Promise<string | null>;
  browseLabel?: string;
  /**
   * A radio group under the field (specs/agents/claude.feature.md "Run in"):
   * one of a few ways to act on the text. Read back through
   * promptWithChoice; plain prompt ignores which one was picked.
   */
  choices?: PromptChoice[];
  /** The group's legend, e.g. "Run in". */
  choicesLabel?: string;
  /** Preselected value; the first choice when absent or unknown. */
  initialChoice?: string;
}

export interface PromptChoice {
  label: string;
  value: string;
  /** Secondary line under the label. */
  hint?: string;
  /** Confirm-button label while this choice is picked — for an option that
      does something other than what the dialog's own confirmLabel says. */
  confirmLabel?: string;
}

/** What a prompt with choices resolves to: the text and the picked value. */
export interface PromptResult {
  text: string;
  /** null when the prompt offered no choices. */
  choice: string | null;
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  /** False for a confirm that makes rather than destroys — a plain button. */
  danger?: boolean;
}

/**
 * A choice from a list too long for a radio group — the feature a scenario
 * moves to (specs/ui/navigation.feature.md "move a scenario to another
 * feature"): a filter field over a list, picked by click or by the arrow
 * keys and Enter.
 */
export interface PickOptions {
  title: string;
  hint?: string;
  placeholder?: string;
  options: PickOption[];
  /** Shown in place of the list when nothing matches the filter. */
  empty?: string;
}

export interface PickOption {
  value: string;
  label: string;
  /** Secondary line under the label, e.g. the folder the feature is in. */
  hint?: string;
}

type Request =
  | { kind: "prompt"; opts: PromptOptions; resolve: (value: PromptResult | null) => void }
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "pick"; opts: PickOptions; resolve: (value: string | null) => void };

/** The options a pick dialog shows for a filter: label or hint contains it. */
export function filterPickOptions(options: PickOption[], filter: string): PickOption[] {
  const q = filter.trim().toLowerCase();
  if (!q) return options;
  return options.filter(
    (o) => o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q),
  );
}

/** The choice a prompt starts on: the initial one if offered, else the first. */
export function initialChoiceOf(opts: PromptOptions): string | null {
  const choices = opts.choices ?? [];
  if (choices.length === 0) return null;
  const wanted = choices.find((c) => c.value === opts.initialChoice);
  return (wanted ?? choices[0]!).value;
}

/** The confirm button's label: the picked choice's own, else the dialog's. */
export function confirmLabelOf(opts: PromptOptions, choice: string | null): string {
  const picked = (opts.choices ?? []).find((c) => c.value === choice);
  return picked?.confirmLabel ?? opts.confirmLabel ?? "OK";
}

/**
 * Returns `prompt`/`confirm` that resolve like their window counterparts
 * (null / false on cancel), plus the `modal` element to render and a
 * `modalOpen` flag for keyboard handlers that must idle behind a dialog.
 * `promptWithChoice` is `prompt` for a dialog with a radio group: it
 * resolves the text together with the picked value. `pick` resolves the
 * value of the option picked from a list, null on cancel.
 */
export function useModalPrompts() {
  const [request, setRequest] = useState<Request | null>(null);
  const [seq, setSeq] = useState(0);

  const open = (req: Request) => {
    setSeq((n) => n + 1);
    setRequest(req);
  };

  const promptWithChoice = (opts: PromptOptions): Promise<PromptResult | null> =>
    new Promise((resolve) => open({ kind: "prompt", opts, resolve }));

  const prompt = (opts: PromptOptions): Promise<string | null> =>
    promptWithChoice(opts).then((result) => (result === null ? null : result.text));

  const confirm = (opts: ConfirmOptions): Promise<boolean> =>
    new Promise((resolve) => open({ kind: "confirm", opts, resolve }));

  const pick = (opts: PickOptions): Promise<string | null> =>
    new Promise((resolve) => open({ kind: "pick", opts, resolve }));

  // Keyed by request so a fresh prompt starts from its own initial draft.
  const modal: ReactNode = request ? (
    request.kind === "pick" ? (
      <PickDialog key={seq} request={request} close={() => setRequest(null)} />
    ) : (
      <ModalDialog key={seq} request={request} close={() => setRequest(null)} />
    )
  ) : null;

  return { modal, modalOpen: request !== null, prompt, promptWithChoice, confirm, pick };
}

/** The radio group of a prompt with choices — pure, so tests can render it. */
export function PromptChoices({
  label,
  choices,
  value,
  onChange,
}: {
  label?: string;
  choices: PromptChoice[];
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="choice-group" role="radiogroup" aria-label={label}>
      {label && <legend>{label}</legend>}
      {choices.map((c) => (
        <label key={c.value} className="choice">
          <input
            type="radio"
            name="modal-choice"
            value={c.value}
            aria-label={c.label}
            checked={c.value === value}
            onChange={() => onChange(c.value)}
          />
          <span className="choice-label">
            {c.label}
            {c.hint && <span className="hint">{c.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function ModalDialog({
  request,
  close,
}: {
  request: Exclude<Request, { kind: "pick" }>;
  close: () => void;
}) {
  const trapRef = useFocusTrap(true);
  const [draft, setDraft] = useState(
    request.kind === "prompt" ? (request.opts.initial ?? "") : "",
  );
  const [choice, setChoice] = useState<string | null>(
    request.kind === "prompt" ? initialChoiceOf(request.opts) : null,
  );
  const [browsing, setBrowsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // A prefilled draft (a suggested session name) is there to be replaced:
  // selected once the dialog is up, so typing overwrites it. Once only —
  // clicking back into the field later must not grab the whole text again.
  useEffect(() => {
    if (request.kind === "prompt" && request.opts.initial) inputRef.current?.select();
  }, [request]);

  const browse = async () => {
    if (request.kind !== "prompt" || !request.opts.browse) return;
    setBrowsing(true);
    try {
      const picked = await request.opts.browse();
      if (picked) setDraft(picked);
    } finally {
      setBrowsing(false);
    }
  };

  const cancel = () => {
    close();
    if (request.kind === "prompt") request.resolve(null);
    else request.resolve(false);
  };
  const confirm = () => {
    if (request.kind === "prompt" && !draft.trim() && !request.opts.allowEmpty) return;
    close();
    // Trimmed for every caller (specs/ui/ui.feature.md "User-entered text is
    // cleaned up"); only trimmed, as a prompt also takes paths and urls —
    // one asking for a name cleans it further (cleanLine).
    if (request.kind === "prompt") request.resolve({ text: draft.trim(), choice });
    else request.resolve(true);
  };

  return (
    <div
      className="dialog-backdrop"
      {...backdropDismiss(cancel)}
      onKeyDown={(e) => {
        // ESC closes only this dialog — never the one it may be stacked on
        // (specs/ui/ui.feature.md "Dialogs").
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          cancel();
        }
      }}
    >
      <div
        className="dialog modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={request.opts.title}
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{request.opts.title}</h3>
        {request.kind === "prompt" ? (
          <>
            {request.opts.hint && <p className="hint">{request.opts.hint}</p>}
            <form
              className="modal-form"
              onSubmit={(e) => {
                e.preventDefault();
                confirm();
              }}
            >
              <div className="input-row">
                <input
                  autoFocus
                  ref={inputRef}
                  value={draft}
                  placeholder={request.opts.placeholder}
                  onChange={(e) => setDraft(e.target.value)}
                />
                {request.opts.browse && (
                  <button
                    type="button"
                    className="browse"
                    disabled={browsing}
                    onClick={() => void browse()}
                  >
                    {request.opts.browseLabel ?? "Browse…"}
                  </button>
                )}
              </div>
              {request.opts.choices && request.opts.choices.length > 0 && (
                <PromptChoices
                  label={request.opts.choicesLabel}
                  choices={request.opts.choices}
                  value={choice}
                  onChange={setChoice}
                />
              )}
              <div className="dialog-actions">
                <button type="button" className="secondary" onClick={cancel}>
                  Cancel
                </button>
                <button type="submit" disabled={!draft.trim() && !request.opts.allowEmpty}>
                  {confirmLabelOf(request.opts, choice)}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            {request.opts.body && <p className="modal-body">{request.opts.body}</p>}
            <div className="dialog-actions">
              <button className="secondary" onClick={cancel}>
                Cancel
              </button>
              <button className={request.opts.danger === false ? undefined : "danger-solid"} onClick={confirm}>
                {request.opts.confirmLabel ?? "Delete"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PickDialog({
  request,
  close,
}: {
  request: Extract<Request, { kind: "pick" }>;
  close: () => void;
}) {
  const trapRef = useFocusTrap(true);
  const listRef = useRef<HTMLUListElement>(null);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const { opts } = request;
  const shown = filterPickOptions(opts.options, filter);
  const at = Math.min(active, shown.length - 1);

  // The active row stays in view as the arrow keys walk a long list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [at, filter]);

  const cancel = () => {
    close();
    request.resolve(null);
  };
  const choose = (option: PickOption | undefined) => {
    if (!option) return;
    close();
    request.resolve(option.value);
  };

  return (
    <div
      className="dialog-backdrop"
      {...backdropDismiss(cancel)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          cancel();
        }
      }}
    >
      <div
        className="dialog modal-dialog pick-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={opts.title}
        ref={trapRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{opts.title}</h3>
        {opts.hint && <p className="hint">{opts.hint}</p>}
        <form
          className="modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            choose(shown[at]);
          }}
        >
          <input
            autoFocus
            value={filter}
            placeholder={opts.placeholder}
            role="combobox"
            aria-expanded="true"
            aria-controls="pick-options"
            aria-activedescendant={shown[at] ? `pick-option-${at}` : undefined}
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActive(Math.max(0, Math.min(shown.length - 1, at + step)));
              }
            }}
          />
          {shown.length === 0 ? (
            <p className="hint pick-empty">{opts.empty ?? "Nothing matches"}</p>
          ) : (
            <ul className="pick-options" id="pick-options" role="listbox" ref={listRef}>
              {shown.map((o, i) => (
                <li
                  key={o.value}
                  id={`pick-option-${i}`}
                  role="option"
                  aria-selected={i === at}
                  className={`pick-option${i === at ? " active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o)}
                >
                  <span className="pick-label">{o.label}</span>
                  {o.hint && <span className="hint">{o.hint}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={cancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

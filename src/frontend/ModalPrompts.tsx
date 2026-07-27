// In-app prompt/confirm dialogs (specs/ui.spec.md "Dialogs"): promise-based
// stand-ins for window.prompt / window.confirm. The desktop runtime has no
// native prompt() at all (specs/desktop-app.spec.md "Dialogs"), and the
// native boxes never matched the design system anyway.

import { useState } from "react";
import type { ReactNode } from "react";
import { useFocusTrap } from "./useFocusTrap";

export interface PromptOptions {
  title: string;
  /** Secondary line under the title, e.g. naming rules. */
  hint?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  /**
   * Native picker (specs/app-start.spec.md "picking the data directory with
   * the native folder chooser"): shown as a Browse… button beside the input;
   * a non-null result replaces the draft, null (canceled) leaves it alone.
   */
  browse?: () => Promise<string | null>;
  browseLabel?: string;
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
}

type Request =
  | { kind: "prompt"; opts: PromptOptions; resolve: (value: string | null) => void }
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (value: boolean) => void };

/**
 * Returns `prompt`/`confirm` that resolve like their window counterparts
 * (null / false on cancel), plus the `modal` element to render and a
 * `modalOpen` flag for keyboard handlers that must idle behind a dialog.
 */
export function useModalPrompts() {
  const [request, setRequest] = useState<Request | null>(null);
  const [seq, setSeq] = useState(0);

  const open = (req: Request) => {
    setSeq((n) => n + 1);
    setRequest(req);
  };

  const prompt = (opts: PromptOptions): Promise<string | null> =>
    new Promise((resolve) => open({ kind: "prompt", opts, resolve }));

  const confirm = (opts: ConfirmOptions): Promise<boolean> =>
    new Promise((resolve) => open({ kind: "confirm", opts, resolve }));

  // Keyed by request so a fresh prompt starts from its own initial draft.
  const modal: ReactNode = request ? (
    <ModalDialog key={seq} request={request} close={() => setRequest(null)} />
  ) : null;

  return { modal, modalOpen: request !== null, prompt, confirm };
}

function ModalDialog({ request, close }: { request: Request; close: () => void }) {
  const trapRef = useFocusTrap(true);
  const [draft, setDraft] = useState(
    request.kind === "prompt" ? (request.opts.initial ?? "") : "",
  );
  const [browsing, setBrowsing] = useState(false);

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
    if (request.kind === "prompt" && !draft.trim()) return;
    close();
    if (request.kind === "prompt") request.resolve(draft);
    else request.resolve(true);
  };

  return (
    <div
      className="dialog-backdrop"
      onClick={cancel}
      onKeyDown={(e) => {
        // ESC closes only this dialog — never the one it may be stacked on
        // (specs/ui.spec.md "Dialogs").
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          cancel();
        }
      }}
    >
      <div className="dialog modal-dialog" ref={trapRef} onClick={(e) => e.stopPropagation()}>
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
              <div className="dialog-actions">
                <button type="button" className="secondary" onClick={cancel}>
                  Cancel
                </button>
                <button type="submit" disabled={!draft.trim()}>
                  {request.opts.confirmLabel ?? "OK"}
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
              <button className="danger-solid" onClick={confirm}>
                {request.opts.confirmLabel ?? "Delete"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

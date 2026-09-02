import { useEffect, useState, useSyncExternalStore } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

/**
 * Toasts (specs/ui/ui.feature.md "Design system"): the one place transient
 * feedback lands. A stack in the lower left; a success fades after 3.5 s
 * (5 s when it offers Undo), an error stays until dismissed. Success and
 * info rows are `role="status"` (a polite live region), errors
 * `role="alert"`, so assistive tech hears what sighted users see. The same
 * message showing twice refreshes the existing toast rather than stacking —
 * an autosave that keeps failing says so once.
 */
export type ToastKind = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

let items: ToastItem[] = [];
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  for (const l of listeners) l();
}

export function dismissToast(id: number) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  if (!items.some((i) => i.id === id)) return;
  items = items.filter((i) => i.id !== id);
  emit();
}

function push(kind: ToastKind, message: string, opts: { action?: ToastAction } = {}): number {
  const existing = items.find((i) => i.kind === kind && i.message === message);
  if (existing) dismissToast(existing.id);
  const id = nextId++;
  items = [...items, { id, kind, message, action: opts.action }];
  emit();
  const ttl = kind === "error" ? null : opts.action ? 5000 : 3500;
  if (ttl !== null) timers.set(id, setTimeout(() => dismissToast(id), ttl));
  return id;
}

export const toast = {
  success: (message: string, opts?: { action?: ToastAction }) => push("success", message, opts),
  info: (message: string, opts?: { action?: ToastAction }) => push("info", message, opts),
  error: (message: string, opts?: { action?: ToastAction }) => push("error", message, opts),
  dismiss: dismissToast,
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => items);
  if (list.length === 0) return null;
  return (
    <div className="toaster">
      {list.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}`}
          role={t.kind === "error" ? "alert" : "status"}
        >
          {t.kind === "success" && <CircleCheck size={16} aria-hidden="true" />}
          {t.kind === "error" && <CircleAlert size={16} aria-hidden="true" />}
          {t.kind === "info" && <Info size={16} aria-hidden="true" />}
          <span className="toast-message">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismissToast(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The quiet autosave indicator in a page header: "Saving…" while a save is
 * away, "Saved · 12s ago" after the last one landed, "Unsaved" while an
 * edit is waiting for the next tick. Replaces the "Saved" banner — autosave
 * is routine, not news.
 */
export function SaveIndicator({
  saving,
  savedAt,
  dirty = false,
}: {
  saving: boolean;
  savedAt: number | null;
  dirty?: boolean;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (savedAt === null) return;
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, [savedAt]);
  let text: string | null = null;
  if (saving) text = "Saving…";
  else if (dirty) text = "Unsaved";
  else if (savedAt !== null) {
    const s = Math.round((Date.now() - savedAt) / 1000);
    text = s < 10 ? "Saved" : s < 60 ? `Saved · ${s}s ago` : `Saved · ${Math.round(s / 60)}m ago`;
  }
  if (!text) return null;
  return <span className={`save-indicator${dirty && !saving ? " unsaved" : ""}`}>{text}</span>;
}

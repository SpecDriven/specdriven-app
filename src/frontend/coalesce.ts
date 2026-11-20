// Many calls, few runs: what a burst of "something changed" events wants
// from the refresh they ask for. No imports, so a test can take it alone.

export interface Coalesced {
  /** Ask for a run. */
  (): void;
  /** Drop a run that is waiting; one already going finishes. */
  cancel(): void;
}

/**
 * `work`, run once shortly after the latest call rather than once per call:
 * calls within `delayMs` of each other share one run, and a call that comes
 * while a run is going earns one more after it, so the last change is never
 * left unread and two runs never overlap. A run that fails is not retried —
 * the next call is.
 */
export function coalesced(work: () => Promise<void>, delayMs: number): Coalesced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let cancelled = false;

  const run = async (): Promise<void> => {
    timer = null;
    running = true;
    try {
      await work();
    } catch {
      // The caller's work reports its own failures.
    } finally {
      running = false;
      if (again && !cancelled) {
        again = false;
        timer = setTimeout(() => void run(), delayMs);
      }
    }
  };

  const ask = (() => {
    cancelled = false;
    if (running) {
      again = true;
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void run(), delayMs);
  }) as Coalesced;
  ask.cancel = () => {
    cancelled = true;
    again = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return ask;
}

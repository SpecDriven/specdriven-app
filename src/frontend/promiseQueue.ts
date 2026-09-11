/**
 * One-at-a-time async work, in the order it was queued. The page editor's
 * autosave and the Done / Assigned writes share a queue so a late tick cannot
 * overwrite a marker that landed, and so navigating away waits for the write
 * that is already on its way. Event Model canvas PUTs use the same helper so
 * a slow autosave cannot last-write-wins a later edit (or a feature-link).
 */
export function createPromiseQueue(): {
  run<T>(fn: () => Promise<T>): Promise<T>;
  idle(): Promise<void>;
} {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn, fn);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    idle() {
      return tail;
    },
  };
}

// Which connections have outlived the pass they were opened with, and when
// the next one will: what the room's alarm (src/worker.ts) acts on. A timer
// per connection would do the same, but a pending timer keeps a Durable
// Object awake, and billed; an alarm does not.

export interface Sweep<T> {
  /** The connections whose pass has run out: to be closed. */
  expired: T[];
  /** When the next pass runs out, in ms since the epoch; null when none is left. */
  nextAt: number | null;
}

/** `expiresAt` is in seconds since the epoch, as on a pass; `now` in ms. */
export function sweep<T extends { expiresAt: number }>(connections: Iterable<T>, now: number): Sweep<T> {
  const expired: T[] = [];
  let nextAt: number | null = null;
  for (const connection of connections) {
    const at = connection.expiresAt * 1000;
    if (at <= now) expired.push(connection);
    else if (nextAt === null || at < nextAt) nextAt = at;
  }
  return { expired, nextAt };
}

// The feature list survives a blip. Demo mode (src/server/demo.ts) reseeds
// the data directory on every page load and runs with
// reloadFrequencySeconds 0, so the cron refresh never covers for a failed
// load — the boot load is the only one there is. fetchListing therefore
// retries the failures a later try can still answer, and gives up on the
// ones it cannot.
import { describe, expect, test } from "bun:test";
import { LOAD_RETRIES, fetchListing } from "../src/frontend/App";

// Replies are thunks, not Responses: a Response body reads only once, and
// the last reply is reused for every attempt past the end of the script.
type Reply = () => Response | Error;

/** A fetch stub over a queued script of replies, counting the calls. */
function stubFetch(replies: Reply[]) {
  const calls: string[] = [];
  const fn = ((url: string) => {
    calls.push(String(url));
    const next = (replies[calls.length - 1] ?? replies[replies.length - 1])!();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok =
  (body: object): Reply =>
  () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fail =
  (status: number, error: string): Reply =>
  () =>
    new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
const threw =
  (message: string): Reply =>
  () =>
    new TypeError(message);

const LISTING = {
  features: [{ fileName: "specs/billing/collect-premium.feature.md", name: "Collect Premium", scenarios: [] }],
  folders: ["specs/billing"],
  members: [],
  codeRepo: null,
  issuesRepo: null,
};

/** Sleeps resolve immediately, so the backoff costs the test no wall clock. */
const noSleep = () => Promise.resolve();

describe("fetchListing", () => {
  test("returns the listing when the first try succeeds", async () => {
    const { fn, calls } = stubFetch([ok(LISTING)]);
    const result = await fetchListing(fn, noSleep);
    expect(result).toHaveProperty("listing");
    if ("listing" in result) {
      expect(result.listing.features).toHaveLength(1);
      expect(result.listing.folders).toEqual(["specs/billing"]);
    }
    expect(calls).toHaveLength(1);
  });

  test("retries a fetch that threw, then succeeds", async () => {
    // The demo's reseed can drop a connection mid-flight; the next try lands
    // on the new generation directory and answers.
    const { fn, calls } = stubFetch([threw("network error"), ok(LISTING)]);
    const result = await fetchListing(fn, noSleep);
    expect(result).toHaveProperty("listing");
    expect(calls).toHaveLength(2);
  });

  test("retries a 500, then succeeds", async () => {
    const { fn, calls } = stubFetch([fail(500, "boom"), fail(500, "boom"), ok(LISTING)]);
    const result = await fetchListing(fn, noSleep);
    expect(result).toHaveProperty("listing");
    expect(calls).toHaveLength(3);
  });

  test("reports the last error after exhausting the retries", async () => {
    const { fn, calls } = stubFetch([fail(500, "still broken")]);
    const result = await fetchListing(fn, noSleep);
    expect(result).toEqual({ error: "still broken", attempts: LOAD_RETRIES });
    expect(calls).toHaveLength(LOAD_RETRIES);
  });

  test("gives up at once on 409 — no data repo is an answer, not a blip", async () => {
    const { fn, calls } = stubFetch([fail(409, "data repo not configured")]);
    const result = await fetchListing(fn, noSleep);
    expect(result).toEqual({ error: "data repo not configured", attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  test("a thrown fetch that never recovers reports the thrown message", async () => {
    const { fn, calls } = stubFetch([threw("Failed to fetch")]);
    const result = await fetchListing(fn, noSleep);
    expect(result).toEqual({ error: "Failed to fetch", attempts: LOAD_RETRIES });
    expect(calls).toHaveLength(LOAD_RETRIES);
  });

  test("backs off further with each attempt", async () => {
    const waits: number[] = [];
    const { fn } = stubFetch([fail(500, "boom"), fail(500, "boom"), ok(LISTING)]);
    await fetchListing(fn, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    });
    // No wait before the first try; each later one waits longer than the last.
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(waits[0]!);
  });
});

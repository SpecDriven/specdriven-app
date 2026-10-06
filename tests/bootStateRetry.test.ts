// The page's first read (specs/ui/app-start.feature.md "the server cannot be
// reached at start"). In the browser the API is a separate `bun run dev`
// process; with it gone the boot fetch is refused, and an unhandled refusal
// used to leave the loading skeleton up for good. fetchBootState retries the
// fetches that threw and reports a failure instead of throwing, so the page
// can say the server is unreachable and keep trying.
import { describe, expect, test } from "bun:test";
import { LOAD_RETRIES, fetchBootState } from "../src/frontend/App";

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
const refused: Reply = () => new TypeError("Failed to fetch");

const STATE = { needsDataRepo: false, dataRepo: "/data/specs", plugins: [] };

const noSleep = () => Promise.resolve();

describe("fetchBootState", () => {
  test("returns the state when the server answers", async () => {
    const { fn, calls } = stubFetch([ok(STATE)]);
    const result = await fetchBootState(fn, noSleep);
    expect(result).toEqual({ state: STATE });
    expect(calls).toEqual(["/api/state?boot=1"]);
  });

  test("retries a refused fetch and returns the state once the server answers", async () => {
    const { fn, calls } = stubFetch([refused, ok(STATE)]);
    const result = await fetchBootState(fn, noSleep);
    expect(result).toEqual({ state: STATE });
    expect(calls).toHaveLength(2);
  });

  test("reports the server unreachable after every try is refused, without throwing", async () => {
    const { fn, calls } = stubFetch([refused]);
    const result = await fetchBootState(fn, noSleep);
    expect(result).toEqual({ error: { message: "Failed to fetch", unreachable: true } });
    expect(calls).toHaveLength(LOAD_RETRIES);
  });

  test("an error answer is reported with the server's message and not retried", async () => {
    const { fn, calls } = stubFetch([fail(403, 'Requests for host "box.lan:3000" are not served')]);
    const result = await fetchBootState(fn, noSleep);
    expect(result).toEqual({
      error: { message: 'Requests for host "box.lan:3000" are not served', unreachable: false },
    });
    expect(calls).toHaveLength(1);
  });

  test("a server that never answers is reported as stuck after the timeout, not retried", async () => {
    let calls = 0;
    const hang = ((_url: string, init?: RequestInit) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as unknown as typeof fetch;
    const result = await fetchBootState(hang, noSleep, 20);
    expect(result).toEqual({
      error: { message: "The server did not answer within 0.02 s", unreachable: true },
    });
    expect(calls).toBe(1);
  });

  test("a body that is not JSON is reported by its status", async () => {
    const { fn } = stubFetch([() => new Response("Bad Gateway", { status: 502 })]);
    const result = await fetchBootState(fn, noSleep);
    expect(result).toEqual({ error: { message: "The server answered 502", unreachable: false } });
  });
});

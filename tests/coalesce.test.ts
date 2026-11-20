// Many "something changed" events, few refreshes (src/frontend/coalesce.ts):
// what keeps a peer catching up over live sync from re-reading the view once
// per feature.

import { test, expect } from "bun:test";
import { coalesced } from "../src/frontend/coalesce";

test("calls that come together share one run", async () => {
  let runs = 0;
  const ask = coalesced(async () => void runs++, 10);
  ask();
  ask();
  ask();
  expect(runs).toBe(0);
  await Bun.sleep(40);
  expect(runs).toBe(1);
});

test("a call during a run earns one more run after it, never two at a time", async () => {
  let runs = 0;
  let going = 0;
  let most = 0;
  const ask = coalesced(async () => {
    runs++;
    most = Math.max(most, ++going);
    await Bun.sleep(30);
    going--;
  }, 5);
  ask();
  await Bun.sleep(15); // the first run is going
  ask();
  ask();
  await Bun.sleep(120);
  expect(runs).toBe(2);
  expect(most).toBe(1);
});

test("a run that fails does not stop the next call from running", async () => {
  let runs = 0;
  const ask = coalesced(async () => {
    if (++runs === 1) throw new Error("offline");
  }, 5);
  ask();
  await Bun.sleep(25);
  ask();
  await Bun.sleep(25);
  expect(runs).toBe(2);
});

test("cancel drops a run that is waiting", async () => {
  let runs = 0;
  const ask = coalesced(async () => void runs++, 10);
  ask();
  ask.cancel();
  await Bun.sleep(30);
  expect(runs).toBe(0);
});

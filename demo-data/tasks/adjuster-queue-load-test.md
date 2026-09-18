# Load-test the adjuster assignment queue

**Assigned:** Jonas Berg

**Estimate:** 3h

Once the straight-through test goes live, assignment stops being the default
path and becomes the exception path — the claims that failed a condition.
The queue gets smaller, and every claim in it is one that needs judgement.

What we do not know is how assign-adjuster.feature.md behaves when a
catastrophe event puts a day's claims through it in an hour. Hail is the
realistic case: thousands of comprehensive claims in one postcode, most of
them straight-through candidates, a minority kicked out to the queue at once.

## What this task is

- Replay a historical hail day against staging at 1x, 5x and 20x arrival rate.
- Measure queue depth, assignment latency, and whether round-robin still
  balances when most claims never reach it.
- Find the point where assignment latency crosses a working day, and say what
  breaks first — the queue, the workload rules, or the database.

## Done when

The three numbers are in the notebook with the arrival rate each was measured
at, and we know which component to fix before catastrophe season.

# Stop quoting a single cycle-time number

**Author:** Priya Raman

**Date:** 2026-09-02

**Kind:** Decision

## Context

We report claims cycle time as one median, and it has been drifting down for
two quarters. It is also concealing the thing we care about.

Splitting June and July by the straight-through conditions gives two
populations that barely overlap: candidate claims at a 1.9-day median, and
everything else at 6.8. The combined median moves when the mix moves, which
means a quiet month of glass claims looks like an improvement.

## Decision

Report the two populations separately, always, including to the board. The
combined number goes away rather than appearing alongside — a number nobody
should act on should not be on the slide.

## Consequences

- The straight-through population's median is now the metric the programme is
  judged on, and it is the one we can actually move.
- Quarter-on-quarter comparisons before this split are not comparable, and we
  should say so rather than restating history.
- Someone will ask for the single number anyway. The answer is the mix, which
  is a different and more useful conversation.

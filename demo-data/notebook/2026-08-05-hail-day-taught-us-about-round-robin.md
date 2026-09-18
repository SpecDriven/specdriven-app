# What the hail day taught us about round-robin

**Author:** Jonas Berg

**Date:** 2026-08-05

**Kind:** Observation

The 22 July hail event put 4,100 comprehensive claims through in about six
hours, most of them from three postcodes. Assignment held up; the assumption
underneath it did not.

Round-robin balances when claims are independent. These were not. Adjacent
claims in a hail cell are near-identical — same damage, same repairer
network, often the same street — and round-robin scattered them across
fourteen adjusters, each of whom then made the same phone calls
independently.

The adjuster who happened to get eleven claims from one street finished them
in under half the time per claim, because after the second one it was the
same claim.

No action yet, and I want to resist the obvious one. "Group by locality"
sounds right and quietly rebuilds territory-based assignment, which we moved
away from for reasons that still hold. But the load test
(tasks/adjuster-queue-load-test.md) should measure per-claim time by cluster
size, not just queue depth — otherwise we will tune the wrong thing.

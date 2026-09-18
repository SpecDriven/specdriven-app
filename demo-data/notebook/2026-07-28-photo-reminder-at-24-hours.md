# Send the photo reminder at 24 hours

**Author:** Aisha Bello

**Date:** 2026-07-28

**Kind:** Decision

## Context

The cycle-time breakdown from 2026-07-14 put 2.6 days between a claim being
opened and usable photos arriving — the largest single stage, and the one
nobody owned. The prompt currently lives in the confirmation email, alongside
the claim number.

## Decision

Send a separate reminder 24 hours after the claim is opened, if no photos
have arrived. One reminder, email only.

## Consequences

- One more message in the claims correspondence set, and one more thing to
  suppress when a claim closes early.
- We learn whether the gap is attention or effort. If a single nudge moves
  the median, the photos were easy and the prompt was buried. If it does not,
  the problem is the uploading.

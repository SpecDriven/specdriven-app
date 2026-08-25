# Straight-Through Claims

**Assigned:** Priya Raman

## Why

Most of what an adjuster touches does not need an adjuster. Glass, small
comprehensive losses, and low-severity collision claims follow the same path
every time, and the customer waits days for a decision the file could have
made on its own. Cycle time, not settlement amount, is what shows up in our
survey scores.

## Target State

- Photo-based estimating at first notice of loss: the insured uploads damage
  photos, the estimate is generated, and the offer is presented in the same
  session (claims/auto-accidents/record-car-accident.feature.md).
- Auto-assignment only when a claim fails the straight-through test, so
  adjuster queues hold the work that actually needs judgement
  (claims/auto-accidents/assign-adjuster.feature.md).
- Payment on acceptance, to the insured's existing payment method rather than
  a mailed draft.

## The Straight-Through Test

A claim settles without an adjuster only when all of these hold:

| Condition               | Threshold                          |
| ----------------------- | ---------------------------------- |
| Estimated severity      | under $3,500                       |
| Coverage                | in force, no lapse in the term      |
| Injury reported         | none                                |
| Other parties           | none, or already accepted liability |
| Fraud score             | below the referral cutoff           |

Anything outside the table routes to a human. The list is deliberately
conservative for the first year; we widen it on measured outcomes, not on
optimism.

## Guardrails

- Every automated decision is reviewable, and the reasons are recorded in the
  file. "The model said so" is not a claim note.
- A customer can ask for a person at any point without penalty, and asking
  must not restart the clock.
- We sample automated settlements monthly against what an adjuster would have
  paid, and publish the gap internally.

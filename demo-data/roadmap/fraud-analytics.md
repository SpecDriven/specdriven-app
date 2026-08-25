# Fraud Detection and Special Investigations

**Assigned:** Priya Raman

## Why

Our referrals to special investigations come from adjuster intuition, which
means they come late and they come unevenly. Industry estimates put fraud near
a tenth of property and casualty losses; we do not know our own number, which
is itself the problem.

## Direction

- Score at first notice of loss, not at settlement. A claim flagged on day one
  is investigated; a claim flagged on day thirty is already paid
  (claims/auto-accidents/record-car-accident.feature.md).
- Network analysis across claims, not just within one — shared repair shops,
  shared medical providers, shared phone numbers, repeat participants across
  otherwise unrelated files.
- Application fraud at the front door: rate evasion through false garaging
  addresses, unlisted drivers, and policies bought after the loss.
- A feedback loop — confirmed outcomes from investigations retrain the model.
  Without it the score decays quietly.

## Guardrails

- A score is a referral, never a denial. Every declination stays a human
  decision with a documented reason.
- We test the model for disparate impact before it goes live and on a schedule
  after, and we keep the results.
- Investigators can see why a claim scored the way it did. An opaque score
  gets ignored, and an ignored score is worse than none.

## Interaction With Automation

Straight-through settlement (roadmap/straight-through-claims.md) and fraud
scoring pull against each other: the faster we pay, the less time we have to
look. The fraud score is the gate on the fast path, so the two have to ship
together or the automation waits.

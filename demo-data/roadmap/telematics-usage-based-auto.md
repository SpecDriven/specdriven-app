# Usage-Based Auto Insurance

**Assigned:** Miguel Santos

## Why

Auto is our largest book and our thinnest margin. Rating on garaging address,
vehicle symbol, and prior claims tells us what a driver looks like on paper;
it does not tell us how they drive. Carriers pricing on observed behaviour are
taking our best risks and leaving us the rest.

## What We Want

- A mobile app and an optional dongle that report mileage, hard braking,
  rapid acceleration, night driving, and phone handling.
- A driving score that feeds the quote as a rating factor
  (policy/auto-policy/quote-policy.feature.md) and re-scores at renewal
  (policy/auto-policy/renew-policy.feature.md).
- An enrolment discount up front, then a performance discount from the second
  term onward, so the customer sees value before we see data.
- Continuous mileage true-up rather than an annual estimate.

## Open Questions

- Do we build the telematics stack or buy a data provider? Buying is faster
  and gives us cross-carrier norms; building keeps the driving history as our
  asset when the customer shops.
- Consent and retention: what exactly do we keep, for how long, and what is
  visible to the claims side? A trip trace that helps subrogation
  (claims/auto-accidents/record-car-accident.feature.md) is also the trace a
  regulator will ask about.
- Which states will accept a behavioural factor in the rate filing, and in
  what order do we file?

## Rough Sequence

1. Pilot in two filed states with a flat enrolment discount, no re-rating.
2. Validate the score against our own loss experience for a full term.
3. File the behavioural factor where the pilot supports it.

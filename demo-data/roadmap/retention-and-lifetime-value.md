# Retention and Household Lifetime Value

**Assigned:** Aisha Bello

## Why

We spend heavily to acquire a customer and then treat every renewal as a
coin flip. A point of retention is worth more than a point of new business and
costs a fraction as much, but nobody owns it — marketing owns acquisition,
underwriting owns the book, and the renewal falls between them.

## Direction

- Score renewal risk before the offer goes out, not after the customer leaves
  (policy/auto-policy/renew-policy.feature.md). Rate increase, life event,
  claim experience, and tenure are most of the signal.
- Intervene where it pays: an outreach call on a large increase, a coverage
  review, a payment plan change instead of a lapse
  (billing/collect-premium.feature.md).
- Measure the household, not the policy. A monoline auto customer leaves at
  roughly twice the rate of one who also has home with us.
- Cross-sell at the moments that matter — a new address, a new vehicle, a boat
  or motorcycle added to the garage — rather than on a mailing schedule.

## Uncomfortable Truths

- Some customers should leave. Retention chased indiscriminately keeps the
  risks we priced badly and loses the ones we priced well.
- Loyalty pricing is under regulatory scrutiny in several states. Whatever we
  build has to survive being explained in public.
- Non-payment cancellation is a retention failure, not a billing outcome. It
  should be measured with retention, not with collections.

## First Steps

1. Define the household record — a prerequisite, not an afterthought
   (roadmap/core-platform-modernization.md).
2. Baseline retention by line, tenure, and rate-change band. We do not have
   this today.
3. One controlled outreach pilot on large increases, measured against a
   holdout.

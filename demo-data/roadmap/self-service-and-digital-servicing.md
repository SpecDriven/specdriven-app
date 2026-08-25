# Self-Service and Digital Servicing

**Assigned:** Aisha Bello

## Why

Roughly two thirds of our call volume is address changes, vehicle swaps, proof
of insurance requests, and "when is my payment due." Every one of those is a
call we pay for and a customer who wanted an answer, not a conversation.

## Scope

- Endorsements the customer can make themselves — add or remove a vehicle or
  driver, change coverage limits, change the mailing address — with the
  premium change shown before it is committed
  (policy/auto-policy/endorse-policy.feature.md).
- Billing self-service: change the due date, switch plans, add or update
  autopay, pay a past-due balance
  (billing/collect-premium.feature.md).
- Instant proof of insurance in the wallet, and a shareable link for lienholders.
- Cancellation and refund handled online, with the unearned premium shown
  before confirmation (policy/auto-policy/cancel-policy.feature.md,
  billing/refund-unearned-premium.feature.md).
- Claim status without calling the adjuster.

## Principle

Anything an agent can do on the phone, the customer can do in the app, unless
there is a legal reason they cannot. Where the answer is "no," the app should
say why and hand off with context — not dump the customer into a queue to
re-explain themselves.

## Measures

- Share of service transactions completed without a call.
- Calls per policy per term.
- Abandonment on the self-service paths, which tells us where the app is worse
  than the phone.

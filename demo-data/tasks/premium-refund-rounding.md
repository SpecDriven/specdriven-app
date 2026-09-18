# Settle the rounding rule for unearned premium

**Assigned:** Miguel Santos

**Estimate:** 2h

Mid-term cancellations refund unearned premium
(billing/refund-unearned-premium.feature.md), and the pro-rata calculation
lands on a fraction of a cent more often than anyone expected — roughly one
cancellation in six.

Right now the service rounds half-up and the ledger rounds half-even, so the
two disagree by a cent on those, and reconciliation writes off the difference
every month. It is a trivial amount of money and a non-trivial amount of
monthly manual work.

## What this task is

Pick one rule and apply it in both places.

- Confirm which rule the filed rate actually commits us to — this may not be
  a free choice.
- Change whichever side disagrees with it.
- Backfill the reconciliation write-offs so the monthly job stops flagging
  them.

## Done when

A month closes with no rounding write-offs, and the rule is written into the
refund scenario so the next service does not rediscover this.

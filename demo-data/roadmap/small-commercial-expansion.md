# Small Commercial Expansion

**Assigned:** Miguel Santos

## The Opportunity

We are a personal lines carrier writing personal lines to people who own
businesses. The contractor whose truck we insure has a general liability
policy somewhere else, and a business owner's policy after that. Small
commercial is adjacent to what we already do, and our agents already ask for it.

## Proposed Entry

- Start with a business owner's policy for low-hazard classes — offices,
  retail, light service — and commercial auto for the small fleets we
  effectively already underwrite one vehicle at a time.
- Class-based underwriting with a short application. Small commercial dies on
  a long application; if it takes more than ten minutes the agent goes
  elsewhere.
- Reuse the personal lines quote and bind path where the shape is the same
  (policy/auto-policy/quote-policy.feature.md), rather than standing up a
  second everything.

## What Is Genuinely New

- Classification and exposure basis — payroll, receipts, square footage —
  which personal lines has no equivalent of.
- Audit at end of term, and the billing behaviour that comes with it
  (billing/collect-premium.feature.md).
- Certificates of insurance, issued constantly and expected instantly.
- Liability claims handling, with reserves and a defence cost tail our claims
  organisation has not carried before.

## Decision Needed First

Do we write this on our own paper or start as a program with a partner
carrier? Partnering gets us to market in a year and teaches us the business;
own paper is the only way the economics eventually work. The honest answer is
probably partner first, with a contractual path to take it back.

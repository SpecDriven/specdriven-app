# Rate and Product Agility

**Assigned:** Dana Whitfield

## The Constraint

A rate change today takes about nine months from indication to effective date:
analysis, filing, approval, then an implementation release. In a year where
severity moved as fast as it did, nine months of lag is a year of writing
business at last year's price.

## Goals

- Cut indication-to-effective to a single quarter for a straightforward
  revision.
- Rate tables as versioned data with an effective date, so a filed change is
  loaded rather than coded (roadmap/core-platform-modernization.md).
- Filing artefacts generated from the same tables that rate the policy, so the
  filing and the system cannot drift apart.
- Parallel-run any change against the last full term of quotes before it goes
  live, and know the premium impact by segment before the regulator does.

## Also Worth Doing

- A standing calendar: every state and line reviewed on a schedule rather than
  when someone notices a loss ratio.
- Track approval times and objection reasons by state. Where we are slow, know
  whether it is us or the department.
- Interim levers that do not require a filing — underwriting appetite,
  schedule credits, non-renewal for frequency
  (policy/auto-policy/renew-policy.feature.md) — used deliberately rather than
  as an accident of local judgement.

# Core Platform Modernization

**Assigned:** Jonas Berg

## The Situation

Policy administration, billing, and claims each hold their own copy of the
customer, and the copies disagree. Rate changes take a quarter because the
rating logic is spread between the policy system, a spreadsheet, and a batch
job nobody wants to touch. Nothing else on this roadmap moves quickly until
this does.

## Direction

- One customer record, with policy, billing, and claims referring to it rather
  than duplicating it.
- Rating extracted into a service with versioned rate tables, so a rate change
  is a data change and not a release.
- Events rather than nightly batch: bind, endorse, cancel, payment, and claim
  status published as they happen. The nightly jobs that drive renewals and
  cancellation notices become consumers, not the source of truth.
- APIs first, with our own portal and partner integrations as the first two
  consumers — if the API is good enough for us it is good enough for them.

## Sequencing

Strangler pattern, line of business by line of business. Auto last, because it
is the biggest book and the riskiest cutover; boat first, because it is small
enough that a bad week is survivable.

1. Rating service, fed by the existing policy system.
2. Billing events and the customer record.
3. Boat, then motorcycle, then home, then auto.

## What Would Make This Fail

Trying to do it while also delivering everything else on this roadmap at full
speed. The modernization needs a named team that is not also the escalation
path for production.

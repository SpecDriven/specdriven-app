# Worked conversions

One end-to-end conversion per source format. Each shows the source, the
canonical `.feature.md` output, and the conversion notes the workflow's
report step expects — modelling how to surface judgment calls and lossy
mappings instead of hiding them.

Assume `project-settings.json` lists the members `Dana Whitfield` and
`Priya Raman`.

## 1. Gherkin / Cucumber

### Source: `billing/collect_premium.feature`

```gherkin
@billing @smoke
Feature: Collect premium
  Automatic collection of installment payments for issued policies.

  Background:
    Given an issued policy with monthly installments

  @JIRA-224
  Scenario: Failed autopay starts the grace period
    When the autopay charge is declined
    Then the charge is retried in 3 days
    And the policy enters a 20-day grace period

  Scenario Outline: Late fee by plan
    When an installment is <days> days late
    Then a late fee of <fee> is charged

    Examples: Standard plans
      | days | fee |
      | 10   | $10 |
      | 30   | $25 |

  @wip
  Scenario: Payment portal outage
    # TODO: confirm retry window with finance
    When the payment portal is unreachable
    Then the charge is retried the next day
    And the customer is notified with:
      """text
      Your payment could not be processed.
      We will retry automatically.
      """

  Rule: Grace period never overlaps cancellation
    Scenario: Cancellation blocked during grace
      Given a policy in its grace period
      When a cancellation is requested
      Then the cancellation is queued until the grace period ends
```

### After: `billing/collect-premium.feature.md`

````markdown
# Collect premium

Automatic collection of installment payments for issued policies.

### Rule: Grace period never overlaps cancellation

Cancellations requested during a grace period wait until it ends.

Tags: `@billing` `@smoke`

## Cancellation blocked during grace @v1 [proposed]

**Rule:** Grace period never overlaps cancellation

- **Given** an issued policy with monthly installments
- **And** a policy in its grace period
- **When** a cancellation is requested
- **Then** the cancellation is queued until the grace period ends

## Failed autopay starts the grace period @v1 [proposed]

[Jira:JIRA-224](https://acme.atlassian.net/browse/JIRA-224)

- **Given** an issued policy with monthly installments
- **When** the autopay charge is declined
- **Then** the charge is retried in 3 days
- **And** the policy enters a 20-day grace period

## Late fee by plan @v1 [proposed]

- **Given** an issued policy with monthly installments
- **When** an installment is `<days>` days late
- **Then** a late fee of `<fee>` is charged

**Examples: Standard plans**

| days | fee |
| ---- | --- |
| 10   | $10 |
| 30   | $25 |

## Payment portal outage @v1 [proposed]

> TODO: confirm retry window with finance

- **Given** an issued policy with monthly installments
- **When** the payment portal is unreachable
- **Then** the charge is retried the next day
- **And** the customer is notified with:

```text
Your payment could not be processed.
We will retry automatically.
```

Tags: `@wip`
````

### Conversion notes

- Wrote `billing/collect-premium.feature.md` (4 scenarios, all
  `@v1 [proposed]`), mirroring the source's `billing/` directory.
- The `Background` step is repeated as the leading **Given** of every
  scenario so each stays self-contained.
- The `Rule:` grouping flattened into a `### Rule:` description section plus
  a `**Rule:**` line on its one scenario — the format has no Rule construct.
- The `@JIRA-224` tag became the scenario's ticket link; the Jira site URL
  was taken from existing links in the data repo. The remaining tags have no
  construct and became `` Tags: `…` `` prose lines.
- `@wip` did **not** map to a draft — drafts vanish from files; the scenario
  is `[proposed]` like the rest. Flagging it here instead.
- The `# TODO` comment was kept as a blockquote; the doc string became a
  fenced `text` block; the scenario outline stayed one scenario with its
  examples as a table (not one scenario per row).
- Scenarios are in canonical sorted order, which differs from source order.

## 2. Markdown PRD

### Source: `payments-prd.md`

```text
# Payments PRD — Q3

Owner: Dana Whitfield
Priority: P1

## Goals

Reduce involuntary churn from failed payments. Ship before the October
renewal wave.

## Card auto-retry

As a billing manager, I want failed card charges retried automatically so
that customers do not lapse for transient declines.

Acceptance criteria:
- [ ] A declined charge is retried after 3 days
- [ ] A second decline is retried after 7 more days
- [ ] After the final decline the account manager is notified

## Payment status API

The portal needs a payment status endpoint.

- Response p95 must be under 200 ms
- The API should feel fast and modern

Open questions:
- Do we retry on hard declines (stolen card)?
```

### After: `payments/card-auto-retry.feature.md`

```markdown
# Card auto-retry

**Assigned:** Dana Whitfield

As a billing manager, I want failed card charges retried automatically so
that customers do not lapse for transient declines.

Priority: P1 (from Payments PRD — Q3)

## Account manager notified after final decline @v1 [proposed]

- **Given** a declined charge has exhausted its retries
- **When** the final retry is declined
- **Then** the account manager is notified

## Declined charge is retried on a schedule @v1 [proposed]

- **Given** a card charge was declined
- **When** 3 days pass
- **Then** the charge is retried
- **And** a second decline is retried after 7 more days
```

### After: `payments/payment-status-api.feature.md`

```markdown
# Payment status API

**Assigned:** Dana Whitfield

The portal needs a payment status endpoint. "The API should feel fast and
modern" is kept here as prose — it is not testable as written.

### Open questions

- Do we retry on hard declines (stolen card)?

## Status response p95 under 200 ms @v1 [proposed]

- **Given** the status endpoint is under normal load
- **When** the portal requests a payment's status
- **Then** the response p95 latency is under 200 ms
```

### Conversion notes

- The PRD covers two capabilities, so it became a `payments/` folder with
  one feature file per capability — not one file for the whole document.
- `Owner: Dana Whitfield` matched a `project-settings.json` member exactly
  and became `**Assigned:**` on both features. `Priority: P1` has no
  construct; kept as one prose line and reported here.
- The three acceptance criteria became two scenarios: the retry schedule is
  one behavior (criteria 1–2), notification is a distinct *When* (criterion
  3).
- The measurable NFR (p95 < 200 ms) became a scenario in its own feature
  rather than a separate `performance.feature.md`, since it is specific to
  this API. The vague NFR stayed prose, flagged as untestable.
- The `Goals` section is PRD-wide strategy: offered as a
  `roadmap/payments-prd.md` page, **not written** — roadmap pages are an
  extra file needing the user's OK. The October deadline lives only there
  and in this report; the format has no dates.
- Open questions stayed in the description — scenarios are for agreed
  behavior.

## 3. Jira / tracker export

### Source: epic export

```json
{
  "epic": {
    "key": "BIL-100",
    "summary": "Billing hardening",
    "url": "https://acme.atlassian.net/browse/BIL-100",
    "description": "Make billing robust against failed and returned payments."
  },
  "issues": [
    {
      "key": "BIL-101",
      "type": "Story",
      "summary": "BIL-101: Dunning emails",
      "status": "In Progress",
      "priority": "High",
      "labels": ["billing", "email"],
      "assignee": "Priya Raman",
      "storyPoints": 5,
      "url": "https://acme.atlassian.net/browse/BIL-101",
      "description": "Send reminder emails while an account is past due.",
      "acceptanceCriteria": [
        "A reminder is sent on day 1 past due",
        "A second reminder is sent on day 10",
        "No emails are sent once the account is settled"
      ]
    },
    {
      "key": "BIL-102",
      "type": "Story",
      "summary": "BIL-102: Retry ACH returns",
      "status": "Done",
      "priority": "Low",
      "labels": ["billing"],
      "assignee": "Sam Ito",
      "url": "https://acme.atlassian.net/browse/BIL-102",
      "description": "ACH returns should be retried once.",
      "acceptanceCriteria": [
        "A returned ACH debit is retried once after 5 business days"
      ]
    }
  ]
}
```

### After: `billing-hardening/billing-hardening.feature.md`

```markdown
# Billing hardening

[Jira:BIL-100](https://acme.atlassian.net/browse/BIL-100)

Make billing robust against failed and returned payments.

Tags: `billing`

## Returned ACH debit is retried once @v1 [proposed]

[Jira:BIL-102](https://acme.atlassian.net/browse/BIL-102)

From BIL-102 (status at conversion: Done; assignee Sam Ito is not a project
member, so recorded here — scenarios cannot carry assignees).

- **Given** an ACH debit was returned
- **When** 5 business days pass
- **Then** the debit is retried once
```

### After: `billing-hardening/dunning-emails.feature.md`

```markdown
# Dunning emails

[Jira:BIL-101](https://acme.atlassian.net/browse/BIL-101)

**Assigned:** Priya Raman

Send reminder emails while an account is past due.

Tags: `billing` `email`

## No emails once the account is settled @v1 [proposed]

- **Given** a past-due account with reminder emails scheduled
- **When** the account is settled
- **Then** no further reminder emails are sent

## Reminder sent on day 1 past due @v1 [proposed]

- **Given** an account becomes past due
- **When** day 1 past due begins
- **Then** a reminder email is sent

## Second reminder sent on day 10 @v1 [proposed]

- **Given** an account is still past due on day 10
- **When** day 10 past due begins
- **Then** a second reminder email is sent
```

### Conversion notes

- The epic became the `billing-hardening/` folder; its summary, link, and
  description became the epic's own feature file.
- BIL-101 has three independent acceptance criteria → its own feature file,
  with the issue key stripped from the name into the ticket link line, one
  scenario per criterion, and `**Assigned:** Priya Raman` (exact member
  match).
- BIL-102 describes one behavior → a single scenario grouped into the epic's
  file, carrying its own scenario-level ticket link. Sam Ito matched no
  project member and scenarios cannot carry assignees, so the assignee is
  prose plus this report.
- Statuses (In Progress, Done) all became `[proposed]` — "Done" in Jira is
  not `[published]` here; publishing is the human's act in the app. Original
  statuses recorded above.
- Dropped with no construct: priority (High/Low), story points (5). Labels
  became `` Tags: `…` `` lines; `billing` also matched the folder placement.

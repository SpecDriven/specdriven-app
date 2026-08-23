# Quote Auto Policy

Rating and quoting for personal auto. A prospect answers a short
questionnaire and receives a premium they can later bind
(bind-policy.feature.md).

## Basic auto quote @v1 [published]

- **Given** a prospect provides a vehicle, its primary driver, and a garaging ZIP code
- **When** the prospect requests a quote
- **Then** a six-month premium is quoted for each available plan

| plan           | bodily injury limit | collision deductible | premium |
| -------------- | ------------------- | -------------------- | ------- |
| Liability Only | 50/100              | —                    | $312    |
| Standard       | 100/300             | $1,000               | $517    |
| Full           | 250/500             | $500                 | $689    |

## Basic auto quote @v2 [proposed]

Adds the good-driver discount to v1.

- **Given** a prospect provides a vehicle, its primary driver, and a garaging ZIP code
- **And** the driver has no at-fault accidents or moving violations in the past 5 years
- **When** the prospect requests a quote
- **Then** a six-month premium is quoted for each available plan
- **And** a 15% good-driver discount is applied and shown as a line item

## Decline high-risk driver @v1 [published]

- **Given** a prospect's driving record shows 3 or more at-fault accidents in the past 3 years
- **When** the prospect requests a quote
- **Then** no quote is offered
- **And** the decline reason "does not meet underwriting guidelines" is recorded

## Quote expires after 30 days @v1 [proposed]

- **Given** a quote was issued 31 days ago
- **When** the prospect tries to bind it
- **Then** binding is refused and the prospect is offered a re-quote at current rates

## S7 @v1 [proposed]

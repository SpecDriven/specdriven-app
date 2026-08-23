# Assign Adjuster

Route each newly opened claim to the right adjuster.

## Assign by estimated damage @v1 [published]

- **Given** a newly opened collision claim
- **When** the initial damage estimate is recorded
- **Then** the claim is routed by severity

| estimated damage | route                                     |
| ---------------- | ----------------------------------------- |
| under $5,000     | fast-track desk adjuster                  |
| $5,000 – $25,000 | field adjuster                            |
| over $25,000     | senior field adjuster + supervisor review |

## Exception Escalation @v1 [proposed]

Under these circumstances, the case must be escalated.

* When this is a VIP customer with a new car.
* When there is a code assigned to the policy.

## Injury claims go to a casualty adjuster @v1 [proposed]

- **Given** a newly opened claim
- **When** the first notice of loss mentions any injury
- **Then** the claim is assigned to a casualty adjuster regardless of the damage estimate

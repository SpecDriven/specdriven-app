# Bind Auto Policy

Turning an accepted quote into an in-force policy.

## Bind from an active quote @v1 [published]

- **Given** a prospect has an active quote
- **And** the down payment for the first installment has cleared
- **When** the prospect accepts the quote
- **Then** a policy is issued with a unique policy number
- **And** the effective date is the requested start date
- **And** ID cards and the declarations page are emailed to the named insured

### Tests

| Test |
| --- |
| https://github.com/SpecDriven/insurance-cap-java/blob/main/srv/src/test/java/com/acme/insurance/policy/BindAutoPolicyTest.java#L41 |

## Effective date may not be backdated @v1 [published]

- **Given** a prospect has an active quote
- **When** they request an effective date earlier than today
- **Then** binding is refused with the reason "coverage cannot start in the past"

### Tests

| Test |
| --- |
| https://github.com/SpecDriven/insurance-cap-java/blob/main/srv/src/test/java/com/acme/insurance/policy/BindAutoPolicyTest.java#L103 |

## Uninsured motorist rejection form @v1 [published]

- **Given** a prospect declines uninsured motorist coverage
- **When** the policy is bound
- **Then** a signed UM/UIM rejection form is required before issuance

# Cancel Auto Policy

## Cancellation for non-payment @v1 [published]

- **Given** an installment is past due and the grace period has ended (billing/collect-premium.feature.md)
- **When** the 14-day cancellation notice period elapses without payment
- **Then** the policy is cancelled effective the date stated on the notice
- **And** any unearned premium is refunded

### Tests

| Test |
| --- |
| https://github.com/SpecDriven/insurance-cap-java/blob/main/srv/src/test/java/com/acme/insurance/policy/CancelAutoPolicyTest.java#L69 |

## Insured requests cancellation @v1 [published]

- **Given** an in-force policy
- **When** the named insured requests cancellation as of a chosen date
- **Then** the policy is cancelled on that date
- **And** unearned premium is refunded pro rata (billing/refund-unearned-premium.feature.md)

### Tests

| Test |
| --- |
| https://github.com/SpecDriven/insurance-cap-java/blob/main/srv/src/test/java/com/acme/insurance/policy/CancelAutoPolicyTest.java#L38 |

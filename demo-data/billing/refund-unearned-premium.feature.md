# Refund Unearned Premium

## Pro-rata refund on cancellation @v1 [published]

- **Given** a $600 six-month policy cancelled exactly 2 months into the term
- **When** the cancellation is processed
- **Then** $400 of unearned premium is refunded to the original payment method

### Tests

| Test |
| --- |
| https://github.com/SpecDriven/insurance-cap-java/blob/main/srv/src/test/java/com/acme/insurance/billing/RefundUnearnedPremiumTest.java#L32 |

## Refund clears within 10 business days @v1 [proposed]

- **Given** a processed refund
- **When** 10 business days pass without the refund settling
- **Then** the account is flagged for a billing specialist to review

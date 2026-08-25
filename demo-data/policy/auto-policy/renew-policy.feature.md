# Renew Auto Policy

## Automatic renewal offer @v1 [published]

- **Given** an in-force policy expiring in 45 days
- **And** the account has no unpaid balance
- **When** the nightly renewal job runs
- **Then** a renewal offer is generated at current rates
- **And** the offer is sent to the named insured

### Tests

| Test |
| --- |
| https://github.com/SpecDriven/insurance-cap-java/blob/main/srv/src/test/java/com/acme/insurance/policy/RenewAutoPolicyTest.java#L39 |

## Non-renewal for claim frequency @v1 [published]

- **Given** a policy with 2 or more at-fault claims during the current term
- **When** the renewal review runs 60 days before expiration
- **Then** the policy is marked for non-renewal
- **And** a non-renewal notice with the reason is mailed at least 45 days before expiration

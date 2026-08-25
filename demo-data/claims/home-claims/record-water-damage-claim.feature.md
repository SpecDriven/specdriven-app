# Record Water Damage Claim

Water losses are the most common homeowners claim and the most
coverage-sensitive: sudden-and-accidental is covered, gradual is not.

## Burst pipe is covered @v1 [published]

- **Given** a homeowner with an in-force HO-3 policy
- **When** they report that a pipe burst yesterday and flooded the kitchen
- **Then** a claim is opened as "sudden and accidental water damage"
- **And** an emergency mitigation vendor is offered within 24 hours

### Tests

| Test |
| --- |
| https://github.com/SpecDriven/insurance-cap-java/blob/main/srv/src/test/java/com/acme/insurance/claims/RecordWaterDamageClaimTest.java#L32 |

## Gradual leak is denied @v1 [proposed]

- **Given** an inspection finds the damage came from a slow leak over several months
- **When** the adjuster completes the coverage review
- **Then** the claim is denied under the maintenance exclusion
- **And** the denial letter cites the policy language and the inspection findings

## Surface flood is referred to the flood policy @v1 [proposed]

- **Given** the water entered the home from rising surface water
- **When** the adjuster completes the coverage review
- **Then** the claim is denied under the homeowners flood exclusion
- **And** the insured is referred to their separate flood policy, if any

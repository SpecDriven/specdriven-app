# Endorse Auto Policy

Mid-term changes to an in-force policy. Every endorsement re-rates the
policy and prorates the premium difference from the endorsement date.

## Add a vehicle mid-term @v1 [published]

- **Given** an in-force auto policy with 4 months remaining in the term
- **When** the insured adds a second vehicle
- **Then** the additional premium is prorated over the remaining 4 months
- **And** a revised declarations page is issued

### Tests

| Test |
| --- |
| https://github.com/SpecDriven/insurance-cap-java/blob/main/srv/src/test/java/com/acme/insurance/policy/EndorseAutoPolicyTest.java#L32 |

## Change garaging address @v1 [published]

- **Given** an in-force auto policy
- **When** the insured moves the garaging address to a different ZIP code
- **Then** the policy is re-rated with the new territory factor
- **And** the premium difference is prorated from the endorsement date

## Remove a vehicle @v1 [proposed]

- **Given** an in-force auto policy covering 2 vehicles
- **When** the insured removes one vehicle
- **Then** the unearned premium for that vehicle is credited to the account

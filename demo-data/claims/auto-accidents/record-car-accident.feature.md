# Record Car Accident

First notice of loss (FNOL) for collision and comprehensive claims.

## Accident on a lapsed policy @v1 [published]

- **Given** a policy that was cancelled for non-payment on June 1
- **When** the former insured reports an accident dated June 10
- **Then** the claim is registered and immediately set to "Denied — no coverage in force"
- **And** a denial letter states the policy was not in force on the date of loss

## Report accident online @v1 [published]

- **Given** a named insured with an in-force auto policy
- **When** they report an accident with the date, location, a description, and photos
- **Then** a claim is opened with a unique claim number
- **And** the claim status is "Open — awaiting adjuster" (assign-adjuster.feature.md)
- **And** a confirmation email with the claim number is sent

## Report accident through the claims hotline @v1 [published]

- **Given** a caller reaches the 24/7 claims hotline
- **When** a live agent records the accident details on the insured's behalf
- **Then** a claim is opened exactly as if it had been reported online
- **And** the agent reads the claim number back to the caller

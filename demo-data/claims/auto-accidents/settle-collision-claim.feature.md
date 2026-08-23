# Settle Collision Claim

## Approve repair estimate @v1 [published]

- **Given** an open collision claim with a $500 deductible
- **And** an approved repair-shop estimate of $4,200
- **When** the adjuster authorizes the repair
- **Then** $3,700 is paid directly to the repair shop
- **And** the insured is notified that the $500 deductible is due to the shop

## Declare a total loss @v1 [proposed]

- **Given** a repair estimate of $9,000 on a vehicle with an actual cash value of $11,000
- **When** the estimate reaches 75% of the actual cash value
- **Then** the vehicle is declared a total loss
- **And** the insured is offered the actual cash value minus the deductible
- **And** the title transfers to the company on acceptance

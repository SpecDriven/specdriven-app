# Quote Homeowners Policy

HO-3 quotes for owner-occupied homes — the property side of the book.

## Basic homeowners quote @v1 [published]

- **Given** a prospect provides the home's address, year built, construction type, and desired dwelling coverage
- **When** the prospect requests a quote
- **Then** an annual premium is quoted

| dwelling coverage | deductible | annual premium |
| ----------------- | ---------- | -------------- |
| $300,000          | $1,000     | $1,420         |
| $300,000          | $2,500     | $1,180         |
| $500,000          | $1,000     | $2,050         |

## Flood damage is excluded @v1 [published]

- **Given** the home sits in a FEMA special flood hazard area
- **When** the quote is presented
- **Then** it prominently notes that flood damage is excluded
- **And** the prospect is referred to a separate flood policy

## Old roof requires inspection @v1 [published]

- **Given** the roof is more than 20 years old
- **When** the prospect requests a quote
- **Then** the quote is issued conditionally
- **And** binding requires a passing roof inspection report
bla bla

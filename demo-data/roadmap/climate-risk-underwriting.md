# Climate Risk in Property Underwriting

**Assigned:** Jonas Berg

## The Problem

Our homeowners book is priced off historical loss experience and a wind/hail
territory map that predates the last decade of weather. Wildfire, convective
storm, and inland flood losses are arriving in places our maps call quiet. We
are accumulating correlated risk without seeing it accumulate.

## Direction

- Peril-specific scores at the location level — wildfire, wind, hail, flood,
  wet-freeze — rather than a single territory factor
  (policy/home-policy/quote-homeowners-policy.feature.md).
- An aggregation view: total insured value by peril by geography, checked
  before we bind rather than after the season.
- Mitigation credits that pay for themselves — roof age and class, defensible
  space, water shutoff devices — so we reward the risk we want to keep.
- Deductible structures that match the peril, including percentage
  deductibles for wind and hail.

## Consequences We Should Say Out Loud

Doing this properly means writing less business in some places and raising
rates in others. That is the point, but it will read as retreat to anyone
looking at a growth chart. We need the appetite decision made once, at the
top, and then applied consistently — not relitigated deal by deal.

## Dependencies

- A third-party hazard data feed with location-level resolution.
- Rate filings per state and per peril; see roadmap/rate-filing-agility.md.
- Claims data tagged by cause of loss, which today it often is not
  (claims/home-claims/record-water-damage-claim.feature.md).

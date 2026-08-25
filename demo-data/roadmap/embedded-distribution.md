# Embedded and Partner Distribution

**Assigned:** Dana Whitfield

## Why

The cheapest quote is the one the customer never had to ask for. Auto dealers,
mortgage originators, marine and powersports retailers, and property managers
all sit at the exact moment a policy is needed. Today we reach them through
independent agents and pay full commission for the privilege.

## What We Would Build

- A quote-and-bind API a partner can call from their own checkout, returning a
  bindable price rather than a lead (policy/auto-policy/bind-policy.feature.md).
- Prefill from what the partner already knows — VIN, hull identification
  number, address, loan terms — so the customer answers three questions, not
  thirty.
- Partner-branded documents and a co-branded first notice of loss page.
- Commission and referral accounting that settles monthly, per partner.

## Candidate Partners

| Channel                | Line                                          |
| ---------------------- | --------------------------------------------- |
| Auto dealer groups     | Auto (policy/auto-policy/quote-policy.feature.md) |
| Powersports retailers  | Motorcycle (policy/motorcycle-policy/quote-motorcycle-policy.feature.md) |
| Marina networks        | Boat (policy/boat-policy/quote-boat-policy.feature.md) |
| Mortgage servicers     | Homeowners                                    |

## Risks

- Partner-sourced business converts well and retains badly. We should price
  the first term expecting that, and measure retention by partner from day one.
- Licensing and producer compensation rules vary by state; a partner's
  salesperson is not automatically allowed to sell insurance.
- Our brand rides on their service. A bad partner does more damage than a bad
  quarter.

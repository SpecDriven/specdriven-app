# Send the photo reminder at four hours, by SMS

**Author:** Aisha Bello

**Date:** 2026-08-19

**Kind:** Decision

**Supersedes:** [Send the photo reminder at 24 hours](/notebook/2026-07-28-photo-reminder-at-24-hours)

## Context

Three weeks of the 24-hour email reminder moved the median photo gap from
2.6 days to 2.4 — inside the noise. The open rate explains it: 31%, and of
those who opened, most did so the following evening.

The claims that did come back quickly had something in common we missed
first time round. They were reported from the app, on a phone, at the
roadside — the photos were already in the camera roll.

## Decision

Reminder at four hours, by SMS, with a link that opens the upload directly.
Email stays as the fallback where we have no mobile number.

## Consequences

- SMS costs money per message and needs consent we already hold for claims
  correspondence, but not for marketing — Legal confirmed the distinction
  holds here.
- Four hours will reach some people mid-repair or mid-hospital. The copy has
  to be a reminder someone can ignore without penalty, not a demand.
- If this does not move the median either, the problem is the upload flow
  itself and we should stop tuning messages.

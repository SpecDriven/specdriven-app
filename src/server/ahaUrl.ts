// Aha! record urls (specs/external-links/aha-import.feature.md "Import a
// feature by its url"): which Aha! site a url belongs to and which record it
// names. Pure — shared by the import route and the dialog, which hints at a
// missing API key before anything is sent.
//
// Aha! spells a record's url as the site plus the record's kind and
// reference number — the same number its API accepts in place of an id:
//
//   https://acme.aha.io/features/APP-123          (a feature)
//   https://acme.aha.io/epics/APP-E-12            (an epic)
//   https://acme.aha.io/requirements/APP-123-1    (a requirement of APP-123)
//   https://acme.aha.io/ideas/APP-I-7             (an idea)
//
// The site is the origin alone; Aha! has no context path. A test may stand
// a stub on the loopback, so any http(s) host counts as a site.

import { AHA_REF_RE } from "./resourceLinks";

export type AhaRecordKind = "feature" | "epic" | "requirement" | "idea";

/** A record as its url names it: the site, what it is, and its reference number. */
export interface AhaRecordRef {
  /** The Aha! site's base url: the origin, no trailing slash. */
  base: string;
  kind: AhaRecordKind;
  /** The reference number, upper-case: APP-123. */
  ref: string;
}

/** The path segment each kind of record lives under. */
const PATHS: Record<AhaRecordKind, string> = {
  feature: "features",
  epic: "epics",
  requirement: "requirements",
  idea: "ideas",
};

function httpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The kind a reference number gives away: APP-E-12 an epic, APP-I-7 an idea, APP-123-1 a requirement. */
export function ahaRefKind(ref: string): AhaRecordKind {
  if (/-E-\d+$/.test(ref)) return "epic";
  if (/-I-\d+$/.test(ref)) return "idea";
  if (/-\d+-\d+$/.test(ref)) return "requirement";
  return "feature";
}

/** The record an Aha! url names, or null when it names none. */
export function parseAhaRecordUrl(raw: string): AhaRecordRef | null {
  const url = httpUrl(raw);
  if (!url) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  for (let i = 0; i + 1 < segments.length; i++) {
    const kind = (Object.keys(PATHS) as AhaRecordKind[]).find((k) => PATHS[k] === segments[i]!.toLowerCase());
    const ref = segments[i + 1]!.toUpperCase();
    if (kind && AHA_REF_RE.test(ref)) return { base: url.origin, kind, ref };
  }
  return null;
}

/**
 * A bare reference number — `APP-123`, as Aha! shows it beside the record's
 * name — read against the site the user picked. Null when it is no
 * reference number, or `base` is no site.
 */
export function parseAhaRef(raw: string, base: string): AhaRecordRef | null {
  const site = normalizeAhaBase(base);
  const ref = raw.trim().toUpperCase();
  if (!site || !AHA_REF_RE.test(ref)) return null;
  return { base: site, kind: ahaRefKind(ref), ref };
}

/** A record's url as Aha! shows it. */
export function ahaRecordUrl(base: string, kind: AhaRecordKind, ref: string): string {
  return `${base}/${PATHS[kind]}/${ref}`;
}

/**
 * An Aha! site's base url as typed in Settings — `https://acme.aha.io`, or
 * any record url of it — or null when it is no http(s) url. Path, query and
 * fragment are dropped: the site is the origin.
 */
export function normalizeAhaBase(raw: string): string | null {
  const url = httpUrl(raw);
  return url ? url.origin : null;
}

/** Whether two urls are the same Aha! site. */
export function sameAhaBase(a: string, b: string): boolean {
  const x = normalizeAhaBase(a);
  const y = normalizeAhaBase(b);
  return x !== null && y !== null && x.toLowerCase() === y.toLowerCase();
}

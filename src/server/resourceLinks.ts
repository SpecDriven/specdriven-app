// Aha! and Figma links (specs/external-links/aha-and-figma-links.feature.md):
// which tools a feature or scenario can link to, and how a link reads. Pure —
// shared by the server route that saves the links and by the editor's field.

import type { ResourceLink } from "./parser";

/** The tools a link can point into; each is its own list on the document. */
export const RESOURCE_LINK_KINDS = ["aha", "figma"] as const;
export type ResourceLinkKind = (typeof RESOURCE_LINK_KINDS)[number];

export function isResourceLinkKind(value: unknown): value is ResourceLinkKind {
  return typeof value === "string" && (RESOURCE_LINK_KINDS as readonly string[]).includes(value);
}

/** How each tool is named and what its links look like. */
export const RESOURCE_LINK_TOOLS: Record<
  ResourceLinkKind,
  {
    /** The tool's own name, as the chips and fields show it. */
    name: string;
    /** What one link points at, for the hints: "record", "design". */
    noun: string;
    /** The add field's placeholder. */
    placeholder: string;
    /** Whether a host is the tool's own. */
    ownHost: (host: string) => boolean;
  }
> = {
  aha: {
    name: "Aha!",
    noun: "record",
    placeholder: "https://acme.aha.io/features/APP-123",
    ownHost: (host) => host === "aha.io" || host.endsWith(".aha.io"),
  },
  figma: {
    name: "Figma",
    noun: "design",
    placeholder: "https://www.figma.com/design/abc123/Checkout",
    ownHost: (host) => host === "figma.com" || host.endsWith(".figma.com"),
  },
};

/** Whether a url may be linked at all: http or https, nothing else. */
export function isResourceLinkUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url.trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether a url is on the tool's own site (aha.io, figma.com). Others are
 * still accepted — an Aha! ideas portal can sit on a custom domain — the
 * field only warns.
 */
export function isOwnResourceUrl(kind: ResourceLinkKind, url: string): boolean {
  try {
    return RESOURCE_LINK_TOOLS[kind].ownHost(new URL(url.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** An Aha! reference number: APP-123, APP-E-12 (epic), APP-I-7 (idea), APP-123-1 (requirement). */
export const AHA_REF_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z]+)?-\d+(?:-\d+)?$/;

/** The Figma paths a file lives under: `/design/<key>/<name>` and the like. */
const FIGMA_KINDS = new Set(["file", "design", "proto", "board", "slides", "make", "deck", "site"]);

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The name a url gives away on its own: an Aha! record's reference number
 * (APP-123), or a Figma file's name (`Checkout-flow` → "Checkout flow").
 * Null when the url gives none.
 */
export function resourceNameFromUrl(kind: ResourceLinkKind, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean).map(decoded);
  if (kind === "aha") {
    const ref = [...segments].reverse().find((s) => AHA_REF_RE.test(s));
    return ref ?? null;
  }
  const at = segments.findIndex((s) => FIGMA_KINDS.has(s));
  if (at === -1) return null;
  const name = segments[at + 2]?.replace(/-+/g, " ").trim();
  return name || null;
}

/**
 * How a link reads in a list: its title when it has one, else the name the
 * url gives away, else the url's host and path — never an empty label.
 */
export function resourceLinkLabel(kind: ResourceLinkKind, link: ResourceLink): string {
  const title = link.title.trim();
  if (title) return title;
  const name = resourceNameFromUrl(kind, link.url);
  if (name) return name;
  try {
    const { host, pathname } = new URL(link.url);
    return `${host}${pathname === "/" ? "" : pathname}`;
  } catch {
    return link.url;
  }
}

/** What a feature's chip reads: "Link Aha!" with none, else the count. */
export function resourceChipLabel(kind: ResourceLinkKind, count: number): string {
  const { name } = RESOURCE_LINK_TOOLS[kind];
  if (count === 0) return `Link ${name}`;
  return `${count} ${name} link${count === 1 ? "" : "s"}`;
}

/** Whether a url can join the list: an http(s) url the list does not hold yet. */
export function canAddResourceLink(links: ResourceLink[], url: string): boolean {
  const trimmed = url.trim();
  return isResourceLinkUrl(trimmed) && !links.some((l) => l.url === trimmed);
}

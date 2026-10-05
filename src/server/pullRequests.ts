// Pull request links (specs/external-links/related-pull-requests.feature.md):
// what a link's url is, and how it reads. Pure — shared by the server route
// that reads a pull request from GitHub and by the editor's field.

import type { PullRequestLink } from "./parser";
import { cleanLine } from "./text";

/** A GitHub pull request url, taken apart. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

const GITHUB_PR_RE =
  /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** The owner, repo and number of a GitHub pull request url; null for anything else. */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
  const m = url.trim().match(GITHUB_PR_RE);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

/** Whether a url may be linked at all: http or https, nothing else. */
export function isPullRequestUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url.trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The number a pull request url names — `/pull/<n>` on GitHub,
 * `/merge_requests/<n>` on GitLab, or a trailing `/<n>` — else null.
 */
export function pullRequestNumber(url: string): number | null {
  const m = url.trim().match(/\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#].*)?$/);
  if (m) return Number(m[1]);
  const tail = url.trim().match(/\/(\d+)\/?(?:[?#].*)?$/);
  return tail ? Number(tail[1]) : null;
}

/**
 * How a link reads in a list: `#<n> <title>` when both are known, `#<n>`
 * alone when there is no title, and the url's path when there is no number
 * either — never an empty label.
 */
export function pullRequestLabel(pr: PullRequestLink): string {
  const number = pullRequestNumber(pr.url);
  const title = pr.title.trim();
  if (number !== null) return title ? `#${number} ${title}` : `#${number}`;
  if (title) return title;
  try {
    const { host, pathname } = new URL(pr.url);
    return `${host}${pathname === "/" ? "" : pathname}`;
  } catch {
    return pr.url;
  }
}

/** Where a pull request stands, for the hint under the add field. */
export type PullRequestState = "open" | "draft" | "merged" | "closed";

/** What the lookup answers: the pull request as read, or why it wasn't. */
export type PullRequestLookup =
  | { number: number; title: string; state: PullRequestState; reason?: undefined }
  | { number?: undefined; title: null; state?: undefined; reason: string };

/** The rows the pull-requests route accepts: urls the field could have added. */
export function validPullRequests(input: unknown): PullRequestLink[] | null {
  if (!Array.isArray(input)) return null;
  const out: PullRequestLink[] = [];
  for (const row of input) {
    if (typeof row !== "object" || row === null) return null;
    const { url, title } = row as { url?: unknown; title?: unknown };
    if (typeof url !== "string" || !isPullRequestUrl(url)) return null;
    if (title !== undefined && typeof title !== "string") return null;
    out.push({ url: url.trim(), title: cleanLine(title ?? "") });
  }
  return out;
}

// The GitHub issues module's urls (specs/app/github-issues.feature.md),
// owned by the plugin rather than by src/frontend/route.ts:
//
//   /issues                                         the list
//   /issues/new                                     the new-issue form
//   /issues/<number>                                one issue

/** The module's views: the list, the new-issue form, or one issue. */
export type IssuesRoute = { kind: "list" } | { kind: "new" } | { kind: "issue"; number: number };

/**
 * The view a url names, or null when the url is not the module's. `/issues`
 * is the list, `/issues/new` the form, and a number opens that issue;
 * anything else under `/issues` is the list.
 */
export function parseIssuesRoute(pathname: string): IssuesRoute | null {
  const segs = pathname.split("/").filter(Boolean);
  if (segs[0] !== "issues") return null;
  if (segs[1] === "new" && !segs[2]) return { kind: "new" };
  const number = segs[1] && /^[1-9]\d*$/.test(segs[1]) && !segs[2] ? Number(segs[1]) : null;
  if (number !== null) return { kind: "issue", number };
  return { kind: "list" };
}

/** The url of a view — the inverse of parseIssuesRoute. */
export function issuesPath(view: IssuesRoute): string {
  switch (view.kind) {
    case "list":
      return "/issues";
    case "new":
      return "/issues/new";
    case "issue":
      return `/issues/${view.number}`;
  }
}

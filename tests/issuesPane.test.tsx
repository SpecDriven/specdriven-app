// specs/app/github-issues.feature.md on the client: the store transitions a
// mutation applies, the palette's search over the loaded issues, the window
// titles, and the rows and badges the pane renders. Pure helpers and static
// markup — no DOM.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentCard, IssueRow, LabelChip, StateBadge, StateFilter } from "../src/frontend/IssuesPane";
import {
  EMPTY_ISSUES,
  applyComment,
  applyIssue,
  issuesKey,
  issuesTitle,
  labelStyle,
  searchIssues,
  type Issue,
  type IssuesStore,
} from "../src/frontend/issues";

const issue = (number: number, extra: Partial<Issue> = {}): Issue => ({
  number,
  title: `Issue ${number}`,
  body: "",
  state: "open",
  stateReason: null,
  url: `https://github.com/acme/app/issues/${number}`,
  author: "octo",
  assignees: [],
  labels: [],
  comments: 0,
  createdAt: `2026-09-0${number}T10:00:00Z`,
  updatedAt: `2026-09-0${number}T10:00:00Z`,
  closedAt: null,
  ...extra,
});

const store: IssuesStore = {
  ...EMPTY_ISSUES,
  repo: { owner: "acme", name: "app", url: "https://github.com/acme/app" },
  issues: [issue(3, { title: "Crash on save", body: "Saving a quote crashes" }), issue(2), issue(1, { title: "Typo" })],
  loaded: true,
};

describe("store transitions", () => {
  test("an updated issue replaces its row and detail, ordered by update time", () => {
    const withDetail = { ...store, details: { 2: { issue: issue(2), comments: [] } } };
    const renamed = issue(2, { title: "Renamed", updatedAt: "2026-09-09T10:00:00Z" });
    const next = applyIssue(withDetail, renamed);
    expect(next.issues.map((i) => i.number)).toEqual([2, 3, 1]);
    expect(next.issues[0]!.title).toBe("Renamed");
    expect(next.details[2]!.issue.title).toBe("Renamed");
  });

  test("an issue that no longer fits the filter leaves the list but keeps its detail", () => {
    const withDetail = { ...store, details: { 3: { issue: issue(3), comments: [] } } };
    const closed = issue(3, { state: "closed", stateReason: "completed" });
    const next = applyIssue(withDetail, closed);
    expect(next.issues.map((i) => i.number)).toEqual([2, 1]);
    expect(next.details[3]!.issue.state).toBe("closed");
    // With "all" showing, it stays.
    expect(applyIssue({ ...withDetail, filter: "all" }, closed).issues.map((i) => i.number)).toEqual([3, 2, 1]);
  });

  test("a comment is appended to the opened issue and counted", () => {
    const withDetail = { ...store, details: { 1: { issue: issue(1), comments: [] } } };
    const comment = { id: 5, body: "Me too", author: "ada", url: "u", createdAt: "t", updatedAt: "t" };
    const next = applyComment(withDetail, 1, comment);
    expect(next.details[1]!.comments).toEqual([comment]);
    expect(next.details[1]!.issue.comments).toBe(1);
    expect(next.issues.find((i) => i.number === 1)!.comments).toBe(1);
    // An issue not opened is left alone.
    expect(applyComment(withDetail, 2, comment)).toBe(withDetail);
  });
});

describe("helpers", () => {
  test("the palette searches numbers, titles and bodies", () => {
    expect(searchIssues("crash", store).map((h) => h.number)).toEqual([3]);
    expect(searchIssues("quote crashes", store).map((h) => h.number)).toEqual([3]);
    expect(searchIssues("#1", store).map((h) => h.number)).toEqual([1]);
    expect(searchIssues("2", store).map((h) => h.number)).toEqual([2]);
    expect(searchIssues("", store)).toEqual([]);
    const hit = searchIssues("typo", store)[0]!;
    expect(hit.href).toBe("/issues/1");
    expect(hit.view).toEqual({ kind: "issue", number: 1 });
    expect(hit.sub).toBe("#1 · open");
  });

  test("titles and keys follow the view", () => {
    expect(issuesTitle({ kind: "list" }, store)).toBe("Issues");
    expect(issuesTitle({ kind: "new" }, store)).toBe("New issue");
    expect(issuesTitle({ kind: "issue", number: 3 }, store)).toBe("#3 Crash on save");
    expect(issuesTitle({ kind: "issue", number: 42 }, store)).toBe("Issue #42");
    expect(issuesKey({ kind: "list" })).toBe("issues:list");
    expect(issuesKey({ kind: "issue", number: 3 })).toBe("issues:3");
  });

  test("a label's colour is GitHub's hex, or grey when it has none", () => {
    expect(labelStyle("d73a4a").borderColor).toBe("#d73a4a80");
    expect(labelStyle("").borderColor).toBe("#9e9e9e80");
    expect(labelStyle("nope").background).toBe("#9e9e9e26");
  });
});

describe("markup", () => {
  const go = () => {};

  test("the state badge names open, closed and not planned", () => {
    expect(renderToStaticMarkup(<StateBadge issue={{ state: "open", stateReason: null }} />)).toContain("Open");
    const closed = renderToStaticMarkup(<StateBadge issue={{ state: "closed", stateReason: "completed" }} />);
    expect(closed).toContain('class="issue-state closed"');
    expect(closed).toContain(" Closed</span>");
    expect(renderToStaticMarkup(<StateBadge issue={{ state: "closed", stateReason: "not_planned" }} />)).toContain("Closed as not planned");
  });

  test("a row links to the issue with its number, labels, author and comments", () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <IssueRow issue={issue(3, { title: "Crash on save", labels: [{ name: "bug", color: "d73a4a" }], assignees: ["ada"], comments: 4 })} go={go} />
        </tbody>
      </table>,
    );
    expect(html).toContain('href="/issues/3"');
    expect(html).toContain("Crash on save");
    expect(html).toContain('class="issue-label"');
    expect(html).toContain("bug");
    expect(html).toContain("by octo");
    expect(html).toContain("ada");
    expect(html).toContain(">4<");
  });

  test("the label chip and comment card render their text", () => {
    expect(renderToStaticMarkup(<LabelChip label={{ name: "help wanted", color: "008672" }} />)).toContain("help wanted");
    const card = renderToStaticMarkup(
      <CommentCard comment={{ id: 1, body: "Fixed in **1.2**", author: "ada", url: "https://x", createdAt: "2026-09-03T10:00:00Z", updatedAt: "t" }} />,
    );
    expect(card).toContain("ada");
    expect(card).toContain("<strong>1.2</strong>");
  });

  test("the filter is a radio group with the chosen state checked", () => {
    const html = renderToStaticMarkup(<StateFilter filter="closed" onChange={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toContain(">All<");
    expect(renderToStaticMarkup(<StateFilter filter="open" onChange={() => {}} compact />)).not.toContain(">All<");
  });
});

// Automates specs/external-links/related-pull-requests.feature.md in the
// browser: the "Pull requests" field and the card's list — what they show,
// what may be added, and how the hint words a pull request's state.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PullRequestField,
  PullRequestList,
  canAddPullRequest,
  pullRequestStateHint,
} from "../src/frontend/PullRequestField";
import { scenarioSignature } from "../src/frontend/App";
import type { Scenario } from "../src/server/parser";

const PR1 = { url: "https://github.com/acme/repo/pull/12", title: "Quote engine" };
const PR2 = { url: "https://gitlab.com/acme/repo/-/merge_requests/5", title: "" };

describe("the scenario card lists its pull requests", () => {
  test("each as #n title, linking to it in a new tab", () => {
    const html = renderToStaticMarkup(<PullRequestList prs={[PR1, PR2]} />);
    expect(html).toContain(">#12 Quote engine</a>");
    expect(html).toContain(">#5</a>");
    expect(html).toContain(`href="${PR1.url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  test("a scenario with none shows no list", () => {
    expect(renderToStaticMarkup(<PullRequestList prs={[]} />)).toBe("");
  });
});

describe("the Pull requests field", () => {
  test("lists the links with a remove button each, and an add row", () => {
    const html = renderToStaticMarkup(<PullRequestField prs={[PR1]} onChange={() => {}} />);
    expect(html).toContain(">#12 Quote engine</a>");
    expect(html).toContain(`aria-label="Remove ${PR1.url}"`);
    expect(html).toContain('aria-label="Pull request url"');
    expect(html).toContain('aria-label="Pull request title"');
    // Nothing typed yet: Add is disabled.
    expect(html).toMatch(/<button type="submit" class="link" disabled="">Add<\/button>/);
  });

  test("before the scenario is in the document the field waits, and says so", () => {
    const html = renderToStaticMarkup(
      <PullRequestField
        prs={[]}
        onChange={() => {}}
        disabled
        disabledHint="Pull requests can be linked once the scenario has been saved."
      />,
    );
    expect(html).toContain("once the scenario has been saved");
    expect(html).toMatch(/<input[^>]*aria-label="Pull request url"[^>]*disabled=""/);
  });

  test("only an http(s) url the list does not already hold can be added", () => {
    expect(canAddPullRequest([PR1], PR2.url)).toBe(true);
    expect(canAddPullRequest([PR1], ` ${PR1.url} `)).toBe(false);
    expect(canAddPullRequest([], "javascript:alert(1)")).toBe(false);
    expect(canAddPullRequest([], "acme/repo#12")).toBe(false);
    expect(canAddPullRequest([], "")).toBe(false);
  });

  test("the hint words the state read from GitHub, or why nothing was read", () => {
    expect(pullRequestStateHint({ number: 12, title: "t", state: "open" })).toBe("#12 — Open");
    expect(pullRequestStateHint({ number: 12, title: "t", state: "merged" })).toBe("#12 — Merged");
    expect(pullRequestStateHint({ number: 12, title: "t", state: "draft" })).toBe("#12 — Draft");
    expect(pullRequestStateHint({ number: 12, title: "t", state: "closed" })).toBe(
      "#12 — Closed, not merged",
    );
    expect(pullRequestStateHint({ title: null, reason: "Pull requests are not read in demo mode." })).toBe(
      "Pull requests are not read in demo mode.",
    );
  });
});

test("linking a pull request is not an edit autosave has to write", () => {
  const s: Scenario = { name: "Basic", version: 1, status: "proposed", body: "b", tests: [] };
  expect(scenarioSignature({ ...s, prs: [PR1] }, 1)).toBe(scenarioSignature(s, 1));
});

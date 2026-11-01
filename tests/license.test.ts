// Automates specs/app/open-source-license.feature.md: the app is
// Apache-2.0, every copy links to the source of the version it runs, and
// pull requests from outside the team are closed.

import { afterEach, expect, test } from "bun:test";
import pkg from "../package.json";
import { RELEASE_REPO_URL, sourceUrl } from "../src/server/sourceUrl";
import { sourceCodeMenuItems } from "../src/frontend/App";
import { evaluate } from "./helpers/githubExpression";

const savedOverride = process.env.SPECDRIVEN_SOURCE_URL;
afterEach(() => {
  if (savedOverride === undefined) delete process.env.SPECDRIVEN_SOURCE_URL;
  else process.env.SPECDRIVEN_SOURCE_URL = savedOverride;
});

test("package.json names the license by its SPDX id", () => {
  expect(pkg.license).toBe("Apache-2.0");
});

test("LICENSE.md is the Apache License 2.0 and NOTICE.md names the copyright holder", async () => {
  const license = await Bun.file(new URL("../LICENSE.md", import.meta.url)).text();
  expect(license.trimStart().startsWith("Apache License")).toBe(true);
  expect(license).toContain("Version 2.0, January 2004");
  expect(license).toContain("4. Redistribution.");
  const notice = await Bun.file(new URL("../NOTICE.md", import.meta.url)).text();
  expect(notice).toContain("Apache-2.0");
  expect(notice).toContain("Copyright (c) 2026 David Vydra");
});

test("the desktop app ships the license and the notice", () => {
  expect(pkg.build.files).toContain("LICENSE.md");
  expect(pkg.build.files).toContain("NOTICE.md");
});

test("the source link names the release of the running version", () => {
  delete process.env.SPECDRIVEN_SOURCE_URL;
  expect(sourceUrl()).toBe(`${RELEASE_REPO_URL}/releases/tag/v${pkg.version}`);
  expect(sourceUrl("1.2.3")).toBe(`${RELEASE_REPO_URL}/releases/tag/v1.2.3`);
});

test("a deployment running modified code names its own source", () => {
  process.env.SPECDRIVEN_SOURCE_URL = " https://example.com/my-fork ";
  expect(sourceUrl()).toBe("https://example.com/my-fork");
  process.env.SPECDRIVEN_SOURCE_URL = "  ";
  expect(sourceUrl()).toBe(`${RELEASE_REPO_URL}/releases/tag/v${pkg.version}`);
});

test("the user menu offers Source code, which opens the source url", () => {
  const opened: string[] = [];
  const items = sourceCodeMenuItems("https://example.com/src", (u) => opened.push(u));
  expect(items.map((i) => [i.id, i.label, i.description])).toEqual([
    ["source-code", "Source code", "Apache-2.0"],
  ]);
  items[0]!.onSelect!();
  expect(opened).toEqual(["https://example.com/src"]);
});

test("no Source code item before the state names the url", () => {
  expect(sourceCodeMenuItems(null)).toEqual([]);
});

// "Pull requests are not accepted": .github/workflows/close-prs.yml, read as
// GitHub reads it, with the job's `if:` evaluated against sample pull
// requests rather than matched as text.
type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  on: Record<string, { types?: string[] }>;
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string; steps: Step[] }>;
};
const closePrs = Bun.YAML.parse(
  await Bun.file(new URL("../.github/workflows/close-prs.yml", import.meta.url)).text(),
) as Workflow;
const closeJob = closePrs.jobs.close!;

/** The `github` context of a pull request event on this repository. */
function pullRequest(headRepo: string, authorAssociation: string) {
  return {
    github: {
      repository: "SpecDriven/specdriven-app",
      event: {
        pull_request: {
          number: 7,
          author_association: authorAssociation,
          head: { repo: { full_name: headRepo } },
        },
      },
    },
  };
}

test("a pull request from a fork by someone without write access is closed, pointing to CONTRIBUTING.md and to proposing specs", () => {
  expect(closePrs.on).toEqual({ pull_request_target: { types: ["opened", "reopened"] } });
  for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN"]) {
    const closed = evaluate(closeJob.if!, pullRequest("someone/specdriven-app", association));
    expect(`${association} → ${closed}`).toBe(`${association} → true`);
  }
  const [step] = closeJob.steps;
  expect(closeJob.steps).toHaveLength(1);
  expect(step!.run!.trimStart()).toStartWith('gh pr close "$PR" --comment "');
  expect(step!.run).toContain("CONTRIBUTING.md");
  expect(step!.run).toContain("a proposed feature or scenario in SpecDriven/specs-specdriven");
});

test("pull requests from the team's own branches, or by people with write access, are left open", () => {
  // A branch pushed to this repository: its head repo is this one — compared
  // without case, as GitHub compares strings.
  for (const head of ["SpecDriven/specdriven-app", "specdriven/specdriven-app"]) {
    expect(evaluate(closeJob.if!, pullRequest(head, "NONE"))).toBe(false);
  }
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    const closed = evaluate(closeJob.if!, pullRequest("someone/specdriven-app", association));
    expect(`${association} → ${closed}`).toBe(`${association} → false`);
  }
});

test("the close workflow never checks out or runs the pull request's code", () => {
  // pull_request_target runs with a token that can write, so the job may only
  // read the event and call the API: no action (checkout included), no
  // expression spliced into the shell, and nothing from the pull request but
  // its number.
  expect(closePrs.permissions).toEqual({ "pull-requests": "write" });
  for (const step of Object.values(closePrs.jobs).flatMap((job) => job.steps)) {
    expect(step.uses).toBeUndefined();
    expect(step.run).not.toContain("${{");
    expect(step.run).not.toMatch(/\$\(|`/);
    expect(Object.values(step.env ?? {}).sort()).toEqual([
      "${{ github.event.pull_request.number }}",
      "${{ github.repository }}",
      "${{ github.token }}",
    ]);
  }
});

// The spec-proposals page (src/frontend/proposals/ProposalsApp.tsx,
// specs/app/spec-proposals.feature.md): what it shows signed in and out, the
// quota chip, the source link. Static markup and the pure helpers only.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AccountBar,
  canPropose,
  Footer,
  groupByFolder,
  quotaLabel,
  ScenarioForm,
  signInProblem,
  type Session,
} from "../src/frontend/proposals/ProposalsApp";

const base: Session = {
  signedIn: false,
  perDay: 5,
  repo: { owner: "SpecDriven", name: "specs-specdriven", url: "https://github.com/SpecDriven/specs-specdriven" },
  sourceUrl: "https://github.com/SpecDriven/specdriven-app-release/releases/tag/v1.0.0",
};
const signedIn: Session = {
  ...base,
  signedIn: true,
  user: { login: "ada", name: "Ada" },
  contributor: false,
  quota: { used: 2, limit: 5, resetsAt: 0 },
};

describe("the proposals page", () => {
  test("signed out, it offers Sign in with GitHub", () => {
    const html = renderToStaticMarkup(<AccountBar session={base} />);
    expect(html).toContain('href="/api/proposals/auth/start"');
    expect(html).toContain("Sign in with GitHub");
    expect(canPropose(base)).toBe(false);
  });

  test("signed in, it shows the login, what is left of today's allowance, and Sign out", () => {
    const html = renderToStaticMarkup(<AccountBar session={signedIn} />);
    expect(html).toContain("@ada");
    expect(html).toContain("3 of 5 proposals left today");
    expect(html).toContain("Sign out");
    expect(canPropose(signedIn)).toBe(true);
  });

  test("a spent allowance is shown as such and stops proposing; a contributor has none", () => {
    const spent = { ...signedIn, quota: { used: 5, limit: 5, resetsAt: 0 } };
    expect(renderToStaticMarkup(<AccountBar session={spent} />)).toContain("proposals-chip spent");
    expect(quotaLabel(spent.quota)).toBe("0 of 5 proposals left today");
    expect(canPropose(spent)).toBe(false);
    const contributor = { ...signedIn, contributor: true, quota: { used: 40, limit: null, resetsAt: 0 } };
    expect(quotaLabel(contributor.quota)).toBe("Contributor — no daily limit");
    expect(canPropose(contributor)).toBe(true);
    expect(canPropose({ ...signedIn, banned: true })).toBe(false);
  });

  test("the scenario form disables itself when proposing is not allowed", () => {
    const props = { name: "", body: "", busy: false, onName() {}, onBody() {}, onSubmit() {} };
    expect(renderToStaticMarkup(<ScenarioForm {...props} disabled={false} />)).not.toContain("disabled");
    expect(renderToStaticMarkup(<ScenarioForm {...props} disabled />)).toContain('disabled=""');
  });

  test("the footer links the spec repo and the source code under the Apache-2.0 license", () => {
    const html = renderToStaticMarkup(<Footer session={base} />);
    expect(html).toContain('href="https://github.com/SpecDriven/specs-specdriven"');
    expect(html).toContain(`href="${base.sourceUrl}"`);
    expect(html).toContain("Apache-2.0");
    expect(html).toContain("We don&#x27;t accept pull requests");
  });

  test("features group by folder, in order, and the filter narrows them", () => {
    const features = [
      { fileName: "specs/ui/b.feature.md", name: "Beta", scenarios: [] },
      { fileName: "specs/app/z.feature.md", name: "Zed", scenarios: [] },
      { fileName: "specs/app/a.feature.md", name: "Alpha", scenarios: [] },
    ];
    expect(groupByFolder(features).map(([folder, list]) => [folder, list.map((f) => f.name)])).toEqual([
      ["specs/app", ["Alpha", "Zed"]],
      ["specs/ui", ["Beta"]],
    ]);
    expect(groupByFolder(features, "be").map(([folder]) => folder)).toEqual(["specs/ui"]);
  });

  test("a sign-in that came back without a session says why", () => {
    expect(signInProblem(null)).toBeNull();
    expect(signInProblem("denied")).toMatch(/cancelled/);
    expect(signInProblem("expired")).toMatch(/expired/);
    expect(signInProblem("failed")).toMatch(/didn't work/);
  });
});

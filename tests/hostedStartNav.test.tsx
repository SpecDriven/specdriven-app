// The hosted start screens' links (src/frontend/HostedStartNav.tsx,
// specs/app/hosted-app.feature.md "The start screen leads to the account and
// admin pages"): static markup and the clone-error hint.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HostedStartNav, hostedCloneHint } from "../src/frontend/HostedStartNav";

describe("the hosted start screen's links", () => {
  test("an admin with no specs repo gets the account page, the admin page and Sign out", () => {
    const html = renderToStaticMarkup(
      <HostedStartNav account={{ email: "ada@example.com", admin: true }} onSignOut={() => {}} />,
    );
    expect(html).toContain("Signed in as ada@example.com");
    expect(html).toContain('href="/account"');
    expect(html).toContain('href="/admin"');
    expect(html).toContain("Sign out");
  });

  test("a user who is not an admin gets no admin link", () => {
    const html = renderToStaticMarkup(
      <HostedStartNav account={{ email: "bo@example.com", admin: false }} onSignOut={() => {}} />,
    );
    expect(html).toContain('href="/account"');
    expect(html).not.toContain('href="/admin"');
    expect(html).toContain("Sign out");
  });
});

describe("hostedCloneHint", () => {
  test("a token GitHub refuses points at the account page's token", () => {
    const refused =
      "Could not clone https://github.com/o/specs.git: Cloning into '/data/users/u/repos/specs'... " +
      "remote: Write access to repository not granted. fatal: unable to access " +
      "'https://github.com/o/specs.git/': The requested URL returned error: 403";
    expect(hostedCloneHint(refused)).toContain("GitHub token on your account page");
    expect(hostedCloneHint("fatal: The requested URL returned error: 401")).not.toBeNull();
    expect(hostedCloneHint("Could not clone x: authentication required — add a GitHub token")).not.toBeNull();
  });

  test("other errors and no error get no hint", () => {
    expect(hostedCloneHint(null)).toBeNull();
    expect(hostedCloneHint("Enter a GitHub url, such as https://github.com/owner/specs")).toBeNull();
  });
});

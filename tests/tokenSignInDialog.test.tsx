// The user menu's token sign-in (specs/user-info-settings.feature.md "sign in
// with a token from the user menu"): TokenSignInDialog in
// src/frontend/GitHubToken.tsx as static markup — the paste form, and who is
// signed in already when the token would switch accounts. App.tsx owns the
// open state and the menu entries.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenSignInDialog } from "../src/frontend/GitHubToken";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => {};

describe("TokenSignInDialog", () => {
  test("signed out, a modal dialog with the host and token fields", () => {
    const markup = html(<TokenSignInDialog auth={{ signedIn: false }} onSignedIn={noop} onClose={noop} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Sign in to GitHub");
    expect(markup).toContain('aria-label="GitHub host"');
    expect(markup).toContain('aria-label="Personal access token"');
    expect(markup).toContain("Or paste a personal access token");
    expect(markup).not.toContain("Signed in as");
  });

  test("signed in, it names the account the token would replace", () => {
    const markup = html(
      <TokenSignInDialog
        auth={{ signedIn: true, login: "octo", host: "ghe.example.com" }}
        onSignedIn={noop}
        onClose={noop}
      />,
    );
    expect(markup).toContain("Signed in as <strong>octo</strong>");
    expect(markup).toContain("on ghe.example.com");
    expect(markup).toContain("Replace it with a personal access token");
  });
});

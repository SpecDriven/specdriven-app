// Settings → Git & GitHub's Git access (specs/app/user-info-settings.feature.md
// "Git access"): radios for the GitHub CLI, a personal access token and —
// only while the GitHub account switch is on — the account sign-in, under a
// note that the GitHub CLI is recommended. Static markup of GitAccessChoice.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { accessShown, GitAccessChoice } from "../src/frontend/GitAccessChoice";

const noop = () => {};
const radios = (markup: string) => [...markup.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);

test("the GitHub CLI and the token are radios, with a note that the GitHub CLI is recommended", () => {
  const markup = renderToStaticMarkup(
    <GitAccessChoice value="gh" ghInstalled={true} accountOffered={false} onPick={noop} />,
  );
  const inputs = radios(markup);
  expect(inputs.map((i) => i.match(/value="(\w+)"/)![1])).toEqual(["gh", "token"]);
  expect(inputs[0]).toContain('checked=""');
  expect(markup).toContain("The GitHub CLI (gh) is recommended");
  expect(markup).toContain("Recommended");
  expect(markup).toContain("GitHub Personal Access Token");
  expect(markup).not.toContain("GitHub account sign-in");
});

test("with the GitHub account switch on, the account sign-in is the third radio", () => {
  const markup = renderToStaticMarkup(
    <GitAccessChoice value="account" ghInstalled={true} accountOffered={true} onPick={noop} />,
  );
  const inputs = radios(markup);
  expect(inputs.map((i) => i.match(/value="(\w+)"/)![1])).toEqual(["gh", "token", "account"]);
  expect(inputs[2]).toContain('checked=""');
  expect(markup).toContain("GitHub account sign-in");
});

test("without gh installed its radio is disabled and says where to get it", () => {
  const markup = renderToStaticMarkup(
    <GitAccessChoice value="token" ghInstalled={false} accountOffered={false} onPick={noop} />,
  );
  expect(radios(markup)[0]).toContain('disabled=""');
  expect(markup).toContain("cli.github.com");
});

test("the radios show the GitHub CLI by default where it is installed, else the token", () => {
  expect(accessShown(null, true, false)).toBe("gh");
  expect(accessShown(null, false, false)).toBe("token");
  expect(accessShown("token", true, false)).toBe("token");
  // The account sign-in only while its switch is on.
  expect(accessShown("account", true, true)).toBe("account");
  expect(accessShown("account", true, false)).toBe("token");
});

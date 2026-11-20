// Settings → Git & GitHub's Signed commits (specs/app/user-info-settings
// .feature.md "Signed commits"): the list of GitHub urls whose commits the
// app signs, each with what it covers and Remove, a field that adds one,
// and the SSH key's passphrase — shown as kept or not, never as text.
// Static markup of SignedCommits, and the rules behind its Add button.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  addSignedRepo,
  deleteSigningPassphrase,
  putSigningPassphrase,
  scopeWords,
  SignedCommits,
} from "../src/frontend/SignedCommits";

const saved = async () => true;
const noop = () => {};

test("lists each signed url with what it covers, and a field to add another", () => {
  const markup = renderToStaticMarkup(
    <SignedCommits
      repos={["https://github.com/acme/specs", "https://github.com/team", "https://github.example.com"]}
      passphraseKept={false}
      onSave={saved}
      onPassphraseKept={noop}
    />,
  );
  expect(markup).toContain("Signed commits");
  expect(markup).toContain("<strong>https://github.com/acme/specs</strong>");
  expect(markup).toContain("this repository");
  expect(markup).toContain("every repository of this owner");
  expect(markup).toContain("every repository on this host");
  expect(markup).toContain('aria-label="Stop signing commits to https://github.com/team"');
  expect(markup).toContain('placeholder="https://github.com/owner/repo"');
  // It says whose key signs: git's on this computer, not one the app holds.
  expect(markup).toContain("user.signingkey");
});

test("the passphrase field is a password field, and a kept passphrase is named, not shown", () => {
  const none = renderToStaticMarkup(
    <SignedCommits repos={[]} passphraseKept={false} onSave={saved} onPassphraseKept={noop} />,
  );
  const field = none.match(/<input[^>]*aria-label="SSH signing key passphrase"[^>]*>/)![0];
  expect(field).toContain('type="password"');
  expect(field).toContain('value=""');
  expect(none).not.toContain("A passphrase is kept on this computer");

  const kept = renderToStaticMarkup(
    <SignedCommits repos={[]} passphraseKept={true} onSave={saved} onPassphraseKept={noop} />,
  );
  expect(kept).toContain("A passphrase is kept on this computer");
  expect(kept).toContain('aria-label="Remove the kept passphrase"');
  expect(kept).toContain('placeholder="Replace the passphrase"');
});

test("adding takes a url in any form and keeps it as written; a non-url and a repeat are turned down", () => {
  expect(addSignedRepo([], "git@github.com:acme/specs.git")).toEqual({ repos: ["https://github.com/acme/specs"] });
  expect(addSignedRepo(["https://github.com/acme/specs"], "github.com/team")).toEqual({
    repos: ["https://github.com/acme/specs", "https://github.com/team"],
  });
  expect(addSignedRepo([], "acme/specs")).toEqual({ error: expect.stringContaining("Enter a GitHub url") });
  expect(addSignedRepo(["https://github.com/acme/specs"], "https://github.com/Acme/Specs.git")).toEqual({
    error: "https://github.com/Acme/Specs is on the list already.",
  });
});

test("a url is described by how much it covers", () => {
  expect(scopeWords("https://github.com/acme/specs")).toBe("this repository");
  expect(scopeWords("https://github.com/acme")).toBe("every repository of this owner");
  expect(scopeWords("https://github.example.com")).toBe("every repository on this host");
});

test("saving a passphrase reports what the server said, and removing one asks the server to forget it", async () => {
  const realFetch = globalThis.fetch;
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  };
  try {
    answer(200, { signingPassphrase: true, checked: true, key: "/keys/id_ed25519" });
    expect(await putSigningPassphrase("secret words")).toEqual({ checked: true, key: "/keys/id_ed25519" });
    expect(calls[0]).toEqual({
      url: "/api/signing/passphrase",
      method: "PUT",
      body: JSON.stringify({ passphrase: "secret words" }),
    });

    // No key file to try it on: kept, and said to be unchecked.
    answer(200, { signingPassphrase: true, checked: false, key: null });
    expect(await putSigningPassphrase("secret words")).toEqual({ checked: false, key: null });

    answer(400, { error: "That passphrase does not unlock /keys/id_ed25519" });
    expect(await putSigningPassphrase("not it")).toEqual({ error: "That passphrase does not unlock /keys/id_ed25519" });

    answer(200, { signingPassphrase: false });
    expect(await deleteSigningPassphrase()).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: "/api/signing/passphrase", method: "DELETE" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

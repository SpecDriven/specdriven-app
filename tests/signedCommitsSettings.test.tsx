// Settings → Git & GitHub's Signed commits (specs/app/user-info-settings
// .feature.md "Signed commits"): no list to fill in — the section says
// whether the open folder's commits are signed and what told the app so —
// and the SSH key's passphrase, shown as kept or not, never as text.
// Static markup of SignedCommits, and the words of its status line.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  deleteSigningPassphrase,
  putSigningPassphrase,
  SignedCommits,
  signingWords,
} from "../src/frontend/SignedCommits";

const noop = () => {};

test("the section asks for no url, and says whether the open folder's commits are signed and why", () => {
  const markup = renderToStaticMarkup(<SignedCommits signing="git-config" passphraseKept={false} onPassphraseKept={noop} />);
  expect(markup).toContain("Signed commits");
  // Nothing to list, add or remove.
  expect(markup).not.toContain("https://github.com/owner/repo");
  expect(markup).not.toContain("GitHub url whose commits are signed");
  expect(markup).not.toMatch(/<button[^>]*>\s*Add\s*<\/button>/);
  // What the app goes by, and whose key signs: git's on this computer.
  expect(markup).toContain("commit.gpgsign");
  expect(markup).toContain("user.signingkey");
  const status = markup.match(/<p class="hint signing-status" role="status">(.*?)<\/p>/)![1]!;
  expect(status).toContain("commits are signed");
  expect(status).toContain("git&#x27;s config on this computer says so");
});

test("the status line names what told the app, and says so when nothing did", () => {
  expect(signingWords("git-config")).toContain("git's config on this computer says so (commit.gpgsign)");
  expect(signingWords("history")).toContain("the latest commits on its remote are");
  expect(signingWords("listed")).toContain("signedCommitRepos");
  expect(signingWords("listed")).toContain("refused unsigned commits");
  for (const none of [null, undefined, "", "something else"]) {
    expect(signingWords(none)).toBe("The open folder's commits are not signed.");
  }
  const markup = renderToStaticMarkup(<SignedCommits signing={null} passphraseKept={false} onPassphraseKept={noop} />);
  expect(markup).toContain("The open folder&#x27;s commits are not signed.");
});

test("the passphrase field is a password field, and a kept passphrase is named, not shown", () => {
  const none = renderToStaticMarkup(
    <SignedCommits signing={null} passphraseKept={false} onPassphraseKept={noop} />,
  );
  const field = none.match(/<input[^>]*aria-label="SSH signing key passphrase"[^>]*>/)![0];
  expect(field).toContain('type="password"');
  expect(field).toContain('value=""');
  expect(none).not.toContain("A passphrase is kept on this computer");

  const kept = renderToStaticMarkup(
    <SignedCommits signing={null} passphraseKept={true} onPassphraseKept={noop} />,
  );
  expect(kept).toContain("A passphrase is kept on this computer");
  expect(kept).toContain('aria-label="Remove the kept passphrase"');
  expect(kept).toContain('placeholder="Replace the passphrase"');
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

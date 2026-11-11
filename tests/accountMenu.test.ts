// specs/app/user-info-settings.feature.md "log out from the user menu": the
// user menu offers "Log out" in place of "Sign in with token…".

import { expect, test } from "bun:test";
import { accountMenuEntries } from "../src/frontend/accountMenu";

test("signed out, the user menu offers Log out and no token sign-in", () => {
  expect(accountMenuEntries({ hosted: false, demo: false, signedIn: false })).toEqual(["log-out"]);
});

test("signed in, it offers Switch account and Log out", () => {
  expect(accountMenuEntries({ hosted: false, demo: false, signedIn: true })).toEqual(["switch-account", "log-out"]);
});

test("the hosted app and the demo offer neither", () => {
  for (const signedIn of [false, true]) {
    expect(accountMenuEntries({ hosted: true, demo: false, signedIn })).toEqual([]);
    expect(accountMenuEntries({ hosted: false, demo: true, signedIn })).toEqual([]);
  }
});

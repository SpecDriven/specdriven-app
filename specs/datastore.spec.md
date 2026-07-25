# Git-based data store

When we try to clone a private repo without being signed in we get

`Could not clone https://github.com/SpecDriven/data-insurance:
authentication required — sign in with GitHub in Settings`

A private repo needs the user signed in (specs/git-operations.spec.md):
cloning without a token fails fast with the sign-in hint instead of
hanging on a credential prompt. Public repos clone without signing in.

The clone runs on the selected git engine — the built-in JavaScript git by
default, so no git installation is needed. Remotes the built-in engine
cannot reach (ssh urls, local paths) fall back to the system git binary
when one is installed.

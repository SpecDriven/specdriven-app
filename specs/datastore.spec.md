# Git-based data store

When we try to clone a private repo without being signed in we get

`Could not clone https://github.com/SpecDriven/data-insurance:
authentication required — sign in with GitHub in Settings`

A private repo needs credentials (specs/git-operations.spec.md): cloning
without them fails fast with the sign-in hint instead of hanging on a
credential prompt. Public repos clone without signing in.

The clone runs on the selected git engine: `gh repo clone` on the GitHub
CLI engine, `git clone` on the system-git one, and the app's own clone on
the built-in one. Anything that is not a github.com repository url — an
ssh remote, a local path — is cloned by git itself on either of the two
engines that have one.

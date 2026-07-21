# git uses correct scheme to authenticate

- use git scheme in user settings

Every git command that talks to GitHub — clone, pull, push, ls-remote —
follows one scheme: `https`, `ssh` or `gh` (the GitHub CLI acting as git's
credential helper). The data-repo url only identifies the repository; the
scheme decides how git connects and authenticates.

- The scheme is the `Git scheme` setting in the Settings dialog
  (specs/user-info-settings.spec.md), stored in the settings file as `gitScheme`.
- With no explicit choice the scheme is auto-discovered: probe the data repo
  in the order https, ssh, gh and use the first scheme that authenticates.
  The discovery holds for the server run; it is not written to settings, so
  a changed environment is re-probed after a restart or after switching the
  setting back to auto.
- The scheme is applied per command (git `url.<base>.insteadOf` and
  `credential.helper` config), so every command follows it no matter which
  url the clone was created with.
- The `gh` scheme needs the GitHub CLI: it cannot be chosen when `gh` is not
  installed, and auto-discovery skips it.
- Repos without a GitHub remote (the local starter setup, plain local dirs)
  have no scheme; git commands run unchanged there.

## Scenario: choose a scheme in settings

- When: the user picks `ssh` as the Git scheme in the Settings dialog
- Then: the choice is saved to the settings file (specs/app-start.spec.md)
- and clone, pull and push all use ssh, even for a repo cloned over https

## Scenario: auto-discover the scheme

- When: no Git scheme is chosen in settings
- Then: the schemes are probed in the order https, ssh, gh
- and the first one that authenticates is used for all git commands
- and the Settings dialog shows the discovered scheme next to Auto-discover

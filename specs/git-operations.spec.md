# git engine and GitHub authentication

- use the GitHub CLI when the machine has one; plain git otherwise

Every git operation the app performs — clone, pull, push, commit, mv, rm —
runs the system `git` binary, so git is required. What the `Git engine`
setting in the Settings dialog picks (stored in the settings file as
`gitEngine`) is who supplies the GitHub credentials:

- `gh` — the GitHub CLI. Credentials come from gh's own credential helper,
  scoped to github.com so helpers configured for other hosts are left
  alone, and a GitHub repo is cloned with `gh repo clone`. It cannot be
  chosen when no gh is installed.
- `cli` — plain system git, authenticating with the app's own GitHub
  sign-in below, or with whatever credentials the machine already has.

With no choice recorded the engine is `gh` wherever gh is installed, and
`cli` otherwise. An engine named in the settings file but no longer
installed is an error on the next operation, not a silent switch to the
other one.

The GitHub CLI engine only takes over what gh can actually do. Installed
but signed out, gh has nothing to contribute, so commands run exactly as
they would on plain git — the machine's own credentials keep working — and
anything that is not a github.com repository url is cloned with
`git clone`.

## GitHub sign-in (device flow)

Independently of gh, the user can sign in from the Settings dialog via the
GitHub App device flow: the app shows a short code, the user enters it at
github.com/login/device, and the app polls until GitHub confirms. The
resulting user token

- is the HTTPS credential the `cli` engine authenticates with
  (`x-access-token:<token>`, fed to git through an environment-fed
  credential helper, never on the command line),
- provides the identity that authors data-repo commits (name, email —
  falling back to the account's noreply address when the email is
  private), shown in the User info dialog.

The token is stored outside the settings file — OS-encrypted via Electron
safeStorage in the desktop app, a user-only (0600) file next to the home
settings file otherwise. `/api/state` reports the signed-in account but
never the token.

On the `gh` engine the same two things come from gh instead: its
credential helper authenticates, and `gh api user` gives the account that
authors the commits. Neither engine writes to the machine's git config;
credentials and commit identity are passed per command.

With no credentials at all, public repos still work and a private one
fails fast with `authentication required — sign in with GitHub in
Settings` instead of hanging on a credential prompt.

## Scenario: choose the engine in settings

- When: the user picks `System git` as the Git engine in the Settings dialog
- Then: the choice is saved to the settings file (specs/app-start.spec.md)
- and clone, pull and push authenticate with the app's own sign-in
- and each engine's option is refused when its binary is not installed

## Scenario: the GitHub CLI is the default when installed

- When: no Git engine is chosen and gh is installed
- Then: clone, pull, push, commit and delete all run with gh's credentials
- and cloning a GitHub repo goes through `gh repo clone`
- and the commits are authored by the gh account

## Scenario: gh installed but signed out

- When: the GitHub CLI engine is in effect and `gh auth token` has nothing
- Then: git runs with the machine's own credentials and git identity, as
  it would on the system-git engine
- and the Settings dialog says gh is signed out and how to fix it

## Scenario: sign in with GitHub

- When: the user clicks "Sign in with GitHub" in the Settings dialog
- Then: a short code appears with a link to github.com/login/device
- and after the user authorizes there, the dialog shows the signed-in
  account
- and pushes on the system-git engine authenticate with that account

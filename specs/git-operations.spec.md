# git engine and GitHub authentication

- use the GitHub CLI when the machine has one; plain git otherwise; and
  the app's own git when the machine has neither

Every git operation the app performs — clone, pull, push, commit, mv, rm —
runs through one of three engines. The `Git engine` setting in the Settings
dialog picks which (stored in the settings file as `gitEngine`):

- `gh` — the GitHub CLI, on top of the system git binary. Credentials come
  from gh's own credential helper, scoped to github.com so helpers
  configured for other hosts are left alone, and a GitHub repo is cloned
  with `gh repo clone`. It cannot be chosen when no gh is installed.
- `cli` — plain system git, authenticating with the app's own GitHub
  sign-in below, or with whatever credentials the machine already has. It
  cannot be chosen when no git is installed.
- `js` — the built-in engine: git implemented in JavaScript, running
  inside the app against the ordinary files on disk. It needs nothing
  installed, so it can always be chosen, and it authenticates with the
  app's own GitHub sign-in.

With no choice recorded the engine is the best of what the machine has:
`gh` wherever gh is installed, then `cli` wherever git is, and `js` when
neither is. An engine named in the settings file but no longer installed
is an error on the next operation, not a silent switch to another one.

The three are interchangeable, not layered: they read and write the same
repositories in the same on-disk format, so a repository the built-in
engine cloned, committed to or merged is an ordinary git repository that
the git binary — and any other tool — reads normally, and vice versa.

The GitHub CLI engine only takes over what gh can actually do. Installed
but signed out, gh has nothing to contribute, so commands run exactly as
they would on plain git — the machine's own credentials keep working — and
anything that is not a github.com repository url is cloned with
`git clone`.

## GitHub sign-in

Independently of gh, the user can sign in from the Settings dialog, two
ways over the same GitHub App:

- **Connect to GitHub** (browser OAuth, the web application flow): the
  browser opens github.com's authorize page and GitHub redirects back to
  the app server's `/api/auth/github/callback`, which exchanges the code
  for the token (with PKCE and a state nonce). It needs
  `SPECDRIVEN_GITHUB_CLIENT_SECRET` alongside the client id — GitHub
  requires the App's client secret to exchange the code — and the GitHub
  App must list the app's callback url (for example
  `http://127.0.0.1:3000/api/auth/github/callback`) among its callback
  URLs. Offered only where the app runs on an http(s) origin; the desktop
  app's `app://` pages have no url GitHub could redirect to, so they offer
  the device flow alone.
- **Device flow**: the app shows a short code, the user enters it at
  github.com/login/device, and the app polls until GitHub confirms. Needs
  only the client id.

Either way the resulting user token

- is the HTTPS credential the `cli` and `js` engines authenticate with
  (`x-access-token:<token>`, fed to git through an environment-fed
  credential helper on `cli`, handed straight to the built-in engine on
  `js`, and never on a command line),
- provides the identity that authors data-repo commits (name, email —
  falling back to the account's noreply address when the email is
  private), shown in the User info dialog.

The token is stored outside the settings file — OS-encrypted via Electron
safeStorage in the desktop app, a user-only (0600) file next to the home
settings file otherwise. `/api/state` reports the signed-in account but
never the token.

On the `gh` engine the same two things come from gh instead: its
credential helper authenticates, and `gh api user` gives the account that
authors the commits. No engine writes to the machine's git config;
credentials and commit identity are passed per command.

Signed out, each engine leaves the machine's own git identity to author:
the repository's git config, then the user's global one. The built-in
engine may be running where there is no git config at all, so below both
it falls back to the OS user rather than failing for want of an author.

With no credentials at all, public repos still work and a private one
fails fast with `authentication required — sign in with GitHub in
Settings` instead of hanging on a credential prompt.

A commit that fails is reported as a failure. The app never says a spec
was committed and pushed when it was not.

## Scenario: choose the engine in settings

- When: the user picks `System git` as the Git engine in the Settings dialog
- Then: the choice is saved to the settings file (specs/app-start.spec.md)
- and clone, pull and push authenticate with the app's own sign-in
- and each engine's option is refused when its binary is not installed,
  which never refuses the built-in one

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

## Scenario: the built-in engine is the default with no git installed

- When: no Git engine is chosen and the machine has neither gh nor git
- Then: the built-in engine is in effect
- and clone, pull, push, commit, move and delete all still work
- and what it writes is an ordinary git repository, which the git binary
  reads normally once there is one

## Scenario: connect to GitHub via the browser

- When: the user clicks "Connect to GitHub" in the Settings dialog
- Then: the browser opens GitHub's authorize page
- and after the user approves there, GitHub redirects to the app's
  callback url, the tab says it is done, and the dialog shows the
  signed-in account
- and pushes on the system-git and built-in engines authenticate with
  that account
- and a callback with a wrong or reused state nonce is refused and does
  not cancel the sign-in in progress

## Scenario: sign in with GitHub (device code)

- When: the user clicks "Use a device code instead" in the Settings dialog
- Then: a short code appears with a link to github.com/login/device
- and after the user authorizes there, the dialog shows the signed-in
  account
- and pushes on the system-git engine authenticate with that account

## Scenario: a failed pull is an error, not a merge conflict

- When: a publish's `git pull` fails without leaving conflicted files —
  no credentials, no network, a missing remote
- Then: the publish reports that failure as an error
- and no merge-conflict dialog opens claiming the file is missing on the
  remote

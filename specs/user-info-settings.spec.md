# User Info

- lower left corner of the screen should show the current user
- by default this is the user on the OS
- User Menu will have user info and settings options

The lower left corner of the sidebar shows a user chip: an avatar circle with
the user's initials and the user name. The name is the OS user by default;
the server reports it via `/api/state`.

- Clicking the chip opens the User Menu just above it, with two options:
  "User info" and "Settings". Settings opens the existing Settings dialog
  (which moved here from the old corner button).
- ESC or a click elsewhere closes the menu.
- "User info" opens a dialog showing the OS user, the signed-in GitHub
  account, and the name/email that author the app's commits to the data
  repo — the GitHub identity when signed in
  (specs/git-operations.spec.md), else the system git identity
  (user.name / user.email from git config). Missing values show "not
  set"; no GitHub account shows "not signed in".
- Initials come from the identity name when set, otherwise from the OS
  user name.

## Scenario: see the current user

- When: the app is open
- Then: the lower left corner shows the OS user behind a small avatar chip

## Scenario: open the user menu

- When: the user clicks the chip
- Then: a menu appears with "User info" and "Settings"
- and ESC or clicking anywhere else closes it

## Scenario: view user info

- When: the user picks "User info" from the menu
- Then: a dialog shows the OS user, the GitHub account, and the name and
  email used for commits to the data repo

## Git engine [automatic | GitHub CLI | system git]

- The Settings dialog offers the Git engine: `Automatic — GitHub CLI when
  installed (recommended)`, `GitHub CLI (gh)` or `System git`
  (specs/git-operations.spec.md)
- each option is disabled when its binary is not installed
- The Settings dialog holds the GitHub account section: it reports what
  the GitHub CLI is signed in as, and "Sign in with GitHub" starts the
  device flow; signed in, it shows the account and a "Sign out" button

## Scenario: sign in from settings

- When: the user clicks "Sign in with GitHub" in Settings
- Then: the dialog shows the one-time code and a link to
  github.com/login/device
- and once the user authorizes there, the dialog shows
  "Signed in as <login>"

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
- "User info" opens a dialog showing the OS user and the git identity
  (user.name / user.email from git config) — the identity that authors the
  app's commits to the data repo. A missing git identity shows "not set".
- Initials come from the git name when set, otherwise from the OS user name.

## Scenario: see the current user

- When: the app is open
- Then: the lower left corner shows the OS user behind a small avatar chip

## Scenario: open the user menu

- When: the user clicks the chip
- Then: a menu appears with "User info" and "Settings"
- and ESC or clicking anywhere else closes it

## Scenario: view user info

- When: the user picks "User info" from the menu
- Then: a dialog shows the OS user and the git name and email used for
  commits to the data repo

## Git scheme [https | ssh | gh]

- Logged in user uses one of the 3 schemes [https | ssh | gh]
- Support choosing a scheme in the settings dialog box
- Auto-discover current scheme by probing
  - order: https, ssh, gh

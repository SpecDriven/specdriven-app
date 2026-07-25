# git engine and GitHub authentication

- use built-in git by default; fall back to the system git binary

The app talks to git through one of two engines, selected by the `Git
engine` setting in the Settings dialog (stored in the settings file as
`gitEngine`):

- `js` — the built-in JavaScript git implementation (the default). It is
  bundled with the app, needs no git installation, and speaks HTTPS
  (smart-HTTP) only.
- `cli` — the system `git` binary, run as a subprocess. It cannot be
  chosen when no git is installed.

Every operation — clone, pull, push, commit, mv, rm — goes through the
selected engine. When the built-in engine cannot handle an operation (an
unsupported merge case, a non-HTTPS remote such as an ssh url or a local
path), the operation is retried on system git if one is installed, and
that repo stays on system git for the rest of the server run. Domain
outcomes — merge conflicts, authentication failures, "no upstream" — never
fall back: the other engine would answer the same. A repo with an
unfinished merge stays on the engine that started it.

## GitHub sign-in (device flow)

The user signs in from the Settings dialog via the GitHub App device flow:
the app shows a short code, the user enters it at github.com/login/device,
and the app polls until GitHub confirms. The resulting user token

- is the HTTPS credential for both engines (`x-access-token:<token>`; the
  system engine receives it through an environment-fed credential helper,
  never on the command line),
- provides the identity that authors data-repo commits (name, email —
  falling back to the account's noreply address when the email is
  private), shown in the User info dialog.

The token is stored outside the settings file — OS-encrypted via Electron
safeStorage in the desktop app, a user-only (0600) file next to the home
settings file otherwise. `/api/state` reports the signed-in account but
never the token.

Signed out, the built-in engine works for public repos (reads) and fails
fast with a sign-in hint on private ones; the system engine runs git
unchanged, with whatever credentials the machine already has.

The built-in engine tracks an in-progress merge in
`.git/specdriven-merge.json` (the system engine uses git's own
MERGE_HEAD); it survives an app restart mid-conflict and can never be
committed.

## Scenario: choose the engine in settings

- When: the user picks `System git` as the Git engine in the Settings dialog
- Then: the choice is saved to the settings file (specs/app-start.spec.md)
- and clone, pull and push all shell out to the system git binary
- and the option is refused when no git is installed

## Scenario: built-in engine needs no git installation

- When: no Git engine is chosen and no git binary is installed
- Then: clone, pull, push, commit and delete all work through the
  built-in engine over HTTPS

## Scenario: fall back to system git

- When: the built-in engine hits an operation it cannot handle (e.g. a
  local-path or ssh remote) and a git binary is installed
- Then: the operation reruns on system git and succeeds
- and the result notes `(used system git)`
- and the repo stays on system git for the rest of the server run

## Scenario: sign in with GitHub

- When: the user clicks "Sign in with GitHub" in the Settings dialog
- Then: a short code appears with a link to github.com/login/device
- and after the user authorizes there, the dialog shows the signed-in
  account
- and pushes authenticate with the account's token on either engine

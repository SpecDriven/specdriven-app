When the application starts, if the settings file does not
contain the name of the last data repo, the user is asked the name of the data repo.

Data repo format: https://github.com/SpecDriven/data-insurance (regular gitHub url)

# Settings file

Local state lives in `.specdriven/settings.json`, looked up in this order:

- `./.specdriven/settings.json`, relative to the directory the app runs from
- `~/.specdriven/settings.json`, so one settings file can serve every checkout

`SPECDRIVEN_HOME` overrides that home directory — the same variable install.sh
uses for the install prefix. Settings are saved back to whichever of the two
the app read; when neither exists, the project one is created.

## Scenario: changing the data repo

- Given: a data repo is configured, and the sidebar header shows its folder
  name only — parent folders appear in a tooltip, and the full path in the
  edit dialog
- When: the user clicks the edit (✎) button next to the name
- Then: a dialog opens pre-filled with the current data repo
- and confirming a new value switches the app to that repo, resetting the
  view to home (the old selection belonged to the old repo)
- and a value the server rejects leaves the current repo in place, with the
  error shown as a status note

## Scenario: picking the data directory with the native folder chooser

- Given: the runtime has a native folder chooser (the desktop app, or the
  local web server on macOS)
- When: the user clicks "Browse…" next to the data directory field — in the
  first-run form or in the Data directory dialog
- Then: the OS folder chooser opens (parented to the window in the desktop
  app; a Finder chooser owned by the local server in web mode)
- and picking a folder fills the field with its absolute path, leaving the
  user to confirm
- and canceling the chooser leaves the field unchanged
- and on runtimes with no native chooser the "Browse…" button is not shown

## Scenario: no settings file anywhere

- Given: neither settings file exists
- When: the app starts
- Then: the user is asked for the data repo

## Scenario: only the home settings file exists

- Given: `~/.specdriven/settings.json` names a data repo, and the project has
  no settings file
- When: the app starts
- Then: the user is not asked for a data repo
- and settings saved from the Settings dialog go back to the home settings file

## Scenario: the project settings file wins

- Given: both settings files exist
- When: the app starts
- Then: the project settings file is used
- and saving settings leaves the home settings file untouched

## Scenario: migrating the pre-settings.json layout

- Given: a plain `.specdriven` file (the old layout) is in the project root
- When: the app starts
- Then: it is read as the settings file
- and the next save moves it to `./.specdriven/settings.json`, preserving
  every setting

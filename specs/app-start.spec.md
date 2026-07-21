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

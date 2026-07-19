# Scenario table

- a separate table widget in the Scenario dialog to make it convenient to work with tables
- add/remove rows and columns
- automatically create columns for variables in the body
  - var format {var}

The table is stored as a plain markdown table inside the scenario body, so it
renders naturally on GitHub, in the preview tab, and on the scenario cards;
the widget is a structured view over that text — editing the grid rewrites
the table in the body, and editing the body source updates the grid.

- The widget appears below the body editor and edits the last markdown table
  in the body (tables inside fenced code blocks don't count).
- Cells and column headers are edited in place.
- Variable names use letters, digits, `_` and `-`. When a variable appears in
  the body and the table has no column of that name, the column is added; if
  there is no table yet, one is created with a column per variable and one
  empty row. Variables inside the table itself or in code fences don't count.
- A column whose name matches a variable still present in the body is owned
  by the variable: it can be neither renamed nor removed in the widget —
  edit or remove the `{var}` in the body instead. Other columns rename and
  remove freely.
- Removing the last column removes the table from the body. Removing the last
  row leaves a header-only table.
- With no table in the body, the widget offers "+ Add table" instead.
- Published scenarios are immutable: the widget is not shown (the preview
  still renders the table).

## Scenario: variable creates a column

- When: the body gains a variable such as {amount}
- Then: the table gets an "amount" column, creating the table if the body had
  none
- Otherwise: a column of that name already exists, and nothing changes

## Scenario: edit the table as a grid

- When: the user edits cells, adds or removes rows and columns in the widget
- Then: the markdown table in the body is rewritten to match, and the body
  editor shows the change immediately

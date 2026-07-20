# Folders

Features can be organized into folders. A folder is a plain directory in the
data repo, so the structure renders naturally on GitHub too.

- The left sidebar displays the folder tree: folders first (collapsible, with
  a disclosure triangle), then features, both sorted alphabetically. Features
  at the repo top level appear at the root of the tree.
- Folders can nest arbitrarily.
- Clicking a folder selects it (shown with an outline) and toggles its
  subtree. Opening a feature or clicking the tree background deselects;
  deleting a selected folder (or an ancestor of it) deselects too. ESC
  deselects as well, putting the insertion point back at the tree root so
  the next "+ New folder" lands at the top level.
- "+ New folder" creates a folder; `/` in the name creates nested folders.
  Folder names are slugified like feature file stems. Git does not track empty
  directories, so a new folder exists locally until a feature lands in it.
- With a folder selected, "+ New folder" creates the new folder inside it —
  the prompt says which folder it will land in. The parent is expanded to
  reveal the new folder, and the new folder becomes the selected one, so
  repeated "+ New folder" clicks build a nested path.
- "+ New feature" accepts `folder/name` to create the feature inside a folder
  (folders are created as needed).
- A feature can be drag-moved from folder to folder (or to the tree root =
  the repo top level). The target folder highlights while dragging over it;
  dropping anywhere on a folder's subtree drops into that folder. The move is
  a `git mv` into the target directory, committed and pushed, keeping the
  feature's file name.
- The moved feature keeps its selection; its url follows the new folder path
  (specs/navigation.spec.md).
- A folder can be deleted only when no files remain anywhere beneath it —
  move the features out first. Deleting asks for confirmation; a non-empty
  folder is refused with an explanation. Empty folders being untracked by
  git, deletion is a local filesystem operation.
- The Edit link edits the feature name only (specs/ui.spec.md), never the
  file name or its folder; moving a feature between folders is done by
  dragging.

## Scenario: move feature to another folder

- When: user drags a feature onto another folder (or the tree root)
- Then: the file is moved with `git mv`, keeping its file name
- and the move is committed and pushed

## Scenario: deselect a folder with ESC

- When: a folder is selected and the user presses ESC outside a dialog or text field
- Then: the folder is deselected and "+ New folder" creates at the tree root
- Otherwise: with a dialog open or a field focused, ESC closes/cancels that instead

## Scenario: delete a folder

- When: user asks to delete a folder with no files anywhere beneath it
- Then: the folder is removed (a local filesystem operation — git does not
  track empty directories)
- Otherwise: the deletion is refused; features must be moved out first

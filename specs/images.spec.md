# Images in scenarios

A scenario body can embed images — a screenshot pasted from the clipboard or
an image file picked from disk. Images live in the data repo like everything
else, so they sync through git with the features that reference them. The
`![...](/api/images/<name>)` references resolve inside the app; on GitHub the
files are browsable under `.images/`.

- In the scenario edit dialog's Write tab, pasting clipboard content that
  contains an image uploads it and inserts `![alt](/api/images/<name>)` at
  the caret. Plain text pastes are untouched.
- The 🖼 toolbar button opens the OS file picker (images only, multiple
  allowed); each chosen file uploads and inserts the same way.
- Uploaded images are stored as files under `.images/` at the data repo root.
  The dot-folder keeps them out of the sidebar's folder tree while git tracks
  them; each upload is committed and pushed like a feature edit.
- Stored names are content-addressed: `<slugified stem>-<content hash>.<ext>`.
  Uploading the same bytes twice reuses the existing file, and a served name
  never changes content, so responses carry immutable cache headers.
- Supported types: png, jpg, jpeg, gif, webp, svg, avif — anything else is
  refused, as are empty files and files over 10 MB.
- The Preview tab (and every rendered scenario body) shows the image, scaled
  down to fit the dialog width.
- While an upload runs the toolbar shows "Uploading…"; a failed upload shows
  the error in the toolbar and inserts nothing.

## Scenario: paste an image from the clipboard

- When: the user pastes clipboard content containing an image into the body
- Then: the image is uploaded to `.images/` in the data repo, committed and
  pushed
- and `![alt](/api/images/<name>)` is inserted at the caret

## Scenario: upload an image file

- When: the user clicks 🖼 and picks one or more image files
- Then: each file is uploaded and inserted like a pasted image

## Scenario: repeated upload of the same image

- When: an image with bytes already stored under `.images/` is uploaded again
- Then: the existing file is reused — same name, no new commit

## Scenario: unsupported file is refused

- When: the uploaded file is not a supported image type, is empty, or exceeds
  10 MB
- Then: nothing is stored and the toolbar shows the reason

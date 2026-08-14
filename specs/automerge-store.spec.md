# Automerge system of record

The data repo's system of record is a set of Automerge (CRDT) documents, one
per feature. The `.feature.md` files that render on GitHub are deterministic
projections of those documents — same doc, same bytes, on every peer.

## Storage layout

Each feature's document lives beside the markdown, inside the data repo:

```
policy/auto-policy.feature.md                          <- projection
.specdriven/automerge/features/policy/auto-policy.feature.md/
    docid                                              <- shared identity
    snapshot-<hash>.bin                                <- full document
    changes-<hash>.bin                                 <- incremental changes
```

Chunk files are content-addressed and write-once, so two peers pushing
concurrently never collide on a path: a git merge of their pushes is a plain
union of files, and loading merges every chunk into one document. Once
enough change files pile up, a save folds them into a fresh snapshot and
deletes them from the working tree (compaction).

## Scenario: two peers edit the same scenario concurrently

Peer A and peer B both edit the body of the same scenario, even the same
line. Each save becomes CRDT operations in the feature's document. When
their pushes meet in a git pull, the markdown conflicts — but the sync tick
resolves it from the merged document, character-level, with no conflict
dialog. Both edits survive on both peers, byte-identical.

## Scenario: markdown edited outside the app

A feature file edited where no document ops exist — an older app version, a
hand edit merged through a GitHub PR — drifts from its document's
projection. The next sync tick absorbs the drift into the document (a
scenario-level three-way merge against the git merge base when the pull
conflicted) and rewrites the file to the canonical projection. The GitHub
PR workflow stays a first-class way to edit specs.

## Scenario: published scenarios stay immutable

Drift that changes the body of a published scenario is refused: the file is
repaired from the document and the repair is committed, so tampering with
published history — accidental or otherwise — does not stick. In-app writes
are refused at save time, as before. An explicit human conflict resolution
is the one door that may override the document's published state.

## Scenario: a feature deleted outside the app

When a pull removes a feature file, the next sync tick removes its document
directory too — the markdown is the interchange format, and its deletion
carries the intent.

## Scenario: a repo that predates documents

Feature files with no document behind them behave as before until touched:
the first save, publish, or sync tick imports them (the document is minted
from the parsed markdown). Nothing breaks for collaborators on older app
versions — their plain-markdown pushes keep working and are absorbed as
drift. If two peers import the same feature concurrently, the merge picks
one document identity deterministically and folds both sides' content in.

## Scenario: optional live sync over websocket

Settings can name a sync server (e.g. wss://sync.automerge.org). While one
is named, every feature document is announced to it under an identity all
peers derive from the docid file, local saves stream out as CRDT operations
in near-real time, and arriving operations merge into the chunk store and
rewrite the markdown projection — the next sync tick commits them, so git
remains the source of record. Double delivery over both transports is
harmless: merging the same operations twice is a no-op. The setting is off
by default and the Settings dialog warns that on a public server anyone
holding a document's id can read that document; peers with private data
point it at a self-hosted sync server instead.

## Decisions

Git stays the required transport and GitHub access stays the whole
authorization model (ARCHITECTURE.md): the documents ride the same clone,
pull and push as the markdown. No sync server is required; the optional
websocket sync above accelerates delivery without changing the source of
record.

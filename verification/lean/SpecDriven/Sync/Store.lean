import SpecDriven.Sync.Crdt
import SpecDriven.Sync.Schema

/-!
# Store

`src/server/automerge/store.ts` at the level of chunk files: `chunkFiles`,
`loadDoc`, `saveDoc`, `compactDoc`, and the `migrated` schema upgrade.

A document directory is a list of chunks. A chunk is a content-addressed,
write-once file holding a change set; unreadable (corrupt) chunks are kept
in the list with `readable := false`, since `loadDoc` skips them and
`compactDoc` must not delete them.
-/

namespace SpecDriven.Sync

inductive ChunkKind where
  | snapshot
  | changes
  deriving DecidableEq, Repr

structure Chunk where
  /-- `snapshot-<hash>.bin` or `changes-<hash>.bin`; the hash is of the bytes. -/
  name : String
  kind : ChunkKind
  changes : ChangeSet
  readable : Bool := true
  deriving Repr

/-- `COMPACT_AT` in store.ts. -/
def COMPACT_AT : Nat := 12

/-- `loadDoc`: merge every readable chunk, in whatever order `chunkFiles`
lists them (sorted by name). -/
def loadChunks (cs : List Chunk) : ChangeSet :=
  (cs.filter (·.readable)).flatMap (·.changes)

/-- The chunks `loadDoc` reports in `skippedChunks`. -/
def skippedChunks (cs : List Chunk) : List Chunk := cs.filter (!·.readable)

/-- `compactDoc`: past `COMPACT_AT` change files, write one snapshot of what
loaded and delete every chunk that loaded. `hashOf` is the content hash. -/
def compactDoc (hashOf : ChangeSet → String) (cs : List Chunk) : List Chunk :=
  if (cs.filter (·.kind == .changes)).length < COMPACT_AT then cs
  else
    let loaded := loadChunks cs
    { name := hashOf loaded, kind := .snapshot, changes := loaded } :: skippedChunks cs

/-- `saveDoc`: a no-op delta writes nothing; otherwise one change chunk, then
compaction. -/
def saveDoc (hashOf : ChangeSet → String) (cs : List Chunk) (delta : ChangeSet) : List Chunk :=
  if delta.isEmpty then cs
  else compactDoc hashOf (cs ++ [{ name := hashOf delta, kind := .changes, changes := delta }])

/-! ## Schema migration (`migrated` in store.ts) -/

/-- An entry as an older document may hold it: v1 booleans instead of
`status`, no `type`. -/
structure LegacyEntry where
  id : String
  type? : Option SpecType := none
  name : String
  version : Nat
  status? : Option Status := none
  published? : Option Bool := none
  proposed? : Option Bool := none
  body : String
  tests : List String
  link : Option ExternalLink := none
  prs : Option (List PullRequestLink) := none
  deriving DecidableEq, Repr

/-- A feature document as any schema version may hold it. -/
structure LegacyDoc where
  schemaVersion : Nat
  id : String
  name : String
  description : String
  specs? : Option (List LegacyEntry) := none
  scenarios? : Option (List LegacyEntry) := none
  link : Option ExternalLink := none
  prs : Option (List PullRequestLink) := none
  assigned : Option String := none
  deriving DecidableEq, Repr

/-- `legacyStatus`: `entry.published ? "published" : entry.proposed ? "proposed" : "draft"`. -/
def legacyStatus (e : LegacyEntry) : Status :=
  if e.published?.getD false then .published
  else if e.proposed?.getD false then .proposed
  else .draft

/-- An entry moved from the v2 `scenarios` list: status recomputed from the
booleans, type defaulted, link and prs not carried (as in store.ts). -/
def convertScenario (e : LegacyEntry) : LegacyEntry :=
  { id := e.id, type? := some (e.type?.getD .scenario), name := e.name, version := e.version,
    status? := some (legacyStatus e), published? := none, proposed? := none,
    body := e.body, tests := e.tests, link := none, prs := none }

/-- An entry already in `specs`: fill a missing status (dropping the
booleans) and a missing type. -/
def fixSpec (e : LegacyEntry) : LegacyEntry :=
  let e := if e.status?.isNone
    then { e with status? := some (legacyStatus e), published? := none, proposed? := none }
    else e
  if e.type?.isNone then { e with type? := some .scenario } else e

def LegacyDoc.entries (d : LegacyDoc) : List LegacyEntry :=
  d.specs?.getD [] ++ d.scenarios?.getD []

/-- The `stale` test in `migrated`. -/
def LegacyDoc.stale (d : LegacyDoc) : Bool :=
  d.schemaVersion < 3 || d.scenarios?.isSome || d.specs?.isNone ||
  d.entries.any (fun e => e.status?.isNone || e.type?.isNone)

/-- `migrated` in store.ts. -/
def migrated (d : LegacyDoc) : LegacyDoc :=
  if !d.stale then d
  else
    { d with
      schemaVersion := if d.schemaVersion < 3 then 3 else d.schemaVersion,
      specs? := some ((d.specs?.getD []).map fixSpec ++ (d.scenarios?.getD []).map convertScenario),
      scenarios? := none }

end SpecDriven.Sync

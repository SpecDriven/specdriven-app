import SpecDriven.Sync.Git
import SpecDriven.Sync.Merge
import SpecDriven.Sync.Reconcile
import SpecDriven.Sync.Projection

/-!
# Protocol

The sync tick (`src/server/reload.ts` `syncDataDir`) and its two document
passes (`src/server/automerge/driftSync.ts` `autoResolveOne`, `importDrift`)
for one feature on one peer, plus the save-time fold (`src/server/features.ts`
`foldDiskEdit`).

The peer holds, for the feature, the document it loads from its chunk
directory (`doc`) and the markdown on disk (`file`). Markdown is represented
by its parse (Projection.lean); `links` is this peer's "Publish external
links" setting.
-/

namespace SpecDriven.Sync

/-- The markdown file for a feature, as `importDrift` finds it. -/
inductive FileState where
  /-- No file: deleted outside the app. -/
  | absent
  /-- `featureTextError` is not null: skipped, never reaches the document. -/
  | malformed
  | text (f : Feature)
  deriving DecidableEq, Repr

structure PeerFeature where
  doc : Option FeatureDoc
  file : FileState
  deriving DecidableEq, Repr

/-- `EMPTY` in driftSync.ts. -/
def EMPTY : Feature := { name := "", description := "", scenarios := [] }

/-- `autoResolveOne` for a conflicted `.feature.md` that has a document:
the resolved document and the markdown written as the resolution, or why
the path was left to the dialog. -/
def autoResolveOne (seed : Nat) (fresh : Nat → String) (doc : FeatureDoc) (pl : Pulled) :
    Except String (FeatureDoc × Feature) := do
  let some theirs := pl.theirs | throw "deleted on one side"
  let base := pl.base.getD EMPTY
  let doc1 ←
    if pl.lineageRace then
      match pl.ours with
      | some ours =>
        if !isProjectionOf ours doc then do
          let own ← threeWayFeature seed base (docToFeature doc) ours
          let (d, _) ← reconcile fresh doc own
          pure d
        else pure doc
      | none => pure doc
    else pure doc
  let doc2 ←
    if !pl.opsArrived || pl.lineageRace then do
      let merged ← threeWayFeature seed base (docToFeature doc1) theirs
      let (d, _) ← reconcile fresh doc1 merged
      pure d
    else pure doc1
  return (doc2, projectFeature doc2 true)

/-- The `docid` branch of `autoResolveOne`: the loaded document's id wins. -/
def resolveDocid (doc : FeatureDoc) : String := doc.id

/-- `importDrift` for one feature: import, skip, absorb or repair; then the
second loop drops the document of a feature whose file is gone. -/
def importDriftOne (fresh : Nat → String) (docId : String) (links : Bool) (s : PeerFeature) :
    PeerFeature :=
  match s.file with
  | .absent => { doc := none, file := .absent }
  | .malformed => s
  | .text text =>
    match s.doc with
    | none =>
      let d := importFeatureDoc docId fresh (parseFeature text)
      { doc := some d, file := .text (projectFeature d links) }
    | some d =>
      if isProjectionOf text d then s
      else
        let (d', _refused) := absorbDrift fresh d text
        { doc := some d', file := .text (projectFeature d' links) }

/-- What a tick knows about this feature: what the pull delivered (if the
path conflicted) and whether a merge is still in progress once the resolve
pass has run. -/
structure TickInput where
  pulled : Option Pulled
  merging : Bool

/-- The resolve pass of a tick on this feature. -/
def resolvePass (seed : Nat) (fresh : Nat → String) (s : PeerFeature) (inp : TickInput) : PeerFeature :=
  match inp.pulled, s.doc with
  | some pl, some d =>
    if pl.conflicted then
      match autoResolveOne seed fresh d pl with
      | .ok (d', f) => { doc := some d', file := .text f }
      | .error _ => s
    else s
  | _, _ => s

/-- `syncDataDir`, for one feature: pull (given), resolve what the document
can resolve, then — only when no merge is in progress — the drift pass. The
commit-and-push at the end moves bytes, not documents. -/
def tick (seed : Nat) (fresh : Nat → String) (docId : String) (links : Bool)
    (s : PeerFeature) (inp : TickInput) : PeerFeature :=
  let s1 := resolvePass seed fresh s inp
  if inp.merging then s1 else importDriftOne fresh docId links s1

/-- `foldDiskEdit` in features.ts: a save's text, with an unabsorbed disk
edit folded in, left alone, or refused. -/
def foldDiskEdit (seed : Nat) (d : FeatureDoc) (onDisk : FileState) (text : Feature) :
    Except String Feature :=
  match onDisk with
  | .absent => .ok text
  | .malformed => .ok text
  | .text disk =>
    if isProjectionOf disk d then .ok text
    else if !publishedKept d disk then .ok text
    else
      match threeWayFeatureStrict seed (parseFeature (projectFeature d true)) (parseFeature text) disk with
      | .ok merged => .ok (serializeFeature true merged)
      | .error e => .error s!"edited on disk and here at the same time ({e})"

/-- The projection invariant a tick restores for one feature. -/
def Consistent (s : PeerFeature) : Prop :=
  match s.file, s.doc with
  | .text f, some d => isProjectionOf f d = true
  | .text _, none => False
  | .absent, d => d = none
  | .malformed, _ => True

end SpecDriven.Sync

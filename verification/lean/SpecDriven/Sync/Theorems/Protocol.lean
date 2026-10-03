import SpecDriven.Sync.Protocol

/-!
# Theorems: protocol layer (T16–T22)

Anchors: `src/server/reload.ts`, `src/server/automerge/driftSync.ts`,
`src/server/features.ts`.
-/

namespace SpecDriven.Sync

theorem isProjectionOf_self (d : FeatureDoc) (links : Bool) :
    isProjectionOf (projectFeature d links) d = true := by
  cases links <;> simp [isProjectionOf]

/-- **T16 Tick restores the projection invariant.** After the drift pass,
the feature's file is its document's projection (or both are gone). Anchor:
`importDrift`'s four branches each end with the file equal to a projection.
Spec: "markdown edited outside the app". -/
theorem T16_consistent (fresh : Nat → String) (docId : String) (links : Bool) (s : PeerFeature) :
    Consistent (importDriftOne fresh docId links s) := by
  unfold importDriftOne Consistent
  cases hf : s.file with
  | absent => simp
  | malformed => cases s.doc <;> simp_all
  | text text =>
    cases hd : s.doc with
    | none => simp [isProjectionOf_self]
    | some d =>
      by_cases hp : isProjectionOf text d = true
      · simp [hf, hd, hp]
      · simp only [hp, Bool.false_eq_true, ite_false]
        simp [isProjectionOf_self]

/-- **T16 (quiet second tick).** With no new external input, running the
drift pass again changes nothing: no file is written and no chunk saved.
Anchor: `isProjectionOf` short-circuits the absorb. -/
theorem T16_idempotent (fresh : Nat → String) (docId : String) (links : Bool) (s : PeerFeature) :
    importDriftOne fresh docId links (importDriftOne fresh docId links s) =
      importDriftOne fresh docId links s := by
  have h := T16_consistent fresh docId links s
  generalize importDriftOne fresh docId links s = s' at h ⊢
  unfold importDriftOne
  unfold Consistent at h
  cases hf : s'.file with
  | absent =>
    cases hd : s'.doc with
    | none => cases s'; simp_all
    | some d => simp_all
  | malformed => simp
  | text f =>
    cases hd : s'.doc with
    | none => simp_all
    | some d => simp_all

/-- **T17 No absorption during merge.** While a merge is in progress the
drift pass does not run: the tick is the resolve pass alone. Anchor: `if
(!merging)` in `syncDataDir`, `mergeInProgress`. -/
theorem T17_no_drift_while_merging (seed : Nat) (fresh : Nat → String) (docId : String) (links : Bool)
    (s : PeerFeature) (inp : TickInput) (h : inp.merging = true) :
    tick seed fresh docId links s inp = resolvePass seed fresh s inp := by
  simp [tick, h]

/-- **T18 Deletion carries intent.** A feature whose file is gone after the
pull loses its document on the next drift pass, and the file is not
recreated from the stale document. Anchor: `importDrift`'s second loop.
Spec: "A feature file deleted outside the app". -/
theorem T18_deleted (fresh : Nat → String) (docId : String) (links : Bool) (d : Option FeatureDoc) :
    importDriftOne fresh docId links { doc := d, file := .absent } = { doc := none, file := .absent } := by
  simp [importDriftOne]

/-- **T19 Refused drift repairs.** When the absorb is refused, the document is
unchanged and the file is rewritten to the document's projection. Anchor:
`importDrift`'s `refused` branch. Spec: "published scenarios stay
immutable". -/
theorem T19_refused_unchanged (fresh : Nat → String) (d : FeatureDoc) (text : Feature)
    (h : (absorbDrift fresh d text).2 = true) : (absorbDrift fresh d text).1 = d := by
  unfold absorbDrift at *
  split at h <;> simp_all

theorem T19_refused_repairs (fresh : Nat → String) (docId : String) (links : Bool) (d : FeatureDoc)
    (text : Feature) (hp : isProjectionOf text d = false) (h : (absorbDrift fresh d text).2 = true) :
    importDriftOne fresh docId links { doc := some d, file := .text text } =
      { doc := some d, file := .text (projectFeature d links) } := by
  have hu := T19_refused_unchanged fresh d text h
  simp only [importDriftOne, hp, Bool.false_eq_true, ite_false]
  rw [hu]

/-- **T20 Concurrent edits converge without a dialog.** When the other peer's
operations arrived with the pull and no lineage race is on, the conflicted
markdown resolves to the merged document's projection, with the document
untouched: both peers hold the same merged document (T2), so both write the
same bytes. Anchor: `autoResolveOne`, the `opsArrived` branch. Spec: "two
peers edit the same scenario concurrently". -/
theorem T20_ops_arrived (seed : Nat) (fresh : Nat → String) (doc : FeatureDoc) (pl : Pulled)
    (theirs : Feature) (ht : pl.theirs = some theirs) (ho : pl.opsArrived = true)
    (hl : pl.lineageRace = false) :
    autoResolveOne seed fresh doc pl = .ok (doc, projectFeature doc true) := by
  simp [autoResolveOne, ht, ho, hl]; rfl

/-- T20, the convergence step: two peers holding the same merged document
resolve the same conflicted file to the same bytes. -/
theorem T20_same_bytes (seed seed' : Nat) (fresh fresh' : Nat → String) (doc : FeatureDoc)
    (pl pl' : Pulled) (theirs theirs' : Feature)
    (ht : pl.theirs = some theirs) (ho : pl.opsArrived = true) (hl : pl.lineageRace = false)
    (ht' : pl'.theirs = some theirs') (ho' : pl'.opsArrived = true) (hl' : pl'.lineageRace = false) :
    autoResolveOne seed fresh doc pl = autoResolveOne seed' fresh' doc pl' := by
  rw [T20_ops_arrived seed fresh doc pl theirs ht ho hl,
      T20_ops_arrived seed' fresh' doc pl' theirs' ht' ho' hl']

/-- **T21 Lineage race (structure).** On a lineage race the `docid` path
resolves to the loaded document's id, and the feature path folds our own
markdown and then theirs into the document three-way, whatever `opsArrived`
says. Anchor: `autoResolveOne`, `featureFileOfDocidPath`. Spec: "a repo that
predates documents". The survival of every non-conflicting scenario through
the two folds is `Open.T21_survival`. -/
theorem T21_docid (doc : FeatureDoc) : resolveDocid doc = doc.id := rfl

theorem T21_both_folds (seed : Nat) (fresh : Nat → String) (doc : FeatureDoc) (pl : Pulled)
    (theirs ours : Feature) (ht : pl.theirs = some theirs) (hr : pl.lineageRace = true)
    (ho : pl.ours = some ours) (hp : isProjectionOf ours doc = false)
    (own merged : Feature) (d1 d2 : FeatureDoc) (o1 o2 : List Op)
    (h1 : threeWayFeature seed (pl.base.getD EMPTY) (docToFeature doc) ours = .ok own)
    (h2 : reconcile fresh doc own = .ok (d1, o1))
    (h3 : threeWayFeature seed (pl.base.getD EMPTY) (docToFeature d1) theirs = .ok merged)
    (h4 : reconcile fresh d1 merged = .ok (d2, o2)) :
    autoResolveOne seed fresh doc pl = .ok (d2, projectFeature d2 true) := by
  simp [autoResolveOne, ht, hr, ho, hp, h1, bind, Except.bind, pure, Except.pure, h2, h3, h4, Functor.map, Except.map]

/-- **T22 Disk edits are never dropped silently.** A save over an unabsorbed
disk edit either folds the edit in, fails loudly with the strict-merge
conflict (leaving the disk edit on disk), or leaves the text alone because
the disk edit tampers with a published scenario — which the next drift pass
refuses and repairs (T19). Anchor: `foldDiskEdit`. -/
theorem T22_trichotomy (seed : Nat) (d : FeatureDoc) (disk : Feature) (text : Feature) :
    (isProjectionOf disk d = true ∧ foldDiskEdit seed d (.text disk) text = .ok text) ∨
    (publishedKept d disk = false ∧ foldDiskEdit seed d (.text disk) text = .ok text) ∨
    (∃ merged, threeWayFeatureStrict seed (parseFeature (projectFeature d true)) (parseFeature text) disk = .ok merged ∧
      foldDiskEdit seed d (.text disk) text = .ok (serializeFeature true merged)) ∨
    (∃ e, threeWayFeatureStrict seed (parseFeature (projectFeature d true)) (parseFeature text) disk = .error e ∧
      ∃ e', foldDiskEdit seed d (.text disk) text = .error e') := by
  unfold foldDiskEdit
  by_cases hp : isProjectionOf disk d = true
  · left; simp [hp]
  · by_cases hk : publishedKept d disk = true
    · simp only [hp, Bool.false_eq_true, ite_false, hk, Bool.not_true, ite_false]
      right; right
      split
      · rename_i merged hm; left; exact ⟨merged, hm, rfl⟩
      · rename_i e he; right; exact ⟨e, he, _, rfl⟩
    · right; left
      simp only [Bool.not_eq_true] at hp hk
      simp [hp, hk]

end SpecDriven.Sync

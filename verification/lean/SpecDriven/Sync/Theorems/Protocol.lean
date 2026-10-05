import SpecDriven.Sync.Protocol
import SpecDriven.Sync.Theorems.Reconcile

/-!
# Theorems: protocol layer (T16–T22)

Anchors: `src/server/reload.ts`, `src/server/automerge/driftSync.ts`,
`src/server/features.ts`.
-/

namespace SpecDriven.Sync

theorem isProjectionOf_self (d : FeatureDoc) (links : Bool) :
    isProjectionOf (projectFeature d links) d = true := by
  cases links <;> simp [isProjectionOf]

/-! ## The heal

`healPublished` moves only the live `body` of published entries that carry a
recorded body, and the projection reads the recorded body of exactly those
entries, so the heal is invisible to every projection and idempotent. -/

theorem healEntry_idem (e : SpecEntry) : healEntry (healEntry e) = healEntry e := by
  cases hs : e.status <;> cases hb : e.publishedBody <;> simp [healEntry, hs, hb]

theorem healPublished_idem (d : FeatureDoc) : healPublished (healPublished d) = healPublished d := by
  simp [healPublished, List.map_map, Function.comp_def, healEntry_idem]

theorem entryToScenario_heal (e : SpecEntry) : entryToScenario (healEntry e) = entryToScenario e := by
  cases hs : e.status <;> cases hb : e.publishedBody <;>
    simp [healEntry, entryToScenario, SpecEntry.effectiveBody, hs, hb]

theorem docToFeature_heal (d : FeatureDoc) : docToFeature (healPublished d) = docToFeature d := by
  simp [docToFeature, healPublished, List.map_map, Function.comp_def, entryToScenario_heal]

theorem projectFeature_heal (d : FeatureDoc) (links : Bool) :
    projectFeature (healPublished d) links = projectFeature d links := by
  simp [projectFeature, docToFeature_heal]

theorem isProjectionOf_heal (text : Feature) (d : FeatureDoc) :
    isProjectionOf text (healPublished d) = isProjectionOf text d := by
  simp [isProjectionOf, projectFeature_heal]

/-- A document the heal leaves alone: every published entry's live body is
its recorded one. Every document the drift pass writes is one (below), so a
second pass heals nothing. -/
def Healed (d : FeatureDoc) : Prop := healPublished d = d

theorem healPublished_healed (d : FeatureDoc) : Healed (healPublished d) := healPublished_idem d

theorem healed_of_entries (d : FeatureDoc) (h : ∀ e ∈ d.specs, healEntry e = e) : Healed d := by
  show { d with specs := d.specs.map healEntry } = d
  rw [List.map_congr_left h]
  simp

theorem healEntry_eq_self (e : SpecEntry)
    (h : ∀ b, e.status = .published → e.publishedBody = some b → e.body = b) : healEntry e = e := by
  unfold healEntry
  split
  · rename_i b hs hb
    have := h b hs hb
    subst this
    rfl
  · rfl

theorem healEntry_draft (e : SpecEntry) (h : e.status = .draft) : healEntry e = e := by
  simp [healEntry, h]

theorem newEntry_healed (id : String) (s : Scenario) : healEntry (newEntry id s) = newEntry id s := by
  cases hs : s.status <;> simp [healEntry, newEntry, hs]

theorem updateEntry_healed (p : Plan) (i : Nat) (e : SpecEntry) (m : Scenario) (h : p.at? i = some m) :
    healEntry (updateEntry p i e).1 = (updateEntry p i e).1 := by
  rw [updateEntry_some p i e m h]
  cases m.status <;> simp [healEntry]

theorem Plan.at?_some_of_has (p : Plan) (i : Nat) (h : p.has i = true) : ∃ m, p.at? i = some m := by
  obtain ⟨s, hs⟩ := (Plan.has_iff p i).mp h
  cases hat : p.at? i with
  | some m => exact ⟨m, rfl⟩
  | none =>
    simp only [Plan.at?, Option.map_eq_none_iff, List.find?_eq_none] at hat
    have := hat (i, s) hs
    simp at this

/-- Every entry `applyPlan` keeps or adds is healed: a claimed entry takes the
target's body and records it when published, an unclaimed draft has nothing
to heal, an added entry is minted recorded. -/
theorem applyPlan_healed (fresh : Nat → String) (d : FeatureDoc) (target : Feature) (p : Plan) :
    Healed (applyPlan fresh d target p).1 := by
  apply healed_of_entries
  intro e he
  simp only [applyPlan, List.mem_append] at he
  rcases he with hk | ha
  · rw [mem_keptSpecs] at hk
    obtain ⟨i, e0, _, rfl, hcond⟩ := hk
    cases hat : p.at? i with
    | some m => exact updateEntry_healed p i e0 m hat
    | none =>
      rw [updateEntry_none p i e0 hat] at hcond ⊢
      simp only [Bool.or_eq_true, beq_iff_eq] at hcond
      rcases hcond with hhas | hdraft
      · obtain ⟨m, hm⟩ := Plan.at?_some_of_has p i hhas
        rw [hat] at hm; cases hm
      · exact healEntry_draft e0 hdraft
  · simp only [addedSpecs, List.mem_map] at ha
    obtain ⟨⟨_, s⟩, _, rfl⟩ := ha
    exact newEntry_healed _ _

theorem absorbDrift_healed (fresh : Nat → String) (d : FeatureDoc) (text : Feature) (hd : Healed d) :
    Healed (absorbDrift fresh d text).1 := by
  unfold absorbDrift
  split
  · rename_i d' ops hr
    obtain ⟨_, hd'⟩ := reconcile_ok fresh d (parseFeature text) none d' ops hr
    rw [hd']; exact applyPlan_healed _ _ _ _
  · exact hd

theorem importFeatureDoc_healed (docId : String) (fresh : Nat → String) (f : Feature) :
    Healed (importFeatureDoc docId fresh f) := by
  apply healed_of_entries
  intro e he
  simp only [importFeatureDoc, List.mem_map] at he
  obtain ⟨⟨_, s⟩, _, rfl⟩ := he
  exact newEntry_healed _ _

/-- Whatever document the drift pass leaves beside a file is healed (a
malformed file is skipped whole, document included). -/
theorem importDriftOne_healed (fresh : Nat → String) (docId : String) (links : Bool) (s : PeerFeature)
    (d : FeatureDoc) (f : Feature)
    (h : importDriftOne fresh docId links s = { doc := some d, file := .text f }) : Healed d := by
  unfold importDriftOne at h
  cases hf : s.file with
  | absent => simp [hf] at h
  | malformed => simp only [hf] at h; rw [h] at hf; cases hf
  | text text =>
    simp only [hf] at h
    cases hd : s.doc with
    | none =>
      simp only [hd, PeerFeature.mk.injEq, Option.some.injEq] at h
      rw [← h.1]; exact importFeatureDoc_healed _ _ _
    | some d0 =>
      simp only [hd] at h
      split at h
      · simp only [PeerFeature.mk.injEq, Option.some.injEq] at h
        rw [← h.1]; exact healPublished_healed d0
      · simp only [PeerFeature.mk.injEq, Option.some.injEq] at h
        rw [← h.1]; exact absorbDrift_healed _ _ _ (healPublished_healed d0)

/-- **T16 Tick restores the projection invariant.** After the drift pass,
the feature's file is its document's projection (or both are gone). Anchor:
`importDrift`'s branches each end with the file equal to a projection — the
heal first, which no projection sees (`isProjectionOf_heal`). Spec: "markdown
edited outside the app". -/
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
      by_cases hp : isProjectionOf text (healPublished d) = true
      · simp [hp]
      · simp only [hp, Bool.false_eq_true, ite_false]
        simp [isProjectionOf_self]

/-- **T16 (quiet second tick).** With no new external input, running the
drift pass again changes nothing: no file is written and no chunk saved.
Anchor: `isProjectionOf` short-circuits the absorb, and the document the
first pass left has nothing to heal (`importDriftOne_healed`). -/
theorem T16_idempotent (fresh : Nat → String) (docId : String) (links : Bool) (s : PeerFeature) :
    importDriftOne fresh docId links (importDriftOne fresh docId links s) =
      importDriftOne fresh docId links s := by
  have h := T16_consistent fresh docId links s
  have hh := fun d f => importDriftOne_healed fresh docId links s d f
  generalize importDriftOne fresh docId links s = s' at h hh ⊢
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
    | some d =>
      have hs' : s' = { doc := some d, file := .text f } := by cases s'; simp_all
      have hdh : healPublished d = d := hh d f hs'
      simp only [hf, hd] at h
      simp [hdh, h, hs']

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
unchanged (beyond the heal that precedes every absorb) and the file is
rewritten to the document's projection — the recorded published bodies,
which the heal does not change (`projectFeature_heal`). Anchor:
`importDrift`'s `refused` branch. Spec: "published scenarios stay
immutable". -/
theorem T19_refused_unchanged (fresh : Nat → String) (d : FeatureDoc) (text : Feature)
    (h : (absorbDrift fresh d text).2 = true) : (absorbDrift fresh d text).1 = d := by
  unfold absorbDrift at *
  split at h <;> simp_all

theorem T19_refused_repairs (fresh : Nat → String) (docId : String) (links : Bool) (d : FeatureDoc)
    (text : Feature) (hp : isProjectionOf text d = false)
    (h : (absorbDrift fresh (healPublished d) text).2 = true) :
    importDriftOne fresh docId links { doc := some d, file := .text text } =
      { doc := some (healPublished d), file := .text (projectFeature d links) } := by
  have hu := T19_refused_unchanged fresh (healPublished d) text h
  simp only [importDriftOne, isProjectionOf_heal, hp, Bool.false_eq_true, ite_false]
  rw [hu, projectFeature_heal]

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

import SpecDriven.Sync.Theorems.Protocol
import SpecDriven.Sync.Theorems.Reconcile
import SpecDriven.Sync.Theorems.Store

/-!
# Hypotheses H1–H5

Each hypothesis of `docs/lean-sync-verification-prompt.md` as the model sees
it. H1 was a confirmed defect until the ops-arrived resolution started
folding in what their markdown holds beyond their own document
(`Pulled.theirDoc`); the published case of H2 was one until publishing
started recording the body (`SpecEntry.publishedBody`), and is now a heal.
Both traces run against the implementation in
`tests/automerge/leanHypotheses.test.ts`.
-/

namespace SpecDriven.Sync

/-! ## H1 Mixed-origin conflict — fixed by folding against their document -/

/-- **H1 (fixed).** When operations arrived with the pull and their markdown
is not their own document's projection — a hand edit rode the push — the
resolution folds it in: three-way against their document's projection, so
that only the hand edit is theirs to merge and nothing the merged document
already holds replays. It used to re-project the merged document whatever
arrived, dropping the edit on every peer. Anchor: `autoResolveOne`,
`opsArrived`, `theirDoc`. -/
theorem H1_hand_edit_folded (seed : Nat) (fresh : Nat → String) (doc : FeatureDoc) (pl : Pulled)
    (theirs : Feature) (td : FeatureDoc) (ht : pl.theirs = some theirs) (ho : pl.opsArrived = true)
    (hl : pl.lineageRace = false) (htd : pl.theirDoc = some td) (hp : isProjectionOf theirs td = false)
    (merged : Feature) (d : FeatureDoc) (ops : List Op)
    (h1 : threeWayFeature seed (projectFeature td (linked theirs)) (docToFeature doc) theirs = .ok merged)
    (h2 : reconcile fresh doc merged = .ok (d, ops)) :
    autoResolveOne seed fresh doc pl = .ok (d, projectFeature d true) := by
  simp [autoResolveOne, ht, ho, hl, htd, hp, h1, h2, bind, Except.bind, pure, Except.pure]

/-- **H1 (residual).** When their document cannot be rebuilt — our side
compacted one of its chunks away — the resolution cannot tell a hand edit
apart and does not depend on the markdown that arrived, as before the fix;
`driftSync.ts` logs a warning. Anchor: `autoResolveOne`, `theirDoc` `none`. -/
theorem H1_unrebuilt_ignores_theirs (seed : Nat) (fresh : Nat → String) (doc : FeatureDoc)
    (pl : Pulled) (theirs theirs' : Feature) (ho : pl.opsArrived = true) (hl : pl.lineageRace = false)
    (htd : pl.theirDoc = none) :
    autoResolveOne seed fresh doc { pl with theirs := some theirs } =
      autoResolveOne seed fresh doc { pl with theirs := some theirs' } := by
  have hn : ∀ f : Feature, NoHandEdit { pl with theirs := some f } f := by
    intro f t h; simp [htd] at h
  rw [T20_ops_arrived seed fresh doc { pl with theirs := some theirs } theirs rfl ho hl (hn theirs),
      T20_ops_arrived seed fresh doc { pl with theirs := some theirs' } theirs' rfl ho hl (hn theirs')]

/-- **H1 (why the residual sticks).** A resolution that leaves the file equal
to the document's projection gives the drift pass of this and every later
tick nothing to absorb (it only heals the document's published bodies, which
the file never sees). -/
theorem H1_never_absorbed (fresh : Nat → String) (docId : String) (doc : FeatureDoc) :
    importDriftOne fresh docId true { doc := some doc, file := .text (projectFeature doc true) } =
      { doc := some (healPublished doc), file := .text (projectFeature doc true) } := by
  simp [importDriftOne, isProjectionOf_heal, isProjectionOf_self]

/-! ## H2 Concurrent absorb duplicates text — heals, published or not -/

/-- **H2 (the duplication).** Two peers absorbing the same longer text into
the same field on two forks leave the merged field longer than that text, so
the merged document is not a projection of the (identical) file. Anchor:
`reconcile`'s `A.updateText`; axiom `Text.concurrent_update_grows`. -/
theorem H2_doubled (t : Text) (a a' : Nat) (s : String) (hne : a ≠ a') (hgrow : t.view.length < s.length) :
    ((t.update a s).merge (t.update a' s)).view ≠ s := by
  intro h
  have := Text.concurrent_update_grows t a a' s hne hgrow
  rw [h] at this
  omega

/-- **H2 (self-heal, unpublished).** The next drift pass reconciles the
doubled document against the file: an entry whose key the file still carries
is claimed by the key pass and takes the file's body and status back, keeping
its id. Anchor: `absorbDrift`, the key `claim` pass. -/
theorem H2_heals (fresh : Nat → String) (d : FeatureDoc) (target : Feature)
    (hE : EntryKeysUnique d.specs) (hT : KeysUnique target.scenarios)
    (hkept : publishedKept d target = true)
    (i : Nat) (e : SpecEntry) (hi : d.specs[i]? = some e) (s : Scenario) (hs : s ∈ target.scenarios)
    (hkey : s.name = e.name ∧ s.version = e.version) :
    ∃ d' ops, reconcile fresh d target = .ok (d', ops) ∧
      ∃ e' ∈ d'.specs, e'.id = e.id ∧ e'.body = s.body ∧ e'.status = s.status := by
  refine ⟨(applyPlan fresh d target (plan d.specs target none)).1,
    (applyPlan fresh d target (plan d.specs target none)).2, by simp [reconcile, hkept], ?_⟩
  have h0 : (idClaim d.specs target none {}).at? i = some s ∨
      (Plan.Inv d.specs target (idClaim d.specs target none {}) ∧
        (idClaim d.specs target none {}).has i = false ∧
        (idClaim d.specs target none {}).isMatched s = false) :=
    Or.inr ⟨idClaim_inv _ _ _, rfl, rfl⟩
  have hkp := keyPass_claims d.specs target hE hT i e s hi hs hkey _ h0
  obtain ⟨r, hr⟩ := claimPass_grows d.specs target (fun s e => s.body == e.effectiveBody)
    (claimPass d.specs target keyCand (idClaim d.specs target none {}))
  have hfinal : (plan d.specs target none).at? i = some s := by
    rw [plan_eq]; exact Plan.at?_of_grows _ _ r hr i s hkp
  exact ⟨_, T11_claimed_keeps_id fresh d target _ i e s hi hfinal, rfl, rfl, rfl⟩

/-- **H2 (name and description always heal).** The feature name and
description have no gate: `reconcile` always moves them to the file's. -/
theorem H2_name_description_heal (fresh : Nat → String) (d : FeatureDoc) (target : Feature)
    (d' : FeatureDoc) (ops : List Op) (hr : reconcile fresh d target = .ok (d', ops)) :
    d'.name = target.name ∧ d'.description = target.description := by
  obtain ⟨_, hd'⟩ := reconcile_ok fresh d target none d' ops hr
  subst hd'
  exact ⟨rfl, rfl⟩

/-- **H2 (what the gate still refuses).** A file whose scenario carries a
published entry's key, but not the body that entry was published with
(`effectiveBody`), fails the gate: genuine tampering is refused as before.
Before the recorded body existed this compared the live text, and the merge
artifact of two concurrent absorbs failed it too — the confirmed defect. -/
theorem H2_tamper_refused (d : FeatureDoc) (target : Feature) (hT : KeysUnique target.scenarios)
    (e : SpecEntry) (he : e ∈ d.specs) (hpub : e.status = .published)
    (s : Scenario) (hs : s ∈ target.scenarios) (hkey : s.name = e.name ∧ s.version = e.version)
    (hbody : s.body ≠ e.effectiveBody) : publishedKept d target = false := by
  apply Bool.eq_false_iff.mpr
  intro hk
  simp only [publishedKept, List.all_eq_true] at hk
  have hg := hk e he
  simp only [hpub, bne_self_eq_false, Bool.false_or] at hg
  split at hg
  · rename_i s' hs'
    have hsp := List.find?_some hs'
    simp only [samePickS, Bool.and_eq_true, beq_iff_eq] at hsp
    have : s' = s := hT s' (List.mem_of_find?_eq_some hs') s hs (by
      show (s'.name, s'.version) = (s.name, s.version)
      rw [hsp.1, hsp.2, hkey.1, hkey.2])
    subst this
    simp only [Bool.and_eq_true, beq_iff_eq] at hg
    exact hbody hg.2
  · cases hg

/-- **H2 (fixed: the gate reads the recorded body).** A published entry that
recorded `b` when it was published passes the gate against a file carrying
`b` under its key whatever its live `body` reads — doubled by a merge or
not. Stated on the entry alone. -/
theorem H2_publish_gate_passes (d : FeatureDoc) (target : Feature) (e : SpecEntry)
    (hpub : e.status = .published) (b : String) (hsnap : e.publishedBody = some b)
    (s : Scenario) (hs : target.scenarios.find? (fun s' => samePickS s' ⟨e.name, e.version⟩) = some s)
    (hsp : s.status = .published) (hsb : s.body = b) :
    publishedKept { d with specs := [e] } target = true := by
  simp [publishedKept, hpub, hs, hsp, hsb, SpecEntry.effectiveBody, hsnap]

/-- **H2 (fixed: the absorb heals a published entry too).** With the gate
passed, a published entry whose live body drifted from its recorded `b` is
claimed under its key and takes `b` back, still published and still
recording `b`. A corollary of `H2_heals`, now that publishing no longer
blocks it: the recorded body enters only through the gate
(`H2_publish_gate_passes`), not the proof. -/
theorem H2_publish_heals (fresh : Nat → String) (d : FeatureDoc) (target : Feature)
    (hE : EntryKeysUnique d.specs) (hT : KeysUnique target.scenarios)
    (hkept : publishedKept d target = true)
    (i : Nat) (e : SpecEntry) (hi : d.specs[i]? = some e) (b : String) (_hsnap : e.publishedBody = some b)
    (s : Scenario) (hs : s ∈ target.scenarios)
    (hkey : s.name = e.name ∧ s.version = e.version) (hsp : s.status = .published) (hsb : s.body = b) :
    ∃ d' ops, reconcile fresh d target = .ok (d', ops) ∧
      ∃ e' ∈ d'.specs, e'.id = e.id ∧ e'.body = b ∧ e'.status = .published ∧ e'.publishedBody = some b := by
  refine ⟨(applyPlan fresh d target (plan d.specs target none)).1,
    (applyPlan fresh d target (plan d.specs target none)).2, by simp [reconcile, hkept], ?_⟩
  have h0 : (idClaim d.specs target none {}).at? i = some s ∨
      (Plan.Inv d.specs target (idClaim d.specs target none {}) ∧
        (idClaim d.specs target none {}).has i = false ∧
        (idClaim d.specs target none {}).isMatched s = false) :=
    Or.inr ⟨idClaim_inv _ _ _, rfl, rfl⟩
  have hkp := keyPass_claims d.specs target hE hT i e s hi hs hkey _ h0
  obtain ⟨r, hr⟩ := claimPass_grows d.specs target (fun s e => s.body == e.effectiveBody)
    (claimPass d.specs target keyCand (idClaim d.specs target none {}))
  have hfinal : (plan d.specs target none).at? i = some s := by
    rw [plan_eq]; exact Plan.at?_of_grows _ _ r hr i s hkp
  refine ⟨_, T11_claimed_keeps_id fresh d target _ i e s hi hfinal, rfl, hsb, hsp, ?_⟩
  simp [hsp, hsb]

/-- **H2 (fixed: the tick heals it).** The trace of REPORT.md §2 after step 5:
peer B's document holds the published entry with its recorded body `b` and
a live body a merge left different, and its file — peer A's, pushed with
the publish — is the document's projection, because the projection renders
`b`. The drift pass then heals the document's live body to `b` and leaves the
file alone; nothing is refused, nothing is repaired, and what is saved is the
heal. -/
theorem H2_publish_heals_on_tick (fresh : Nat → String) (docId : String) (links : Bool) (d : FeatureDoc)
    (i : Nat) (e : SpecEntry) (hi : d.specs[i]? = some e) (hpub : e.status = .published)
    (b : String) (hsnap : e.publishedBody = some b) :
    importDriftOne fresh docId links { doc := some d, file := .text (projectFeature d links) } =
      { doc := some (healPublished d), file := .text (projectFeature d links) } ∧
    (healPublished d).specs[i]? = some { e with body := b } := by
  constructor
  · simp [importDriftOne, isProjectionOf_heal, isProjectionOf_self]
  · simp [healPublished, List.getElem?_map, hi, healEntry, hpub, hsnap]

/-! ## H3 Nondeterministic `mergeText` — converges on the next pull -/

/-- **H3 (refuted as a divergence).** Two peers whose three-way resolutions
differ in bytes each pushed operations with the resolution. The next pull on
either side brings the other's operations, and each side's markdown is its
own document's projection (`NoHandEdit`), so the ops-arrived branch
re-projects the merged document on both: byte-identical, whatever `mergeText`
chose on each side (`seed`) and whatever each side's own bytes were. Two
further pulls, one per peer, converge them. Caveat (REPORT.md): the merged
document is the CRDT merge of two different `updateText` splices, so the
converged text can hold a fragment twice — H2's duplication, healed by the
drift pass when nothing is published. -/
theorem H3_second_pull_converges (seed seed' : Nat) (fresh fresh' : Nat → String) (doc : FeatureDoc)
    (pl pl' : Pulled) (theirs theirs' : Feature)
    (ht : pl.theirs = some theirs) (ho : pl.opsArrived = true) (hl : pl.lineageRace = false)
    (hn : NoHandEdit pl theirs)
    (ht' : pl'.theirs = some theirs') (ho' : pl'.opsArrived = true) (hl' : pl'.lineageRace = false)
    (hn' : NoHandEdit pl' theirs') :
    autoResolveOne seed fresh doc pl = autoResolveOne seed' fresh' doc pl' :=
  T20_same_bytes seed seed' fresh fresh' doc pl pl' theirs theirs' ht ho hl hn ht' ho' hl' hn'

/-! ## H4 Same-body claim mis-match — confirmed for markdown-only edits -/

def H4_e1 : SpecEntry :=
  { id := "e1", type := .scenario, name := "a", version := 1, status := .proposed, body := "",
    tests := [], link := none, prs := none }
def H4_e2 : SpecEntry := { H4_e1 with id := "e2", name := "b" }
def H4_c : Scenario :=
  { name := "c", version := 1, status := .proposed, body := "", tests := [], id := none,
    link := none, prs := none }
def H4_target : Feature :=
  { name := "F", description := "", scenarios := [H4_c], link := none, prs := none, assigned := none }

/-- **H4 (confirmed for markdown-only edits).** Two empty-bodied entries `a`
and `b`; the markdown now holds only `c`. Whether `a` or `b` was renamed is
not in the markdown, and the body pass attaches `c` to the first unclaimed
entry: `a`'s identity (and `prs`) continues as `c`, `b`'s is removed. -/
theorem H4_markdown_picks_first : (plan [H4_e1, H4_e2] H4_target none).matchAt = [(0, H4_c)] := by
  decide

/-- **H4 (the editor's path is right).** With the editor's hint naming `b`,
the id claim attaches `c` to `b` (T14). Only external edits are exposed. -/
theorem H4_hint_picks_named :
    (plan [H4_e1, H4_e2] H4_target (some { name := "c", version := 1, id := some "e2" })).matchAt =
      [(1, H4_c)] := by
  decide

/-! ## H5 Compaction versus a lagging peer — safe -/

/-- **H5 (refuted).** A chunk built on an older head, arriving after this
peer compacted, loads to the same document as it would have before the
compaction, and a dependency-closed union stays closed. Anchor: `compactDoc`
keeps the `applied` set; `loadDoc`'s pending changes. -/
theorem H5_no_change_lost (hashOf : ChangeSet → String) (cs : List Chunk) (c : Chunk) :
    view (loadChunks (compactDoc hashOf cs ++ [c])) = view (loadChunks (cs ++ [c])) :=
  view_equiv _ _ (T3_compact_concurrent hashOf cs c)

theorem H5_closed (hashOf : ChangeSet → String) (cs : List Chunk) (c : Chunk)
    (h : (loadChunks (cs ++ [c])).closed) : (loadChunks (compactDoc hashOf cs ++ [c])).closed :=
  T3_compact_closed hashOf cs c h

end SpecDriven.Sync

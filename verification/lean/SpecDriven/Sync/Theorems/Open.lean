import SpecDriven.Sync.Theorems.Reconcile
import SpecDriven.Sync.Theorems.Protocol

/-!
# Open

Theorems stated but not proved. Each carries the lemma that blocks it. This
is the only file in which `sorry` is allowed.
-/

namespace SpecDriven.Sync

/-- **T12 Reconcile reaches the target (open).** For a target with unique
keys and no drafts, over a document with unique entry keys that passes the
gate, the result projects to the normalized target. Blocked on: (a) the key
pass claims *every* non-draft entry whose key the target carries
(`keyPass_claims` gives it per entry; the per-entry statements must be
combined with "every unclaimed target scenario is added" and "every unclaimed
non-draft entry is removed"), and (b) `sortScenarios` of the kept-then-added
entries equals `sortScenarios target` — a permutation argument over
`List.mergeSort` that core Lean (no Mathlib) gives little support for. -/
theorem T12_reaches_target (fresh : Nat → String) (d : FeatureDoc) (target : Feature)
    (hE : EntryKeysUnique d.specs) (hT : KeysUnique target.scenarios)
    (hnd : ∀ s ∈ target.scenarios, s.status ≠ .draft)
    (hkept : publishedKept d target = true)
    (d' : FeatureDoc) (ops : List Op) (hr : reconcile fresh d target = .ok (d', ops)) :
    projectFeature d' true = serializeFeature true (parseFeature target) := by
  sorry

/-- Every published entry records its body (`SpecEntry.publishedBody`). An
entry published before the key existed is stamped by its first reconcile —
one `entrySetPublishedBody` op, once — so the fixpoint below holds only of
documents already stamped. Every entry `reconcile` writes is (see
`updateEntry`, `newEntry`). -/
def Stamped (d : FeatureDoc) : Prop :=
  ∀ e ∈ d.specs, e.status = .published → e.publishedBody = some e.body

/-- **T13 Projection fixpoint (open).** Reconciling a stamped document with
the parse of its own projection issues no operation. Blocked on the same
key-pass closure as T12: after the key pass every non-draft entry is claimed
by its own scenario (`entryToScenario e`, for which `updateEntry` issues `[]`
— the entry being stamped and healed, its recorded body is its body),
every target scenario is matched (so the body pass is the identity and
`addedSpecs` is empty), and no unclaimed entry is a non-draft (so
`deletedIdx` is empty). Each piece is a fold invariant in the style of
`keyPass_fold`; the time ran out before combining them. The differential test
(`tests/automerge/leanModel.test.ts`) exercises this fixpoint on every vector
whose target is the document's own projection, with no mismatch. -/
theorem T13_fixpoint (fresh : Nat → String) (d : FeatureDoc) (hE : EntryKeysUnique d.specs)
    (_hS : Stamped d) :
    ∃ d', reconcile fresh d (parseFeature (projectFeature d true)) = .ok (d', []) := by
  sorry

/-- **T21 Lineage race survival (open).** Under the hypotheses of
`T21_both_folds`, with unique keys throughout, every scenario added on
either side (its key absent from `base`) has an entry with its key in the
resolved document. Blocked on a merge-layer lemma — `threeWayFeature` keeps
every key present on one side and absent from the base (`mergeKeys` over
`keyUnion`) — and on "reconcile adds every unclaimed target key"
(`addedSpecs`), both unattempted. -/
theorem T21_survival (seed : Nat) (fresh : Nat → String) (doc : FeatureDoc) (pl : Pulled)
    (theirs ours : Feature) (ht : pl.theirs = some theirs) (hr : pl.lineageRace = true)
    (ho : pl.ours = some ours) (hp : isProjectionOf ours doc = false)
    (own merged : Feature) (d1 d2 : FeatureDoc) (o1 o2 : List Op)
    (h1 : threeWayFeature seed (pl.base.getD EMPTY) (docToFeature doc) ours = .ok own)
    (h2 : reconcile fresh doc own = .ok (d1, o1))
    (h3 : threeWayFeature seed (pl.base.getD EMPTY) (docToFeature d1) theirs = .ok merged)
    (h4 : reconcile fresh d1 merged = .ok (d2, o2))
    (s : Scenario) (hs : s ∈ ours.scenarios ∨ s ∈ theirs.scenarios)
    (hnew : ∀ b ∈ (pl.base.getD EMPTY).scenarios, b.key ≠ s.key) :
    ∃ e ∈ d2.specs, e.name = s.name ∧ e.version = s.version := by
  sorry

end SpecDriven.Sync

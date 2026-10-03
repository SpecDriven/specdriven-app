import SpecDriven.Sync.Merge

/-!
# Theorems: merge layer (T6–T9)

Anchors: `src/server/automerge/merge.ts`.
-/

namespace SpecDriven.Sync

/-- **T6 Status latch.** `mergeScenario` yields a status at least as far along
as either input, and equal to one of them. Anchor: `STATUS_RANK`,
`mergeScenario`. Spec: "draft scenarios live in the document only", last
sentence ("Concurrent status changes merge as a one-way latch"). -/
theorem Status.rank_inj {a b : Status} (h : a.rank = b.rank) : a = b := by
  cases a <;> cases b <;> simp_all [Status.rank]

theorem T6_status_latch (seed : Nat) (b : Option Scenario) (o t : Scenario) :
    ((mergeScenario seed b o t).status = o.status ∨ (mergeScenario seed b o t).status = t.status) ∧
    o.status.rank ≤ (mergeScenario seed b o t).status.rank ∧
    t.status.rank ≤ (mergeScenario seed b o t).status.rank := by
  unfold mergeScenario
  simp only
  split
  · exact ⟨Or.inl rfl, Nat.le_refl _, by omega⟩
  · exact ⟨Or.inr rfl, by omega, Nat.le_refl _⟩

/-- T6, corollary: the latch never demotes a published scenario. -/
theorem T6_published_sticks (seed : Nat) (b : Option Scenario) (o t : Scenario)
    (h : o.status = .published ∨ t.status = .published) :
    (mergeScenario seed b o t).status = .published := by
  have ⟨_, ho, ht⟩ := T6_status_latch seed b o t
  rcases h with h | h
  · rw [h] at ho
    revert ho; cases (mergeScenario seed b o t).status <;> simp [Status.rank]
  · rw [h] at ht
    revert ht; cases (mergeScenario seed b o t).status <;> simp [Status.rank]

/-- **T7 (per key) Three-way identity, theirs = base.** When the other side
changed nothing, the merge of one key is our scenario (normalised: the
document-only `id`/`prs` handles are dropped), provided our status is not
behind the base's — the latch (T6) would keep the base's status otherwise.
Anchor: `mergeScenario`, `threeWayFeature`. -/
theorem T7_theirs_is_base (seed : Nat) (b o : List (String × Nat × Scenario)) (k : String × Nat)
    (mine : Scenario) (hm : lookupKey o k = some mine)
    (hrank : ∀ was, lookupKey b k = some was → was.status.rank ≤ mine.status.rank) :
    mergeKey seed b o b k = .ok (some { mine with id := none, prs := none }) ∨
    (lookupKey b k = none ∧ mergeKey seed b o b k = .ok (some mine)) := by
  unfold mergeKey
  rw [hm]
  cases hb : lookupKey b k with
  | none => right; simp
  | some was =>
    left
    have hr := hrank was hb
    simp [mergeScenario, mergeText, mergeLink, linkKey]
    intro h; omega

/-- **T7 (per key) Three-way identity, ours = base.** Symmetric: the merge of
one key is their scenario (normalised), under the same latch proviso, and
their name and version agree with ours because the two share the key. -/
theorem T7_ours_is_base (seed : Nat) (b t : List (String × Nat × Scenario)) (k : String × Nat)
    (yours : Scenario) (ht : lookupKey t k = some yours)
    (hrank : ∀ was, lookupKey b k = some was → was.status.rank ≤ yours.status.rank)
    (hkey : ∀ was, lookupKey b k = some was → was.name = yours.name ∧ was.version = yours.version) :
    mergeKey seed b b t k = .ok (some { yours with id := none, prs := none }) ∨
    (lookupKey b k = none ∧ mergeKey seed b b t k = .ok (some yours)) := by
  unfold mergeKey
  rw [ht]
  cases hb : lookupKey b k with
  | none => right; simp
  | some was =>
    left
    have hr := hrank was hb
    have ⟨hn, hv⟩ := hkey was hb
    simp [mergeScenario, mergeText, mergeLink, linkKey, hn, hv]
    refine ⟨fun h => ?_, fun h => h.symm, fun h => h.symm, fun h => h.symm⟩
    exact Status.rank_inj (by omega)

/-- **T7 (conflict characterisation).** A key conflicts exactly when one side
dropped a scenario the base had and the other side changed it. Anchor:
`threeWayFeature`, the two `return { ok: false, … }` branches. -/
theorem T7_conflict_iff (seed : Nat) (b o t : List (String × Nat × Scenario)) (k : String × Nat) :
    (∃ e, mergeKey seed b o t k = .error e) ↔
      (∃ mine was, lookupKey o k = some mine ∧ lookupKey t k = none ∧ lookupKey b k = some was ∧
        sameContent mine was = false) ∨
      (∃ yours was, lookupKey t k = some yours ∧ lookupKey o k = none ∧ lookupKey b k = some was ∧
        sameContent yours was = false) := by
  unfold mergeKey
  constructor
  · intro ⟨e, he⟩
    cases ho : lookupKey o k <;> cases ht : lookupKey t k <;> simp_all
    · cases hb : lookupKey b k <;> simp_all
      split at he <;> simp_all
    · cases hb : lookupKey b k <;> simp_all
      split at he <;> simp_all
  · rintro (⟨mine, was, ho, ht, hb, hs⟩ | ⟨yours, was, ht, ho, hb, hs⟩) <;> simp_all

/-- **T8 Strict refines lenient.** When the strict merge succeeds, its result
is the lenient merge's. Anchor: `threeWayFeatureStrict` ends in
`threeWayFeature`. -/
theorem T8_strict_ok (seed : Nat) (b o t f : Feature)
    (h : threeWayFeatureStrict seed b o t = .ok f) : threeWayFeature seed b o t = .ok f := by
  unfold threeWayFeatureStrict at h
  split at h <;> simp_all
  split at h <;> simp_all
  split at h <;> simp_all

/-- **T8 (conflict side).** When the strict merge fails where the lenient one
would succeed, some text was changed on both sides to different values.
Anchor: the three `clash` checks. -/
theorem T8_strict_conflict (seed : Nat) (b o t f : Feature) (e : String)
    (hs : threeWayFeatureStrict seed b o t = .error e) (hl : threeWayFeature seed b o t = .ok f) :
    clash b.name o.name t.name = true ∨ clash b.description o.description t.description = true ∨
    bodyClash b o t = true := by
  unfold threeWayFeatureStrict at hs
  split at hs
  · left; assumption
  · split at hs
    · right; left; assumption
    · split at hs
      · right; right; assumption
      · rw [hl] at hs; cases hs

/-- The same for pages. -/
theorem T8_page_strict_ok (seed : Nat) (b o t p : MarkdownPage)
    (h : threeWayPageStrict seed b o t = .ok p) : threeWayPage seed b o t = p := by
  unfold threeWayPageStrict at h
  split at h <;> simp_all
  split at h <;> simp_all

/-- **T9 Pages never conflict.** `threeWayPage` is a total function (it
returns a page, never a conflict), and every set-whole field of the result
is one side's value or absent. Anchor: `threeWayPage`, "A page merge
therefore never conflicts". -/
theorem T9_assigned (seed : Nat) (b o t : MarkdownPage) :
    let r := threeWayPage seed b o t
    r.assigned = o.assigned ∨ r.assigned = t.assigned ∨ r.assigned = none := by
  simp only [threeWayPage, pickValue]
  split <;> (try split) <;> simp_all

theorem T9_done (seed : Nat) (b o t : MarkdownPage) :
    let r := threeWayPage seed b o t
    r.done = o.done ∨ r.done = t.done ∨ r.done = none := by
  simp only [threeWayPage, pickValue]
  split
  · rename_i heq; split at heq <;> simp_all
  · simp

theorem T9_kind (seed : Nat) (b o t : MarkdownPage) :
    let r := threeWayPage seed b o t
    r.kind = o.kind ∨ r.kind = t.kind := by
  simp only [threeWayPage, pickValue]
  split <;> simp

theorem T9_supersedes (seed : Nat) (b o t : MarkdownPage) :
    let r := threeWayPage seed b o t
    r.supersedes = o.supersedes ∨ r.supersedes = t.supersedes := by
  simp only [threeWayPage, pickValue]
  split <;> simp

/-- T9, text side: a page's heading and body never conflict either — they go
through `mergeText`, which always returns a string. Stated as the identity
when the other side is unchanged. -/
theorem T9_body_theirs_unchanged (seed : Nat) (b o t : MarkdownPage) (h : t.body = b.body) :
    (threeWayPage seed b o t).body = o.body := by
  simp [threeWayPage, mergeText, h]

end SpecDriven.Sync

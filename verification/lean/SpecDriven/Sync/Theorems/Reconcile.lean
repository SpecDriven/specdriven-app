import SpecDriven.Sync.Reconcile

/-!
# Theorems: reconcile layer (T10–T15)

Anchors: `src/server/automerge/reconcile.ts`. The match plan is a `foldl`
over the entries; every theorem here goes through an invariant of that fold.
-/

namespace SpecDriven.Sync

/-! ## List helpers -/

theorem foldl_inv {α β : Type} (f : β → α → β) (P : β → Prop) (l : List α) (b : β)
    (hb : P b) (hf : ∀ b a, a ∈ l → P b → P (f b a)) : P (l.foldl f b) := by
  induction l generalizing b with
  | nil => exact hb
  | cons a l ih =>
    simp only [List.foldl_cons]
    exact ih (f b a) (hf b a (by simp) hb) (fun b' a' ha' => hf b' a' (by simp [ha']))

theorem enumerateFrom_getElem? {α : Type} (l : List α) (n i : Nat) :
    (enumerateFrom n l)[i]? = l[i]?.map (fun a => (n + i, a)) := by
  induction l generalizing n i with
  | nil => simp [enumerateFrom]
  | cons a l ih =>
    cases i with
    | zero => simp [enumerateFrom]
    | succ i =>
      simp only [enumerateFrom, List.getElem?_cons_succ, ih]
      congr 1; funext x; simp; omega

theorem enumerate_getElem? {α : Type} (l : List α) (i : Nat) :
    (enumerate l)[i]? = l[i]?.map (fun a => (i, a)) := by
  simp [enumerate, enumerateFrom_getElem?]

theorem mem_enumerateFrom {α : Type} (l : List α) (n i : Nat) (a : α) :
    (i, a) ∈ enumerateFrom n l ↔ n ≤ i ∧ l[i - n]? = some a := by
  induction l generalizing n i with
  | nil => simp [enumerateFrom]
  | cons x l ih =>
    simp only [enumerateFrom, List.mem_cons, Prod.mk.injEq, ih]
    constructor
    · rintro (⟨rfl, rfl⟩ | ⟨h1, h2⟩)
      · simp
      · refine ⟨by omega, ?_⟩
        have : i - n = (i - (n + 1)) + 1 := by omega
        rw [this]; simpa using h2
    · rintro ⟨h1, h2⟩
      by_cases hn : i = n
      · subst hn; simp at h2; left; exact ⟨rfl, h2.symm⟩
      · right
        refine ⟨by omega, ?_⟩
        have : i - n = (i - (n + 1)) + 1 := by omega
        rw [this] at h2; simpa using h2

theorem mem_enumerate {α : Type} (l : List α) (i : Nat) (a : α) :
    (i, a) ∈ enumerate l ↔ l[i]? = some a := by
  simp [enumerate, mem_enumerateFrom]

theorem enumerate_length {α : Type} (l : List α) : (enumerate l).length = l.length := by
  simp only [enumerate]
  suffices h : ∀ n, (enumerateFrom n l).length = l.length from h 0
  induction l with
  | nil => intro n; rfl
  | cons a l ih => intro n; simp [enumerateFrom, ih]

/-! ## The match plan -/

/-- One `forEach` step of `claim`. -/
def claimStep (target : Feature) (cand : Scenario → SpecEntry → Bool) (p : Plan) (ie : Nat × SpecEntry) :
    Plan :=
  if p.has ie.1 then p
  else match target.scenarios.find? (fun s => !p.isMatched s && cand s ie.2) with
    | some s => { matchAt := p.matchAt ++ [(ie.1, s)], matched := p.matched ++ [s] }
    | none => p

theorem claimPass_eq (entries : List SpecEntry) (target : Feature) (cand : Scenario → SpecEntry → Bool)
    (p : Plan) : claimPass entries target cand p = (enumerate entries).foldl (claimStep target cand) p := rfl

theorem Plan.has_iff (p : Plan) (i : Nat) : p.has i = true ↔ ∃ s, (i, s) ∈ p.matchAt := by
  simp only [Plan.has, List.any_eq_true, beq_iff_eq]
  constructor
  · rintro ⟨⟨j, s⟩, h, rfl⟩; exact ⟨s, h⟩
  · rintro ⟨s, h⟩; exact ⟨(i, s), h, rfl⟩

theorem Plan.isMatched_iff (p : Plan) (s : Scenario) : p.isMatched s = true ↔ s ∈ p.matched := by
  simp [Plan.isMatched]

/-- The plan invariant: `matched` is the range of `matchAt`, every match
names a target scenario and an entry index, no index is claimed twice, no
scenario is claimed twice. -/
structure Plan.Inv (entries : List SpecEntry) (target : Feature) (p : Plan) : Prop where
  range : ∀ s, s ∈ p.matched ↔ ∃ i, (i, s) ∈ p.matchAt
  sound : ∀ i s, (i, s) ∈ p.matchAt → s ∈ target.scenarios ∧ i < entries.length
  idxNodup : (p.matchAt.map (·.1)).Nodup
  matchedNodup : p.matched.Nodup

theorem Plan.Inv.empty (entries : List SpecEntry) (target : Feature) : Plan.Inv entries target {} :=
  ⟨by simp, by simp, by simp, by simp⟩

theorem claimStep_inv (entries : List SpecEntry) (target : Feature) (cand : Scenario → SpecEntry → Bool)
    (p : Plan) (ie : Nat × SpecEntry) (hie : ie ∈ enumerate entries) (h : Plan.Inv entries target p) :
    Plan.Inv entries target (claimStep target cand p ie) := by
  obtain ⟨i, e⟩ := ie
  have hlen : i < entries.length := by
    have := (mem_enumerate entries i e).mp hie
    exact List.getElem?_eq_some_iff.mp this |>.1
  unfold claimStep
  split
  · exact h
  · rename_i hhas
    split
    · rename_i s hs
      have hpred := List.find?_some hs
      have hsmem := List.mem_of_find?_eq_some hs
      simp only [Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true] at hpred
      have hnot : s ∉ p.matched := fun hm => by
        have := (Plan.isMatched_iff p s).mpr hm; simp_all
      have hnoti : ∀ s', (i, s') ∉ p.matchAt := fun s' hm => by
        have := (Plan.has_iff p i).mpr ⟨s', hm⟩; simp_all
      refine ⟨?_, ?_, ?_, ?_⟩
      · intro x
        simp only [List.mem_append, List.mem_singleton, h.range]
        constructor
        · rintro (⟨j, hj⟩ | rfl)
          · exact ⟨j, Or.inl hj⟩
          · exact ⟨i, Or.inr rfl⟩
        · rintro ⟨j, hj | hj⟩
          · exact Or.inl ⟨j, hj⟩
          · simp_all
      · intro j x hx
        simp only [List.mem_append, List.mem_singleton, Prod.mk.injEq] at hx
        rcases hx with hx | ⟨rfl, rfl⟩
        · exact h.sound j x hx
        · exact ⟨hsmem, hlen⟩
      · simp only [List.map_append, List.map_cons, List.map_nil]
        rw [List.nodup_append]
        refine ⟨h.idxNodup, (by simp), ?_⟩
        intro a ha b hb
        simp only [List.mem_singleton] at hb
        subst hb
        simp only [List.mem_map] at ha
        obtain ⟨⟨j, s'⟩, hj, rfl⟩ := ha
        intro hji
        simp only at hji
        subst hji
        exact hnoti s' hj
      · rw [List.nodup_append]
        refine ⟨h.matchedNodup, (by simp), ?_⟩
        intro a ha b hb
        simp only [List.mem_singleton] at hb
        subst hb
        intro hab; subst hab; exact hnot ha
    · exact h

theorem claimPass_inv (entries : List SpecEntry) (target : Feature) (cand : Scenario → SpecEntry → Bool)
    (p : Plan) (h : Plan.Inv entries target p) : Plan.Inv entries target (claimPass entries target cand p) := by
  rw [claimPass_eq]
  exact foldl_inv _ (Plan.Inv entries target) _ p h
    (fun p ie hie hp => claimStep_inv entries target cand p ie hie hp)

theorem idClaim_inv (entries : List SpecEntry) (target : Feature) (scenario : Option ScenarioTarget) :
    Plan.Inv entries target (idClaim entries target scenario {}) := by
  unfold idClaim
  split
  · rename_i pick id
    dsimp only
    split
    · rename_i i e s hat hcl
      split
      · exact Plan.Inv.empty entries target
      · have hmem := List.mem_of_find?_eq_some hat
        have hlen : i < entries.length :=
          (List.getElem?_eq_some_iff.mp ((mem_enumerate entries i e).mp hmem)).1
        have hs := List.mem_of_find?_eq_some hcl
        exact ⟨by simp, by simp_all, by simp, by simp⟩
    · exact Plan.Inv.empty entries target
  · exact Plan.Inv.empty entries target

/-- **T15 Match plan determinism and injectivity.** The plan is a function of
the document, the target and the editor's hint (it is a `def`), it names each
entry at most once and each target scenario at most once, and it only ever
names scenarios of the target. Anchor: `claim`, `matchAt`, `matched`. -/
theorem T15_plan_inv (entries : List SpecEntry) (target : Feature) (scenario : Option ScenarioTarget) :
    Plan.Inv entries target (plan entries target scenario) := by
  unfold plan
  exact claimPass_inv _ _ _ _ (claimPass_inv _ _ _ _ (idClaim_inv entries target scenario))

/-! ## What `applyPlan` does with the plan -/

theorem Plan.at?_none_of_not_has (p : Plan) (i : Nat) (h : p.has i = false) : p.at? i = none := by
  simp only [Plan.at?, Option.map_eq_none_iff, List.find?_eq_none]
  intro ⟨j, s⟩ hj hji
  have : p.has i = true := (Plan.has_iff p i).mpr ⟨s, by simp_all⟩
  simp_all

theorem Plan.at?_some_mem (p : Plan) (i : Nat) (s : Scenario) (h : p.at? i = some s) : (i, s) ∈ p.matchAt := by
  simp only [Plan.at?, Option.map_eq_some_iff] at h
  obtain ⟨⟨j, s'⟩, hj, hs⟩ := h
  have hmem := List.mem_of_find?_eq_some hj
  have hp := List.find?_some hj
  simp only [beq_iff_eq] at hp hs
  subst hp; subst hs; exact hmem

theorem updateEntry_none (p : Plan) (i : Nat) (e : SpecEntry) (h : p.at? i = none) :
    updateEntry p i e = (e, []) := by
  simp [updateEntry, h]

theorem updateEntry_some (p : Plan) (i : Nat) (e : SpecEntry) (m : Scenario) (h : p.at? i = some m) :
    (updateEntry p i e).1 = { e with name := m.name, version := m.version, status := m.status,
                                      body := m.body,
                                      publishedBody := if m.status == .published then some m.body else none,
                                      tests := m.tests, link := m.link } := by
  simp [updateEntry, h]

theorem updatedSpecs_getElem? (p : Plan) (specs : List SpecEntry) (i : Nat) :
    (updatedSpecs p specs)[i]? = specs[i]?.map (fun e => updateEntry p i e) := by
  simp only [updatedSpecs, List.getElem?_map, enumerate_getElem?, Option.map_map]
  rfl

theorem mem_keptSpecs (p : Plan) (specs : List SpecEntry) (x : SpecEntry) :
    x ∈ keptSpecs p specs ↔
      ∃ i e, specs[i]? = some e ∧ x = (updateEntry p i e).1 ∧ (p.has i || x.status == .draft) = true := by
  simp only [keptSpecs, List.mem_map, List.mem_filter]
  constructor
  · rintro ⟨⟨i, y⟩, ⟨hmem, hk⟩, rfl⟩
    rw [mem_enumerate, updatedSpecs_getElem?, Option.map_eq_some_iff] at hmem
    obtain ⟨e, he, rfl⟩ := hmem
    exact ⟨i, e, he, rfl, hk⟩
  · rintro ⟨i, e, he, rfl, hk⟩
    refine ⟨(i, updateEntry p i e), ⟨?_, hk⟩, rfl⟩
    rw [mem_enumerate, updatedSpecs_getElem?, he]
    rfl

/-- **T11 Drafts survive markdown.** An entry the plan does not claim is
removed only when it is not a draft: an unclaimed draft stays in the
document, id and content intact. Anchor: the removal loop skips
`status !== "draft"`. Spec: "draft scenarios live in the document only". -/
theorem T11_draft_kept (fresh : Nat → String) (d : FeatureDoc) (target : Feature) (p : Plan)
    (i : Nat) (e : SpecEntry) (hi : d.specs[i]? = some e) (hd : e.status = .draft)
    (hun : p.has i = false) : e ∈ (applyPlan fresh d target p).1.specs := by
  simp only [applyPlan, List.mem_append]
  left
  rw [mem_keptSpecs]
  refine ⟨i, e, hi, ?_, by simp [hd]⟩
  rw [updateEntry_none p i e (Plan.at?_none_of_not_has p i hun)]

/-- **T11 (claimed entries keep their identity).** A claimed entry — a draft
promoted or renamed in place, or any other matched entry — keeps its id;
only its content moves to the target's. Anchor: "promotes or renames it in
place, keeping its identity". -/
theorem T11_claimed_keeps_id (fresh : Nat → String) (d : FeatureDoc) (target : Feature) (p : Plan)
    (i : Nat) (e : SpecEntry) (m : Scenario) (hi : d.specs[i]? = some e) (hm : p.at? i = some m) :
    { e with name := m.name, version := m.version, status := m.status, body := m.body,
             publishedBody := if m.status == .published then some m.body else none,
             tests := m.tests, link := m.link } ∈ (applyPlan fresh d target p).1.specs := by
  simp only [applyPlan, List.mem_append]
  left
  rw [mem_keptSpecs]
  refine ⟨i, e, hi, (updateEntry_some p i e m hm).symm, ?_⟩
  have : p.has i = true := (Plan.has_iff p i).mpr ⟨m, Plan.at?_some_mem p i m hm⟩
  simp [this]

/-- Keys are unique in a list of scenarios: two members with one key are one
scenario. -/
def KeysUnique (l : List Scenario) : Prop :=
  ∀ a ∈ l, ∀ b ∈ l, a.key = b.key → a = b

/-- **T10 Published immutability (claimed form).** With the gate passed and
unique target keys, a published entry claimed under its own key is claimed by
the scenario the gate checked: published, body intact. The entry survives
with id, name, version and status unchanged, its live body now the body it
was published with (`effectiveBody` — the gate holds the file to that, not to
a live text a merge may have doubled), and that recorded body unchanged, so
the rendered body never moves. Anchor:
`assertPublishedKept`, `reconcile`. Spec: "published scenarios stay
immutable". `T10_published_kept` below discharges the "claimed under its own
key" premise from the key pass. -/
theorem T10_published_claimed (fresh : Nat → String) (d : FeatureDoc) (target : Feature) (p : Plan)
    (hinv : Plan.Inv d.specs target p) (hT : KeysUnique target.scenarios)
    (i : Nat) (e : SpecEntry) (m : Scenario) (hi : d.specs[i]? = some e)
    (hpub : e.status = .published) (hm : p.at? i = some m)
    (hkey : m.name = e.name ∧ m.version = e.version) (hkept : publishedKept d target = true) :
    ∃ e' ∈ (applyPlan fresh d target p).1.specs,
      e'.id = e.id ∧ e'.name = e.name ∧ e'.version = e.version ∧ e'.status = .published ∧
        e'.body = e.effectiveBody ∧ e'.effectiveBody = e.effectiveBody := by
  have hmem := T11_claimed_keeps_id fresh d target p i e m hi hm
  simp only [publishedKept, List.all_eq_true] at hkept
  have he : e ∈ d.specs := List.mem_of_getElem? hi
  have hg := hkept e he
  simp only [hpub, bne_self_eq_false, Bool.false_or] at hg
  split at hg
  · rename_i s hs
    have hsmem := List.mem_of_find?_eq_some hs
    have hsp := List.find?_some hs
    simp only [samePickS, Bool.and_eq_true, beq_iff_eq] at hsp
    have hmmem := (hinv.sound i m (Plan.at?_some_mem p i m hm)).1
    have hms : m = s := hT m hmmem s hsmem (by simp [Scenario.key, hkey, hsp])
    subst hms
    simp only [Bool.and_eq_true, beq_iff_eq] at hg
    refine ⟨_, hmem, rfl, hkey.1, hkey.2, hg.1, hg.2, ?_⟩
    simp [SpecEntry.effectiveBody, hg.1, hg.2]
  · cases hg


/-! ## Plans only grow, and an existing match is never moved -/

theorem claimStep_grows (target : Feature) (cand : Scenario → SpecEntry → Bool) (p : Plan)
    (ie : Nat × SpecEntry) : ∃ r, (claimStep target cand p ie).matchAt = p.matchAt ++ r := by
  unfold claimStep
  split
  · exact ⟨[], by simp⟩
  · split
    · exact ⟨_, rfl⟩
    · exact ⟨[], by simp⟩

theorem claimPass_grows (entries : List SpecEntry) (target : Feature) (cand : Scenario → SpecEntry → Bool)
    (p : Plan) : ∃ r, (claimPass entries target cand p).matchAt = p.matchAt ++ r := by
  rw [claimPass_eq]
  refine foldl_inv _ (fun q => ∃ r, q.matchAt = p.matchAt ++ r) _ p ⟨[], by simp⟩ ?_
  intro q ie _ hq
  obtain ⟨r, hr⟩ := hq
  obtain ⟨r', hr'⟩ := claimStep_grows target cand q ie
  exact ⟨r ++ r', by rw [hr', hr, List.append_assoc]⟩

theorem Plan.at?_of_grows (p q : Plan) (r : List (Nat × Scenario)) (h : q.matchAt = p.matchAt ++ r)
    (i : Nat) (s : Scenario) (hp : p.at? i = some s) : q.at? i = some s := by
  simp only [Plan.at?, Option.map_eq_some_iff] at hp
  obtain ⟨x, hx, hxs⟩ := hp
  simp [Plan.at?, h, List.find?_append, hx, hxs]

theorem Plan.at?_append_self (p : Plan) (i : Nat) (s : Scenario) (h : p.has i = false) :
    Plan.at? { matchAt := p.matchAt ++ [(i, s)], matched := p.matched ++ [s] } i = some s := by
  have h0 : p.matchAt.find? (·.1 == i) = none := by
    have := Plan.at?_none_of_not_has p i h
    simpa [Plan.at?, Option.map_eq_none_iff] using this
  simp [Plan.at?, List.find?_append, h0]

/-! ## The key pass claims every entry whose key the target still carries -/

/-- Keys are unique among the document's entries: two indices with one key
are one index. -/
def EntryKeysUnique (l : List SpecEntry) : Prop :=
  ∀ (i j : Nat) (e e' : SpecEntry), l[i]? = some e → l[j]? = some e' → e.key = e'.key → i = j

/-- The candidate of the key pass. -/
abbrev keyCand (s : Scenario) (e : SpecEntry) : Bool := samePickE e ⟨s.name, s.version⟩

theorem plan_eq (entries : List SpecEntry) (target : Feature) (scenario : Option ScenarioTarget) :
    plan entries target scenario =
      claimPass entries target (fun s e => s.body == e.effectiveBody)
        (claimPass entries target keyCand (idClaim entries target scenario {})) := rfl

/-- A key-pass step on another entry leaves `i` unclaimed and `s` unmatched. -/
theorem keyStep_other (entries : List SpecEntry) (target : Feature) (hE : EntryKeysUnique entries)
    (i : Nat) (e : SpecEntry) (s : Scenario) (hi : entries[i]? = some e)
    (hkey : s.name = e.name ∧ s.version = e.version)
    (p : Plan) (hinv : Plan.Inv entries target p) (hh : p.has i = false) (hm : p.isMatched s = false)
    (j : Nat) (e' : SpecEntry) (hje : entries[j]? = some e') (hne : j ≠ i) :
    Plan.Inv entries target (claimStep target keyCand p (j, e')) ∧
      (claimStep target keyCand p (j, e')).has i = false ∧
      (claimStep target keyCand p (j, e')).isMatched s = false := by
  refine ⟨claimStep_inv entries target keyCand p (j, e') ((mem_enumerate entries j e').mpr hje) hinv, ?_⟩
  unfold claimStep
  split
  · exact ⟨hh, hm⟩
  · split
    · rename_i s' hs'
      have hpred := List.find?_some hs'
      simp only [Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true, keyCand, samePickE,
        beq_iff_eq] at hpred
      constructor
      · simp only [Plan.has] at hh ⊢
        simp [List.any_append, hh, hne]
      · apply Bool.eq_false_iff.mpr
        intro hc
        rw [Plan.isMatched_iff] at hc
        simp only [List.mem_append, List.mem_singleton] at hc
        rcases hc with hc | hc
        · have := (Plan.isMatched_iff p s).mpr hc; simp_all
        · apply hne
          apply hE j i e' e hje hi
          show (e'.name, e'.version) = (e.name, e.version)
          rw [hpred.2.1, hpred.2.2, ← hc, hkey.1, hkey.2]
    · exact ⟨hh, hm⟩

/-- The key-pass step on entry `i` itself claims `s`. -/
theorem keyStep_self (target : Feature) (hT : KeysUnique target.scenarios)
    (i : Nat) (e : SpecEntry) (s : Scenario) (hs : s ∈ target.scenarios)
    (hkey : s.name = e.name ∧ s.version = e.version)
    (p : Plan) (hh : p.has i = false) (hm : p.isMatched s = false) :
    (claimStep target keyCand p (i, e)).at? i = some s := by
  unfold claimStep
  simp only [hh, Bool.false_eq_true, ite_false]
  split
  · rename_i s' hs'
    have hpred := List.find?_some hs'
    have hmem := List.mem_of_find?_eq_some hs'
    simp only [Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true, keyCand, samePickE,
      beq_iff_eq] at hpred
    have : s' = s := hT s' hmem s hs (by
      show (s'.name, s'.version) = (s.name, s.version)
      rw [← hpred.2.1, ← hpred.2.2, hkey.1, hkey.2])
    subst this
    exact Plan.at?_append_self p i _ hh
  · rename_i hnone
    exfalso
    rw [List.find?_eq_none] at hnone
    exact hnone s hs (by simp [hm, keyCand, samePickE, hkey])

theorem keyPass_fold (entries : List SpecEntry) (target : Feature)
    (hE : EntryKeysUnique entries) (hT : KeysUnique target.scenarios)
    (i : Nat) (e : SpecEntry) (s : Scenario) (hi : entries[i]? = some e) (hs : s ∈ target.scenarios)
    (hkey : s.name = e.name ∧ s.version = e.version)
    (l : List (Nat × SpecEntry)) (hl : ∀ je ∈ l, entries[je.1]? = some je.2) :
    ∀ p : Plan,
      (p.at? i = some s ∨
        (Plan.Inv entries target p ∧ p.has i = false ∧ p.isMatched s = false ∧ (i, e) ∈ l)) →
      (l.foldl (claimStep target keyCand) p).at? i = some s := by
  induction l with
  | nil =>
    intro p h
    rcases h with h | ⟨_, _, _, h⟩
    · exact h
    · simp at h
  | cons je l ih =>
    obtain ⟨j, e'⟩ := je
    intro p h
    simp only [List.foldl_cons]
    have hl' : ∀ je ∈ l, entries[je.1]? = some je.2 := fun je' h' => hl je' (List.mem_cons_of_mem _ h')
    have hje : entries[j]? = some e' := hl (j, e') List.mem_cons_self
    apply ih hl'
    rcases h with h | ⟨hinv, hh, hm, hmem⟩
    · left
      obtain ⟨r, hr⟩ := claimStep_grows target keyCand p (j, e')
      exact Plan.at?_of_grows p _ r hr i s h
    · by_cases hje' : (j, e') = (i, e)
      · rw [hje']
        left
        exact keyStep_self target hT i e s hs hkey p hh hm
      · have hne : j ≠ i := by
          intro h1
          subst h1
          rw [hi] at hje
          exact hje' (by rw [Option.some.inj hje])
        right
        obtain ⟨h1, h2, h3⟩ := keyStep_other entries target hE i e s hi hkey p hinv hh hm j e' hje hne
        refine ⟨h1, h2, h3, ?_⟩
        simp only [List.mem_cons] at hmem
        rcases hmem with hmem | hmem
        · exact absurd hmem.symm hje'
        · exact hmem

theorem keyPass_claims (entries : List SpecEntry) (target : Feature)
    (hE : EntryKeysUnique entries) (hT : KeysUnique target.scenarios)
    (i : Nat) (e : SpecEntry) (s : Scenario) (hi : entries[i]? = some e) (hs : s ∈ target.scenarios)
    (hkey : s.name = e.name ∧ s.version = e.version) (p : Plan)
    (h : p.at? i = some s ∨ (Plan.Inv entries target p ∧ p.has i = false ∧ p.isMatched s = false)) :
    (claimPass entries target keyCand p).at? i = some s := by
  rw [claimPass_eq]
  apply keyPass_fold entries target hE hT i e s hi hs hkey (enumerate entries)
    (fun je hje => by obtain ⟨j, e'⟩ := je; exact (mem_enumerate entries j e').mp hje) p
  rcases h with h | ⟨h1, h2, h3⟩
  · exact Or.inl h
  · exact Or.inr ⟨h1, h2, h3, (mem_enumerate entries i e).mpr hi⟩

/-! ## The editor's id claim -/

/-- What the id claim can produce: nothing, or a single match of the entry
carrying the id to the first target scenario with the pick's key, made only
when no other entry carries that key and a published entry is not being
moved off its key. -/
theorem idClaim_shape (entries : List SpecEntry) (target : Feature) (scenario : Option ScenarioTarget) :
    idClaim entries target scenario {} = {} ∨
    ∃ pick id i' e' s', scenario = some ⟨pick, some id⟩ ∧ entries[i']? = some e' ∧ e'.id = id ∧
      s' ∈ target.scenarios ∧ samePickS s' pick = true ∧
      (∀ j e'', entries[j]? = some e'' → j ≠ i' → samePickE e'' pick = false) ∧
      (e'.status = .published → samePickE e' pick = true) ∧
      idClaim entries target scenario {} = { matchAt := [(i', s')], matched := [s'] } := by
  unfold idClaim
  split
  · rename_i pick id
    dsimp only
    split
    · rename_i i' e' s' hat hcl
      split
      · left; rfl
      · rename_i hblocked
        right
        have hmem := List.mem_of_find?_eq_some hat
        have hid := List.find?_some hat
        simp only [beq_iff_eq] at hid
        have hother : ∀ j e'', entries[j]? = some e'' → j ≠ i' → samePickE e'' pick = false := by
          intro j e'' hj hne
          cases hc : samePickE e'' pick
          · rfl
          · exfalso; apply hblocked
            simp only [Bool.or_eq_true, List.any_eq_true]
            exact Or.inl ⟨(j, e''), (mem_enumerate entries j e'').mpr hj, by simp [hne, hc]⟩
        have hself : e'.status = .published → samePickE e' pick = true := by
          intro hp
          cases hc : samePickE e' pick
          · exfalso; apply hblocked
            simp only [Bool.or_eq_true]
            exact Or.inr (by simp [hp, hc])
          · rfl
        refine ⟨pick, id, i', e', s', rfl, (mem_enumerate entries i' e').mp hmem, hid,
          List.mem_of_find?_eq_some hcl, List.find?_some (p := fun s => samePickS s pick) hcl, hother, hself, rfl⟩
    · left; rfl
  · left; rfl

/-- Where a published entry stands after the id claim: already claimed by its
own key's scenario, or untouched with that scenario unmatched. -/
theorem idClaim_start (entries : List SpecEntry) (target : Feature) (scenario : Option ScenarioTarget)
    (hT : KeysUnique target.scenarios)
    (i : Nat) (e : SpecEntry) (s : Scenario) (hi : entries[i]? = some e) (hs : s ∈ target.scenarios)
    (hkey : s.name = e.name ∧ s.version = e.version) (hpub : e.status = .published) :
    (idClaim entries target scenario {}).at? i = some s ∨
      (Plan.Inv entries target (idClaim entries target scenario {}) ∧
        (idClaim entries target scenario {}).has i = false ∧
        (idClaim entries target scenario {}).isMatched s = false) := by
  have hinv := idClaim_inv entries target scenario
  rcases idClaim_shape entries target scenario with h |
    ⟨pick, id, i', e', s', _, hi', _, hs', hsp, hother, hself, h⟩
  · rw [h] at hinv ⊢
    exact Or.inr ⟨hinv, rfl, rfl⟩
  · rw [h] at hinv ⊢
    simp only [samePickS, Bool.and_eq_true, beq_iff_eq] at hsp
    by_cases hii : i' = i
    · subst hii
      rw [hi] at hi'
      have he := Option.some.inj hi'
      subst he
      have hsp' := hself hpub
      simp only [samePickE, Bool.and_eq_true, beq_iff_eq] at hsp'
      have : s' = s := hT s' hs' s hs (by
        show (s'.name, s'.version) = (s.name, s.version)
        rw [hsp.1, hsp.2, hkey.1, hkey.2, hsp'.1, hsp'.2])
      subst this
      left; simp [Plan.at?]
    · right
      refine ⟨hinv, ?_, ?_⟩
      · simp [Plan.has, hii]
      · apply Bool.eq_false_iff.mpr
        intro hc
        rw [Plan.isMatched_iff] at hc
        simp only [List.mem_singleton] at hc
        have h1 : e.name = pick.name := by rw [← hkey.1, hc, hsp.1]
        have h2 : e.version = pick.version := by rw [← hkey.2, hc, hsp.2]
        have := hother i e hi (Ne.symm hii)
        simp [samePickE, h1, h2] at this

/-- The gate passed: a published entry has a same-key scenario in the target. -/
theorem publishedKept_key (d : FeatureDoc) (target : Feature) (hkept : publishedKept d target = true)
    (e : SpecEntry) (he : e ∈ d.specs) (hpub : e.status = .published) :
    ∃ s ∈ target.scenarios, s.name = e.name ∧ s.version = e.version := by
  simp only [publishedKept, List.all_eq_true] at hkept
  have hg := hkept e he
  simp only [hpub, bne_self_eq_false, Bool.false_or] at hg
  split at hg
  · rename_i s hs
    have hsp := List.find?_some hs
    simp only [samePickS, Bool.and_eq_true, beq_iff_eq] at hsp
    exact ⟨s, List.mem_of_find?_eq_some hs, hsp⟩
  · cases hg

theorem reconcile_ok (fresh : Nat → String) (d : FeatureDoc) (target : Feature)
    (scenario : Option ScenarioTarget) (d' : FeatureDoc) (ops : List Op)
    (hr : reconcile fresh d target false scenario = .ok (d', ops)) :
    publishedKept d target = true ∧ d' = (applyPlan fresh d target (plan d.specs target scenario)).1 := by
  have hkept : publishedKept d target = true := by
    cases hk : publishedKept d target with
    | true => rfl
    | false => simp [reconcile, hk] at hr
  refine ⟨hkept, ?_⟩
  simp only [reconcile, hkept, Bool.not_true, Bool.and_false, Bool.false_eq_true, ite_false,
    Except.ok.injEq] at hr
  rw [hr]

/-- **T10 Published immutability.** When `reconcile` returns without error
(`force` false), every published entry of the document survives with its
id, name, version, status and published body, provided keys are unique on both sides
(two entries with one key cannot both claim the single target scenario, and
the gate accepts them both: see REPORT.md). Anchor: `assertPublishedKept`,
`reconcile`. Spec: "published scenarios stay immutable". -/
theorem T10_published_kept (fresh : Nat → String) (d : FeatureDoc) (target : Feature)
    (scenario : Option ScenarioTarget) (d' : FeatureDoc) (ops : List Op)
    (hE : EntryKeysUnique d.specs) (hT : KeysUnique target.scenarios)
    (hr : reconcile fresh d target false scenario = .ok (d', ops))
    (e : SpecEntry) (he : e ∈ d.specs) (hpub : e.status = .published) :
    ∃ e' ∈ d'.specs,
      e'.id = e.id ∧ e'.name = e.name ∧ e'.version = e.version ∧ e'.status = .published ∧
        e'.body = e.effectiveBody ∧ e'.effectiveBody = e.effectiveBody := by
  obtain ⟨hkept, hd'⟩ := reconcile_ok fresh d target scenario d' ops hr
  subst hd'
  obtain ⟨i, hi⟩ := List.getElem?_of_mem he
  obtain ⟨s, hs, hkey⟩ := publishedKept_key d target hkept e he hpub
  have hstart := idClaim_start d.specs target scenario hT i e s hi hs hkey hpub
  have hkp := keyPass_claims d.specs target hE hT i e s hi hs hkey _ hstart
  obtain ⟨r, hr'⟩ := claimPass_grows d.specs target (fun s e => s.body == e.effectiveBody)
    (claimPass d.specs target keyCand (idClaim d.specs target scenario {}))
  have hfinal : (plan d.specs target scenario).at? i = some s := by
    rw [plan_eq]; exact Plan.at?_of_grows _ _ r hr' i s hkp
  exact T10_published_claimed fresh d target _ (T15_plan_inv _ _ _) hT i e s hi hpub hfinal hkey hkept

/-- **T14 Identity stability under rename.** When the editor's hint names an
unpublished entry by id and the target holds a scenario with the hint's key
that no other entry carries, the result keeps that entry's id under the new
key. Anchor: the `scenario?.id` claim block. -/
theorem T14_rename_keeps_id (fresh : Nat → String) (d : FeatureDoc) (target : Feature)
    (pick : ScenarioPick) (id : String) (i : Nat) (e : SpecEntry)
    (hfind : (enumerate d.specs).find? (fun x => x.2.id == id) = some (i, e))
    (hunpub : e.status ≠ .published)
    (s : Scenario) (hs : s ∈ target.scenarios) (hsp : samePickS s pick = true)
    (hnoother : ∀ j e', d.specs[j]? = some e' → j ≠ i → samePickE e' pick = false)
    (d' : FeatureDoc) (ops : List Op)
    (hr : reconcile fresh d target false (some ⟨pick, some id⟩) = .ok (d', ops)) :
    ∃ e' ∈ d'.specs, e'.id = e.id ∧ e'.name = pick.name ∧ e'.version = pick.version := by
  obtain ⟨_, hd'⟩ := reconcile_ok fresh d target _ d' ops hr
  subst hd'
  have hi : d.specs[i]? = some e := (mem_enumerate d.specs i e).mp (List.mem_of_find?_eq_some hfind)
  have hcl : ∃ s'', target.scenarios.find? (fun s => samePickS s pick) = some s'' := by
    cases hc : target.scenarios.find? (fun s => samePickS s pick) with
    | some s'' => exact ⟨s'', rfl⟩
    | none =>
      exfalso
      rw [List.find?_eq_none] at hc
      exact hc s hs hsp
  obtain ⟨s'', hcl⟩ := hcl
  have hs''p := List.find?_some hcl
  simp only [samePickS, Bool.and_eq_true, beq_iff_eq] at hs''p
  have hid : idClaim d.specs target (some ⟨pick, some id⟩) {} = { matchAt := [(i, s'')], matched := [s''] } := by
    unfold idClaim
    simp only [hfind, hcl]
    split
    · rename_i hb
      exfalso
      simp only [Bool.or_eq_true, List.any_eq_true, Bool.and_eq_true, bne_iff_ne, ne_eq, beq_iff_eq,
        Bool.not_eq_eq_eq_not, Bool.not_true] at hb
      rcases hb with ⟨⟨j, e'⟩, hmem, hne, hsp'⟩ | ⟨hp, _⟩
      · have := hnoother j e' ((mem_enumerate d.specs j e').mp hmem) hne
        simp_all
      · exact hunpub hp
    · rfl
  have h0 : (idClaim d.specs target (some ⟨pick, some id⟩) {}).at? i = some s'' := by
    rw [hid]; simp [Plan.at?]
  obtain ⟨r1, hr1⟩ := claimPass_grows d.specs target keyCand (idClaim d.specs target (some ⟨pick, some id⟩) {})
  have h1 := Plan.at?_of_grows _ _ r1 hr1 i s'' h0
  obtain ⟨r2, hr2⟩ := claimPass_grows d.specs target (fun s e => s.body == e.effectiveBody)
    (claimPass d.specs target keyCand (idClaim d.specs target (some ⟨pick, some id⟩) {}))
  have h2 : (plan d.specs target (some ⟨pick, some id⟩)).at? i = some s'' := by
    rw [plan_eq]; exact Plan.at?_of_grows _ _ r2 hr2 i s'' h1
  exact ⟨_, T11_claimed_keeps_id fresh d target _ i e s'' hi h2, rfl, hs''p.1, hs''p.2⟩

end SpecDriven.Sync

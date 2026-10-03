/-!
# Crdt: what the model assumes of Automerge

Every `axiom` in the verification lives here or in `Git.lean`. Each one
names the Automerge behaviour it stands for and how it could be discharged.

## Documents as change sets

An Automerge document is the set of changes merged into it. Merging two
documents is the union of their change sets, and the document's observable
state is a function of that set alone: not of the order the changes arrived
in, nor of how many times each arrived. That is the join-semilattice fact the
store relies on ("merging the same operations twice is a no-op",
netsync.ts). Here a change set is a `List Change` read up to membership
(`ChangeSet.equiv`), which gives commutativity, associativity and idempotence
of `++` for free, and `view` is the opaque interpretation.

## Dependency closure

A change names the heads it was made on top of (`deps`). Automerge's
`loadIncremental` holds a change whose dependencies are missing as pending
until they arrive, so a change set is fully applied only when it is
dependency-closed. `saveSince doc heads` produces changes whose dependencies
are all within `doc` (axiom `saveSince_deps`).

## Text

`updateText` is not an assignment: it diffs the current text against the new
one and mints insert and delete operations for the difference, under this
peer's actor id. Two peers running `updateText` with the same new text on two
forks of the same document mint two independent sets of inserts, and merging
the forks keeps both (axiom `Text.concurrent_update_grows`). This is the
single most important assumption for hypothesis H2. It could be discharged by
a property test against `@automerge/automerge`: fork, `updateText` on both,
`merge`, compare.
-/

namespace SpecDriven.Sync

/-- One Automerge change: its hash and the hashes it depends on. The
operations it carries are irrelevant to the store theorems. -/
structure Change where
  id : Nat
  deps : List Nat
  deriving DecidableEq, Repr

abbrev ChangeSet := List Change

/-- Two change sets are the same document when they hold the same changes. -/
def ChangeSet.equiv (a b : ChangeSet) : Prop := ∀ c, c ∈ a ↔ c ∈ b

theorem ChangeSet.equiv_refl (a : ChangeSet) : a.equiv a := fun _ => Iff.rfl
theorem ChangeSet.equiv_symm {a b : ChangeSet} (h : a.equiv b) : b.equiv a := fun c => (h c).symm
theorem ChangeSet.equiv_trans {a b c : ChangeSet} (h1 : a.equiv b) (h2 : b.equiv c) : a.equiv c :=
  fun x => (h1 x).trans (h2 x)

/-- Every dependency of every change is present. -/
def ChangeSet.closed (a : ChangeSet) : Prop :=
  ∀ c ∈ a, ∀ d ∈ c.deps, ∃ c' ∈ a, c'.id = d

theorem ChangeSet.closed_of_equiv {a b : ChangeSet} (h : a.equiv b) (hc : a.closed) : b.closed := by
  intro c hc' d hd
  obtain ⟨c', hc'', hid⟩ := hc c ((h c).mpr hc') d hd
  exact ⟨c', (h c').mp hc'', hid⟩

/-- The observable document state Automerge computes from a change set. -/
axiom State : Type

/-- `A.load` / `A.loadIncremental` folded over a change set. -/
axiom view : ChangeSet → State

/-- **Axiom (Automerge is a join-semilattice).** The state depends only on
which changes are present. Discharge: Automerge's documented merge semantics;
property-test by loading chunks in shuffled order and comparing `A.save`. -/
axiom view_equiv : ∀ a b : ChangeSet, a.equiv b → view a = view b

/-- `A.saveSince doc heads`: the changes of `doc` not reachable from `heads`.
Modelled as an arbitrary function; only `saveSince_deps` is assumed of it. -/
axiom saveSince : ChangeSet → List Nat → ChangeSet

/-- **Axiom (deltas are closed within their document).** A change saved from
`doc` depends only on changes `doc` holds. Discharge: a change's `deps` are
the heads of the document it was made on, which are in that document. -/
axiom saveSince_deps : ∀ (doc : ChangeSet) (heads : List Nat),
  ∀ c ∈ saveSince doc heads, ∀ d ∈ c.deps, ∃ c' ∈ doc ++ saveSince doc heads, c'.id = d

/-- A collaborative text (one `body`, `name` or `description` field). -/
axiom Text : Type
axiom Text.view : Text → String
/-- `A.updateText` under actor `actor`. -/
axiom Text.update : Text → Nat → String → Text
axiom Text.merge : Text → Text → Text

/-- **Axiom.** After `updateText(d, path, s)` the field reads `s`. Discharge:
`updateText`'s contract. -/
axiom Text.update_view : ∀ (t : Text) (actor : Nat) (s : String), (t.update actor s).view = s

/-- **Axiom (concurrent identical updates duplicate inserts).** Two actors
run `updateText` to the same longer text on two forks; the merge holds both
sets of inserted characters, so it is longer than `s` and therefore not `s`.
Discharge: property test against `@automerge/automerge` (fork, updateText
both, merge). -/
axiom Text.concurrent_update_grows : ∀ (t : Text) (a a' : Nat) (s : String),
  a ≠ a' → t.view.length < s.length →
  ((t.update a s).merge (t.update a' s)).view.length > s.length

end SpecDriven.Sync

import SpecDriven.Sync.Store

/-!
# Theorems: store layer (T1–T5)

Anchors: `src/server/automerge/store.ts`.
-/

namespace SpecDriven.Sync

theorem mem_loadChunks {cs : List Chunk} {c : Change} :
    c ∈ loadChunks cs ↔ ∃ ch ∈ cs, ch.readable = true ∧ c ∈ ch.changes := by
  simp only [loadChunks, List.mem_flatMap, List.mem_filter]
  constructor
  · rintro ⟨ch, ⟨h1, h2⟩, h3⟩; exact ⟨ch, h1, h2, h3⟩
  · rintro ⟨ch, h1, h2, h3⟩; exact ⟨ch, ⟨h1, h2⟩, h3⟩

/-- **T1 Order-independent load.** Loading the chunks of a directory in any
order yields the same document. Anchor: `chunkFiles` sorts, `loadDoc`
folds, and Automerge merge is a join. Spec: "Storage layout". -/
theorem T1_load_perm {p q : List Chunk} (h : p.Perm q) : (loadChunks p).equiv (loadChunks q) := by
  intro c
  simp only [mem_loadChunks]
  constructor
  · rintro ⟨ch, h1, h2, h3⟩; exact ⟨ch, h.mem_iff.mp h1, h2, h3⟩
  · rintro ⟨ch, h1, h2, h3⟩; exact ⟨ch, h.mem_iff.mpr h1, h2, h3⟩

theorem T1_view_perm {p q : List Chunk} (h : p.Perm q) : view (loadChunks p) = view (loadChunks q) :=
  view_equiv _ _ (T1_load_perm h)

/-- Loading a directory that holds the same chunk files in any order and any
multiplicity gives the same change set. -/
theorem load_equiv_of_same_files {p q : List Chunk} (h : ∀ ch, ch ∈ p ↔ ch ∈ q) :
    (loadChunks p).equiv (loadChunks q) := by
  intro c
  simp only [mem_loadChunks]
  constructor
  · rintro ⟨ch, h1, h2, h3⟩; exact ⟨ch, (h ch).mp h1, h2, h3⟩
  · rintro ⟨ch, h1, h2, h3⟩; exact ⟨ch, (h ch).mpr h1, h2, h3⟩

/-- **T2 Union convergence.** Two peers whose directories hold the same set of
chunk files (after a pull that unioned them) load the same document. Anchor:
chunk files are content-addressed and write-once, so git merges two chunk
directories as a file-set union. Spec: "two peers edit the same scenario
concurrently". -/
theorem T2_union_convergence {a b : List Chunk} (h : ∀ ch, ch ∈ a ↔ ch ∈ b) :
    view (loadChunks a) = view (loadChunks b) :=
  view_equiv _ _ (load_equiv_of_same_files h)

/-- Appending the same new chunk on both sides preserves agreement. -/
theorem T2_append {a b : List Chunk} (h : (loadChunks a).equiv (loadChunks b)) (c : Chunk) :
    (loadChunks (a ++ [c])).equiv (loadChunks (b ++ [c])) := by
  intro x
  simp only [mem_loadChunks, List.mem_append, List.mem_singleton]
  constructor
  · rintro ⟨ch, h1 | h1, h2, h3⟩
    · obtain ⟨ch', h1', h2', h3'⟩ := (mem_loadChunks.mp ((h x).mp (mem_loadChunks.mpr ⟨ch, h1, h2, h3⟩)))
      exact ⟨ch', Or.inl h1', h2', h3'⟩
    · exact ⟨ch, Or.inr h1, h2, h3⟩
  · rintro ⟨ch, h1 | h1, h2, h3⟩
    · obtain ⟨ch', h1', h2', h3'⟩ := (mem_loadChunks.mp ((h x).mpr (mem_loadChunks.mpr ⟨ch, h1, h2, h3⟩)))
      exact ⟨ch', Or.inl h1', h2', h3'⟩
    · exact ⟨ch, Or.inr h1, h2, h3⟩

/-- **T3 Compaction safety (content).** The document loads the same before
and after `compactDoc`. Anchor: `compactDoc` writes `A.save(loaded)` and
deletes only chunks that loaded. -/
theorem T3_compact_load (hashOf : ChangeSet → String) (cs : List Chunk) :
    (loadChunks (compactDoc hashOf cs)).equiv (loadChunks cs) := by
  intro c
  unfold compactDoc
  split
  · exact Iff.rfl
  · simp only [mem_loadChunks, List.mem_cons, skippedChunks, List.mem_filter]
    constructor
    · rintro ⟨ch, h1 | ⟨h1, h1'⟩, h2, h3⟩
      · subst h1; exact mem_loadChunks.mp h3
      · simp_all
    · intro hc
      exact ⟨_, Or.inl rfl, rfl, mem_loadChunks.mpr hc⟩

theorem T3_compact_view (hashOf : ChangeSet → String) (cs : List Chunk) :
    view (loadChunks (compactDoc hashOf cs)) = view (loadChunks cs) :=
  view_equiv _ _ (T3_compact_load hashOf cs)

/-- **T3 (skipped chunks survive).** A chunk `loadDoc` could not read is
never deleted by compaction: edits living only in it stay on disk for a
peer that can read it. Anchor: `applied = new Set(loaded.skippedChunks)`. -/
theorem T3_compact_keeps_unreadable (hashOf : ChangeSet → String) (cs : List Chunk) (ch : Chunk)
    (h : ch ∈ cs) (hu : ch.readable = false) : ch ∈ compactDoc hashOf cs := by
  unfold compactDoc
  split
  · exact h
  · simp [skippedChunks, List.mem_filter, h, hu]

/-- **T3 (concurrent add).** A chunk another peer pushed meanwhile — built on
any sub-closure of the directory — loads to the same document whether or not
this peer compacted first. Anchor: "two peers compacting concurrently just
leave two snapshots for the next load to merge". -/
theorem T3_compact_concurrent (hashOf : ChangeSet → String) (cs : List Chunk) (c : Chunk) :
    (loadChunks (compactDoc hashOf cs ++ [c])).equiv (loadChunks (cs ++ [c])) :=
  T2_append (T3_compact_load hashOf cs) c

/-- **T3 / H5 (closure survives compaction).** If the union of changes is
dependency-closed before compaction it is afterwards, with any concurrent
chunk added: no change is left pending forever. -/
theorem T3_compact_closed (hashOf : ChangeSet → String) (cs : List Chunk) (c : Chunk)
    (h : (loadChunks (cs ++ [c])).closed) : (loadChunks (compactDoc hashOf cs ++ [c])).closed :=
  ChangeSet.closed_of_equiv (ChangeSet.equiv_symm (T3_compact_concurrent hashOf cs c)) h

/-- **T4 Double delivery is a no-op.** Changes that are already in the
document add nothing when they arrive again, over websocket or git. Anchor:
netsync.ts header. Spec: "optional live sync over websocket". -/
theorem T4_double_delivery (a b : ChangeSet) (h : ∀ c ∈ b, c ∈ a) : (a ++ b).equiv a := by
  intro c
  simp only [List.mem_append]
  constructor
  · rintro (h1 | h1)
    · exact h1
    · exact h c h1
  · exact Or.inl

theorem T4_view (a b : ChangeSet) (h : ∀ c ∈ b, c ∈ a) : view (a ++ b) = view a :=
  view_equiv _ _ (T4_double_delivery a b h)

theorem T4_self (a : ChangeSet) : view (a ++ a) = view a := T4_view a a (fun _ h => h)

/-- `saveDoc` with an empty delta writes nothing. Anchor: "A no-op delta
writes nothing". -/
theorem saveDoc_empty (hashOf : ChangeSet → String) (cs : List Chunk) :
    saveDoc hashOf cs [] = cs := by
  simp [saveDoc]

/-- `saveDoc` adds exactly the delta to what loads. -/
theorem saveDoc_load (hashOf : ChangeSet → String) (cs : List Chunk) (delta : ChangeSet) :
    (loadChunks (saveDoc hashOf cs delta)).equiv (loadChunks cs ++ delta) := by
  unfold saveDoc
  split
  · rename_i h
    have : delta = [] := List.isEmpty_iff.mp h
    subst this
    intro c; simp
  · intro c
    have := T3_compact_load hashOf (cs ++ [{ name := hashOf delta, kind := .changes, changes := delta }]) c
    rw [this]
    simp only [mem_loadChunks, List.mem_append, List.mem_singleton]
    constructor
    · rintro ⟨ch, h1 | h1, h2, h3⟩
      · exact Or.inl ⟨ch, h1, h2, h3⟩
      · subst h1; exact Or.inr h3
    · rintro (⟨ch, h1, h2, h3⟩ | h1)
      · exact ⟨ch, Or.inl h1, h2, h3⟩
      · exact ⟨_, Or.inr rfl, rfl, h1⟩

/-- **T5 Migration idempotence.** Migrating a migrated document changes
nothing. Anchor: `migrated`, `stale`. Spec: "Documents from before the
status field". -/
theorem T5_migrated_idem (d : LegacyDoc) : migrated (migrated d) = migrated d := by
  unfold migrated
  split
  · simp
  · rename_i h
    have hstale : (LegacyDoc.stale { d with
        schemaVersion := if d.schemaVersion < 3 then 3 else d.schemaVersion,
        specs? := some ((d.specs?.getD []).map fixSpec ++ (d.scenarios?.getD []).map convertScenario),
        scenarios? := none }) = false := by
      simp only [LegacyDoc.stale, LegacyDoc.entries, Option.getD_some, Option.isSome_none,
        Option.isNone_some]
      simp only [Bool.or_eq_false_iff, decide_eq_false_iff_not, Nat.not_lt, List.any_eq_false,
        List.mem_append, List.mem_map]
      refine ⟨⟨⟨by split <;> omega, trivial⟩, trivial⟩, fun x hx => ?_⟩
      simp only [Option.getD_none, List.not_mem_nil, or_false] at hx
      rcases hx with ⟨a, _, rfl⟩ | ⟨a, _, rfl⟩
      · simp only [fixSpec]
        split <;> split <;> simp_all
      · simp [convertScenario]
    simp [hstale]

/-- **T5 (identity is preserved).** Migration keeps every entry's id, name,
version, body and tests, in order. -/
theorem T5_migrated_fields (d : LegacyDoc) :
    ((migrated d).entries).map (fun e => (e.id, e.name, e.version, e.body, e.tests)) =
      d.entries.map (fun e => (e.id, e.name, e.version, e.body, e.tests)) := by
  unfold migrated
  split
  · rfl
  · simp only [LegacyDoc.entries, Option.getD_some, Option.getD_none, List.append_nil,
      List.map_append, List.map_map]
    congr 1
    apply List.map_congr_left
    intro e _
    simp only [Function.comp, fixSpec]
    split <;> split <;> rfl

end SpecDriven.Sync

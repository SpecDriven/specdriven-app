# Report: Lean 4 verification of the sync core

Lean 4.34.1, core only (no Mathlib). `lake build` passes; `sorry` appears
only in `SpecDriven/Sync/Theorems/Open.lean`. The differential test replays
750 vectors through the model with zero mismatches. One finding led to a
change under `src/`: the published case of H2 (section 2) is fixed by
recording the body a scenario is published with (`schema.ts`
`publishedBody`) and holding, rendering and healing the entry to it; the
model mirrors it (`SpecEntry.publishedBody`, `effectiveBody`,
`healPublished`). Theorem ids and informal statements are those of
`docs/lean-sync-verification-prompt.md`; Lean names live under
`SpecDriven/Sync/Theorems/`.

## 1. Proved

- **T1** `loadDoc` over any permutation of a dependency-closed chunk set
  yields the same document. `T1_load_perm`, `T1_view_perm`.
- **T2** Two peers whose chunk sets have the same union load equal
  documents; appending the same chunk on both keeps them equal.
  `T2_union_convergence`, `T2_append`.
- **T3** `compactDoc` loads to the same change set and the same document;
  unreadable chunks are never dropped; a concurrent chunk on top of the
  pre-compaction set loads to the same document after compaction; closure
  survives. `T3_compact_load`, `T3_compact_view`,
  `T3_compact_keeps_unreadable`, `T3_compact_concurrent`, `T3_compact_closed`.
- **T4** Delivering changes the document already holds changes nothing.
  `T4_double_delivery`, `T4_view`, `T4_self`.
- **T5** `migrated` is idempotent and leaves ids, names, versions, bodies and
  tests alone. `T5_migrated_idem`, `T5_migrated_fields`.
- **T6** `mergeScenario`'s status is at least as far along as either input
  and equal to one of them; published sticks. `T6_status_latch`,
  `T6_published_sticks`.
- **T7** Per key: `theirs = base` returns ours, `ours = base` returns theirs,
  and a conflict arises exactly when one side deleted what the other changed.
  `T7_theirs_is_base`, `T7_ours_is_base`, `T7_conflict_iff`. (Stated per
  key over `mergeKey`; the whole-feature form needs the T12 permutation
  argument and is not claimed.)
- **T8** When strict returns ok it equals lenient; when it conflicts, some
  text field changed on both sides to different values; same for pages.
  `T8_strict_ok`, `T8_strict_conflict`, `T8_page_strict_ok`.
- **T9** `threeWayPage` is total and every metadata field of its result is
  one of the three inputs. `T9_assigned`, `T9_done`, `T9_kind`,
  `T9_supersedes`, `T9_body_theirs_unchanged`.
- **T10** With `force` false and `reconcile` returning ok, every published
  entry survives with the same id, name, version and status, and with the
  body it was published with: its live `body` becomes that recorded body
  (the gate holds the file to `effectiveBody`, so a live text a merge
  doubled is healed here, not kept) and the recorded body is unchanged.
  `T10_published_kept`, through `T10_published_claimed`, `keyPass_claims`
  (the key pass claims an entry whose key the target carries),
  `idClaim_start` (the editor's claim leaves such an entry claimed by its
  own key's scenario or untouched) and `claimPass_grows` (plans only
  grow). Premise made explicit: keys are unique among the document's
  entries and among the target's scenarios. Without it the statement is
  false in the model: two published entries with one key and one body both
  pass the gate, the key pass claims the single target scenario for the
  first, and the second is removed — which is the right repair for the
  duplicate-entry state H2's variant can produce, but not "every published
  entry survives".
- **T11** An unclaimed draft stays with id and body; a claimed entry keeps
  its id. `T11_draft_kept`, `T11_claimed_keeps_id`.
- **T14** With the editor's hint naming an unpublished entry and a target
  scenario carrying the hint's key that no other entry carries, the result
  keeps that entry's id under the new key. `T14_rename_keeps_id`.
- **T15** The plan is a function of document, target and hint (a `def`);
  it names each entry index at most once and each target scenario at most
  once, naming only target scenarios and valid indices. `T15_plan_inv`.
- **T16** The drift pass leaves every feature `Consistent` (file is a
  projection of its document, or both absent, or the file malformed), and a
  second pass with no new input is the identity. The pass now heals every
  published entry's live body to its recorded one before it looks at the
  file; the projection reads the recorded body, so the heal is invisible to
  `isProjectionOf` (`isProjectionOf_heal`), and every document the pass
  writes is already healed (`importDriftOne_healed`), which is what makes
  the second pass the identity. `T16_consistent`, `T16_idempotent`.
- **T17** While a merge is in progress the tick is the resolve pass alone.
  `T17_no_drift_while_merging`.
- **T18** A feature whose file is gone loses its document and the file is
  not recreated. `T18_deleted`.
- **T19** A refused absorb leaves the document unchanged beyond the heal
  that precedes every absorb, and rewrites the file to the document's
  projection — the recorded published bodies, which the heal does not move
  (`projectFeature_heal`). `T19_refused_unchanged`, `T19_refused_repairs`.
- **T20** With operations arrived and no lineage race, the conflicted file
  resolves to the merged document's projection, and two peers holding the
  same merged document write the same bytes. `T20_ops_arrived`,
  `T20_same_bytes`.
- **T21 (structure)** The docid path resolves to the loaded document's id;
  on a lineage race the feature path folds ours and then theirs three-way,
  whatever `opsArrived` says. `T21_docid`, `T21_both_folds`. Survival is
  open (section 3).
- **T22** For a save over an unabsorbed disk edit exactly one of: the disk
  edit is already a projection (nothing to fold), it tampers with a
  published scenario (left for the drift pass, which refuses and repairs by
  T19), it folds in, or the save fails with the strict-conflict error.
  `T22_trichotomy`.
- **H3** (refuted as a divergence) Two peers whose three-way resolutions
  differed in bytes each pushed operations with them; the next pull on
  either side takes the ops-arrived branch, which depends on neither
  side's bytes nor `mergeText`'s choice, so both re-project the same merged
  document: converged after one more pull per peer.
  `H3_second_pull_converges`. Caveat: that merged document is the CRDT
  merge of two different `updateText` splices on the same field, so the
  converged text can carry a fragment twice (H2's duplication); the drift
  pass heals it, published or not (section 2, H2).
- **H5** (refuted) A chunk built on an older head arriving after this peer
  compacted loads to the same document, and closure survives: no peer sees
  a document missing the lagging change. `H5_no_change_lost`, `H5_closed`.

## 2. Disproved

### H1 Mixed-origin conflict — confirmed in the model, fixed in production

Lean: `H1_resolution_ignores_theirs` (the model's ops-arrived resolution does
not depend on the markdown that arrived), `H1_never_absorbed` (the model
leaves the file equal to the projection, so no later drift pass sees the
edit). Those theorems still hold of `Protocol.lean` `autoResolveOne`, which
skips the three-way when `opsArrived`. Production no longer skips:
`driftSync.ts` always folds theirs, with overlapping text kept from the
merged document (`merge.ts` `ours`) so a character merge cannot splice an
insertion the CRDT already applied, and fields still at the merge base taken
from theirs. Test: `tests/automerge/leanHypotheses.test.ts`, "H1: a hand edit
riding a push with operations is absorbed by the ops-arrived resolution".

1. A and B share a feature with scenarios Alpha and Beta.
2. B saves Alpha through the app (chunk files written) and, before any
   tick, hand-edits Beta in the same file; B commits both and pushes.
3. A saves Alpha through the app (an adjacent line) and ticks twice.
4. A's pull conflicts on the markdown. `theirsBroughtChunks` is true. The
   fold keeps Alpha from the merged document (both app edits) and takes
   Beta from theirs (the hand edit).
5. A commits and pushes the resolution; B pulls it. Both peers and both
   documents hold the hand edit.

The same fold applies to pages (`autoResolvePage`). A remaining caveat,
true of `ours` overlap: a hand edit of a field the CRDT also changed is
kept from the document, not merged character-level — so a further body
edit on the same scenario as an in-app save in that push is still dropped.
The confirmed defect was a *different* scenario (or page metadata field)
riding the same commit.

The Lean model is not restated here; T20 still proves the old skip.

### H2 Concurrent absorb duplicates text — confirmed, and fixed for the published case

Lean: `H2_doubled` (the merged field is longer than the text both peers
absorbed), `H2_heals` (an entry claimed by its key takes the file's body
back), `H2_name_description_heal`, `H2_tamper_refused` (a file whose
scenario carries a published entry's key but not its recorded body fails
the gate), `H2_publish_gate_passes` (a published entry recording `b` passes
the gate against a file carrying `b`, whatever its live body reads),
`H2_publish_heals` (and the absorb heals it), `H2_publish_heals_on_tick`
(the drift pass on the doubled-but-published document heals its live body
and leaves the file alone). Tests: same file, "H2: concurrent absorbs
double the text in the document, and the next drift pass heals it" and "H2:
a publish between two concurrent absorbs heals to the published body" —
the second was `test.failing` until the fix below.

The duplication itself is inherent: two actors running `updateText` to the
same longer text on two forks merge to a longer text (axiom
`Text.concurrent_update_grows`), and the design already relies on the drift
pass to heal it. What was broken is that publishing recorded nothing: the
gate could only compare the file to the current live text, so it could not
tell a merge artifact (file right, document wrong) from tampering (document
right, file wrong), assumed tampering, and locked the artifact in. The trace
that did so (steps 1–5 unchanged; the old step 6 follows):

1. A and B share a feature with one proposed scenario.
2. A markdown-only commit (a merged PR) changes the scenario body on origin.
3. A pulls and runs the drift pass; B runs the drift pass. Each mints its own
   `updateText` splice for the same insertion; neither has pushed.
4. A publishes the scenario (status published, body once) and pushes.
5. B ticks: its chunks and A's merge. The document holds the insertion twice
   and is published; the file (A's) holds it once.
6. (Before the fix.) B's drift pass: not a projection, so `absorbDrift` ran
   `assertPublishedKept`: same key, published, body differs — refused. The
   file was rewritten to the doubled projection, committed and pushed; A
   pulled it. Both documents and both files read "- line two, edited on
   GitHub, edited on GitHub", published, with no path back. Violated:
   "published scenarios stay immutable" — the published body was not the
   one that was published.

**The fix.** Publishing records the body: `SpecEntry.publishedBody`, an
Automerge `ImmutableString` (a `str` scalar set whole, last writer wins,
never spliced), stamped whenever `reconcile` matches an entry to a published
target scenario and by `newEntry` for a scenario imported published, cleared
when a forced resolution demotes the entry. A published entry's
`effectiveBody` is its recorded body when it has one, its live `body`
otherwise (entries published before the key existed, stamped by their first
reconcile). The gate compares the file to `effectiveBody`; the projection
renders `effectiveBody`; and `importDrift` runs `healPublished` first,
before any look at the file, driving each published entry's live `body`
back to its recorded one. Step 6 now reads: B's file (A's) carries the
recorded body, so it is a projection of B's document; the pass heals the
live text, saves the heal, and writes nothing to the file
(`H2_publish_heals_on_tick`). Without step 4 the next drift pass heals as
before (`H2_heals`). Name and description always heal
(`H2_name_description_heal`).

Heal-first, rather than inside the absorb, is what bounds the mixed-version
case: a peer on an older build still renders the doubled live text and
pushes a doubled file; here that file is drift against the recorded body,
refused and repaired, and the heal saved in the same tick reaches the old
peer, whose live text then reads single and whose file is then a
projection. Without the heal the two peers would rewrite the file against
each other every tick.

Caveats of the fix, all noted in the code:

- Already-locked duplicates (a published body doubled before this change)
  are not repaired: their recorded body, stamped lazily, is the doubled
  live text. Repair is the forced conflict-resolution door, or a new
  version. The fix prevents new ones.
- Two peers publishing the same scenario concurrently with different bodies
  used to merge character-level into a text nobody wrote; now one recorded
  body wins, the same one on every peer, and the heal removes the other's
  text from the live field.
- The live text and the recorded body are two representations of one body,
  equal except between a merge and the next drift pass; neither the file
  nor the API nor the editor ever sees the live one while the entry is
  published. Concurrent heals from different merged states can
  over-delete and re-insert in the live text until a pull aligns the peers;
  invisible, since the projection is the recorded body.
- A legacy published entry's first reconcile issues one
  `entrySetPublishedBody` op; T13 is restated for stamped documents.

### H4 Same-body claim mis-match — confirmed for markdown-only edits

Lean: `H4_markdown_picks_first` (by `decide`: entries `a`, `b` with empty
bodies, target `c`; the plan is `[(0, c)]`), `H4_hint_picks_named` (with
the hint naming `b` the plan is `[(1, c)]`, T14). Test: same file, "H4: a
markdown-only rename of one of two same-body scenarios lands on the first
entry" (pins the behaviour; the ambiguity is inherent to the markdown, so
the test is not marked failing).

1. A document holds two proposed scenarios `a` and `b` with identical
   (empty) bodies.
2. An external edit renames `b` to `c` and keeps `a`'s text away — or
   renames `a` and deletes `b`; the markdown reads the same.
3. The drift pass: the key pass claims nothing; the body pass attaches `c`
   to entry 0 (`a`). `a`'s id, history and `prs` continue under `c`; `b`'s
   entry is removed.

Violates: no spec sentence directly; the editor path is right (T14). The
exposure is external renames of same-body scenarios, which move `prs`
links to the wrong scenario.

## 3. Open

All in `SpecDriven/Sync/Theorems/Open.lean`, each with `sorry`.

- **T12 `T12_reaches_target`** — `projectFeature (reconcile d target) =
  serializeFeature (parseFeature target)` for a draft-free, unique-key
  target over a unique-key document passing the gate. Blocked on (a) the
  closure of the key pass over all entries at once (`keyPass_claims` is per
  entry; needed: every target scenario is matched after the key pass when
  every target key is an entry key, so `addedSpecs` and the body pass are
  trivial) and (b) a permutation argument that `sortScenarios` of
  kept-then-added entries equals `sortScenarios target`, over
  `List.mergeSort` without Mathlib.
- **T13 `T13_fixpoint`** — `reconcile d (parseFeature (projectFeature d))`
  issues no operation, for a `Stamped` document (every published entry
  records its body; a legacy entry's first pass issues the one stamp op).
  Blocked on the same closure: each non-draft entry is
  claimed by `entryToScenario` of itself (for which `updateEntry` is
  `[]`), no draft is claimed, nothing is added or deleted, and the
  name/description/link/assigned comparisons are reflexive. Every piece is a
  fold invariant in the style of `keyPass_fold`; not combined in the time
  available. The differential test exercises this fixpoint on every vector
  whose target is the document's own projection with no mismatch.
- **T21 `T21_survival`** — on a lineage race with both folds ok, every
  scenario added on either side survives in the resolved document. Blocked
  on a merge-layer lemma (`threeWayFeature` keeps a key present on one side
  and absent from the base — `mergeKeys` over `keyUnion`) and on "reconcile
  adds every unclaimed target key" (`addedSpecs`); neither attempted.

Never attempted beyond the per-key form: the whole-feature statement of T7.

## 4. Axioms

Every `axiom` is in `SpecDriven/Sync/Crdt.lean`. `Git.lean` states its four
git assumptions in prose only; the protocol takes a pull's outcome as data
(`Pulled`). `Merge.lean` declares `charMerge` `opaque` (not an axiom:
`mergeText`'s character-level tie-break on actor ids is never unfolded;
every merge theorem holds for any implementation of it). The hypothesis
examples use `decide`, so no `Lean.ofReduceBool`. Lean's own `propext`,
`Classical.choice`, `Quot.sound` appear as usual.

| Axiom | Stands for | Discharge |
|-------|------------|-----------|
| `State`, `view : ChangeSet → State` | An Automerge document as the value of a set of changes. | Definitional: `A.load`/`A.applyChanges` of a change list. |
| `view_equiv` | Two change sets with the same members load to the same document (commutative, idempotent apply). | Property test: shuffle and duplicate a change list, `A.applyChanges`, compare `A.save`. |
| `saveSince : ChangeSet → List Nat → ChangeSet` | `A.saveSince(doc, heads)`. | Definitional. |
| `saveSince_deps` | A delta's dependencies are within the document it was taken from plus the delta. | Property test: `A.decodeChange` every change in `saveSince`, check `deps ⊆ getAllChanges ∪ delta`. |
| `Text`, `Text.view`, `Text.update`, `Text.merge` | One collaborative text field, `A.updateText`, document merge. | Definitional. |
| `Text.update_view` | After `updateText(d, path, s)` the field reads `s`. | `updateText`'s contract; property test. |
| `Text.concurrent_update_grows` | Two actors running `updateText` to the same longer text on two forks merge to something longer than that text. | Property test: `A.clone` twice, `updateText` both to the same string, `A.merge`, compare lengths. Observed directly in the H2 trace (", edited on GitHub, edited on GitHub"). |

Used by: T2 (`State`, `view`, `view_equiv`); T4 and `saveDoc_load`
(`saveSince`, `saveSince_deps`); H2 (`Text.*`). T1, T3, T5–T22, H1, H3–H5
depend on no axiom beyond Lean's.

# Lean 4 verification of the sync core

A Lean 4 model of SpecDriven's sync mechanism — content-addressed Automerge
chunks in git, `.feature.md` projections, the sync tick — with proofs of the
properties the specs promise and traces of the places the implementation
falls short. The plan it executes is `docs/lean-sync-verification-prompt.md`;
the findings are in [REPORT.md](REPORT.md).

## Running it

```bash
# Lean 4.34.1 via elan (https://github.com/leanprover/elan)
cd verification/lean && lake build            # the library and the vector checker
bun test tests/automerge/leanModel.test.ts    # 750 differential vectors through `lake exe check-vectors`
bun test tests/automerge/leanHypotheses.test.ts   # H1, H2, H4 against the real implementation
```

`lake build` passes with `sorry` only in `SpecDriven/Sync/Theorems/Open.lean`.
No file under `src/` was changed.

## Layout

```
lakefile.toml, lean-toolchain
SpecDriven.lean                      library root
SpecDriven/Sync/Schema.lean          FeatureDoc, SpecEntry, Feature, Scenario, keys
SpecDriven/Sync/Projection.lean      sortScenarios, serializeFeature, parseFeature, projectFeature, isProjectionOf
SpecDriven/Sync/Merge.lean           mergeText (charMerge opaque), threeWayFeature(Strict), threeWayPage(Strict)
SpecDriven/Sync/Reconcile.lean       the match plan (id, key, body passes), applyPlan, reconcile, absorbDrift
SpecDriven/Sync/Crdt.lean            Automerge as change sets: every axiom of the verification
SpecDriven/Sync/Store.lean           chunks, loadChunks, compactDoc, saveDoc, migrated
SpecDriven/Sync/Git.lean             Pulled: what a pull delivers; the git assumptions, stated
SpecDriven/Sync/Protocol.lean        autoResolveOne, importDriftOne, tick, foldDiskEdit, Consistent
SpecDriven/Sync/Theorems/Store.lean      T1–T5
SpecDriven/Sync/Theorems/Merge.lean      T6–T9
SpecDriven/Sync/Theorems/Reconcile.lean  T10, T11, T14, T15 and the fold invariants
SpecDriven/Sync/Theorems/Protocol.lean   T16–T22
SpecDriven/Sync/Theorems/Hypotheses.lean H1–H5
SpecDriven/Sync/Theorems/Open.lean       T12, T13, T21 survival (sorry, with what blocks each)
Vectors.lean                         `check-vectors`: replays JSON vectors through the model
vectors/                             written by tests/automerge/leanModel.test.ts (gitignored)
```

Markdown is represented by its parse: a `Feature` is both "the text" and
"what `parseFeature` returns", `serializeFeature` is the normalization the
serializer performs and `parseFeature` the sort the parser performs. Random
actor ids are a `seed` to the opaque `charMerge`; fresh entry ids come from
a supply `fresh : Nat → String`.

## Differential test

`tests/automerge/leanModel.test.ts` generates 250 seeded vectors for each of
`threeWayFeature`, `threeWayFeatureStrict` and `reconcile`, records the
TypeScript outcome, and `lake exe check-vectors` replays them through the
model: zero mismatches. A deliberately broken model (key pass skipped) was
caught on 89 of 750 vectors, so the bridge sees model errors.

## Theorem index

Status: **proved** (`lake build`, no `sorry` on its path), **open** (in
`Open.lean`), **confirmed** / **refuted** for hypotheses.

| Id | Lean name(s) | TS anchor | Spec scenario | Status |
|----|--------------|-----------|---------------|--------|
| T1 Order-independent load | `T1_load_perm`, `T1_view_perm` | `store.ts` `chunkFiles`, `loadDoc` | Storage layout | proved |
| T2 Union convergence | `T2_union_convergence`, `T2_append` | `store.ts` `loadDoc` | two peers edit the same scenario concurrently | proved |
| T3 Compaction safety | `T3_compact_load`, `T3_compact_view`, `T3_compact_keeps_unreadable`, `T3_compact_concurrent`, `T3_compact_closed` | `store.ts` `compactDoc`, `skippedChunks` | — | proved |
| T4 Double delivery is a no-op | `T4_double_delivery`, `T4_view`, `T4_self` | `netsync.ts` header | optional live sync over websocket | proved |
| T5 Migration idempotence | `T5_migrated_idem`, `T5_migrated_fields` | `store.ts` `migrated` | Documents from before the status field | proved |
| T6 Status latch | `T6_status_latch`, `T6_published_sticks` | `merge.ts` `STATUS_RANK`, `mergeScenario` | draft scenarios live in the document only | proved |
| T7 Three-way identities | `T7_theirs_is_base`, `T7_ours_is_base`, `T7_conflict_iff` | `merge.ts` `threeWayFeature` | — | proved (per key) |
| T8 Strict refines lenient | `T8_strict_ok`, `T8_strict_conflict`, `T8_page_strict_ok` | `merge.ts` `threeWayFeatureStrict`, `threeWayPageStrict` | — | proved |
| T9 Pages never conflict | `T9_assigned`, `T9_done`, `T9_kind`, `T9_supersedes`, `T9_body_theirs_unchanged` | `merge.ts` `threeWayPage` | — | proved |
| T10 Published immutability | `T10_published_kept` (via `T10_published_claimed`, `keyPass_claims`, `idClaim_start`) | `reconcile.ts` `assertPublishedKept`, `reconcile` | published scenarios stay immutable | proved (unique keys on both sides) |
| T11 Drafts survive markdown | `T11_draft_kept`, `T11_claimed_keeps_id` | `reconcile.ts` removal loop | draft scenarios live in the document only | proved |
| T12 Reconcile reaches the target | `T12_reaches_target` | `reconcile.ts` doc comment | — | open |
| T13 Projection fixpoint | `T13_fixpoint` | `store.ts` `saveDoc` no-op delta | — | open (differential test covers it) |
| T14 Identity stability under rename | `T14_rename_keeps_id` | `reconcile.ts` `scenario?.id` claim | — | proved |
| T15 Match plan determinism | `T15_plan_inv` (`Plan.Inv`) | `reconcile.ts` `claim`, `matchAt`, `matched` | — | proved |
| T16 Tick preserves the projection invariant | `T16_consistent`, `T16_idempotent` | `reload.ts` `syncDataDir`, `driftSync.ts` `importDrift`, `isProjectionOf` | markdown edited outside the app | proved |
| T17 No absorption during merge | `T17_no_drift_while_merging` | `reload.ts` `mergeInProgress` guard | — | proved |
| T18 Deletion carries intent | `T18_deleted` | `driftSync.ts` `importDrift` second loop | A feature file deleted outside the app | proved |
| T19 Refused drift repairs | `T19_refused_unchanged`, `T19_refused_repairs` | `driftSync.ts` `refused` branch | published scenarios stay immutable | proved |
| T20 Concurrent edits converge | `T20_ops_arrived`, `T20_same_bytes` | `driftSync.ts` `autoResolveOne` ops-arrived branch | two peers edit the same scenario concurrently | proved |
| T21 Lineage race resolution | `T21_docid`, `T21_both_folds` proved; `T21_survival` | `driftSync.ts` `autoResolveOne`, `featureFileOfDocidPath` | a repo that predates documents | structure proved, survival open |
| T22 Disk edits are never dropped silently | `T22_trichotomy` | `features.ts` `foldDiskEdit` | — | proved |
| H1 Mixed-origin conflict | `H1_resolution_ignores_theirs`, `H1_never_absorbed` | `autoResolveOne` `opsArrived` | markdown edited outside the app | **confirmed** — `tests/automerge/leanHypotheses.test.ts` |
| H2 Concurrent absorb duplicates text | `H2_doubled`, `H2_heals`, `H2_name_description_heal`, `H2_publish_blocks_heal`, `H2_publish_locks_duplicate` | `reconcile.ts` `A.updateText`, `absorbDrift` | published scenarios stay immutable | doubles, heals when unpublished; **confirmed** permanent after a publish |
| H3 Nondeterministic `mergeText` | `H3_second_pull_converges` | `merge.ts` `mergeText`, `autoResolveOne` | two peers edit the same scenario concurrently | refuted: converges in two more pulls (caveat in REPORT) |
| H4 Same-body claim mis-match | `H4_markdown_picks_first`, `H4_hint_picks_named` | `reconcile.ts` body `claim` pass | — | **confirmed** for markdown-only edits; editor path correct |
| H5 Compaction versus a lagging peer | `H5_no_change_lost`, `H5_closed` | `store.ts` `compactDoc`, `loadDoc` pending changes | Storage layout | refuted: safe |

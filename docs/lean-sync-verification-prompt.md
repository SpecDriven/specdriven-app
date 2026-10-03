# Prompt: Lean 4 verification of the SpecDriven sync mechanism

Paste everything below the line into a fresh Claude Code session opened on
this repository. It is written for an agent that has not seen the codebase.

---

## Role and goal

You are formally verifying the synchronization mechanism of the SpecDriven
app in Lean 4. The mechanism keeps a set of Automerge CRDT documents, their
Markdown projections (`.feature.md` files) and a git repository shared by many
peers in agreement. Your job is to build a faithful executable model of the
app's own sync logic in Lean, state its safety invariants as theorems, prove
the ones that hold, and produce a concrete counterexample trace for any that
do not. A disproved theorem is a more valuable result than a proved one. Try
to break each statement before you try to prove it.

The output is a Lean project under `verification/lean/`, a differential test
that checks the Lean model against the TypeScript implementation, and a report.

## Read first, in this order

Spec (the source of truth for intended behaviour):

- `/Users/I574426/dev/personal/SpecDriven/specs-specdriven/specs/datastore/automerge-store.feature.md`
  (the `specs/` symlink inside a worktree dangles, so use this absolute path)
- `docs/ARCHITECTURE.md`, section "Storage"

Implementation, pure core (translate these faithfully):

- `src/server/automerge/schema.ts` — `FeatureDoc`, `SpecEntry`, `PageDoc`
- `src/server/automerge/merge.ts` — `mergeText`, `mergeScenario`,
  `threeWayFeature`, `threeWayFeatureStrict`, `threeWayPage`,
  `threeWayPageStrict`, `STATUS_RANK`
- `src/server/automerge/reconcile.ts` — `assertPublishedKept`, `reconcile`
  (the match plan: id claim, (name, version) claim, same-body claim; updates,
  descending removals that skip drafts, additions), `removeDraftScenario`,
  `setPullRequests`
- `src/server/automerge/project.ts` — `docToFeature`, `projectFeature`,
  `isProjectionOf`, the `publishExternalLinks` option
- `src/server/parser.ts` — `parseFeature`, `serializeFeature`,
  `sortScenarios`, `featureTextError` (model only what projection needs)

Implementation, storage and protocol (model the control flow, axiomatize
Automerge and git):

- `src/server/automerge/store.ts` — `chunkFiles` (sorted), `loadDoc`
  (merge every chunk, skip unreadable ones, pre-migration heads), `saveDoc`
  (`saveSince` delta, content-hashed write-once chunk), `compactDoc`
  (`COMPACT_AT`, deletes only chunks that loaded), `migrated`
- `src/server/automerge/driftSync.ts` — `autoResolveMergeConflicts`,
  `autoResolveOne` (the three branches: ops arrived, markdown only, lineage
  race), `theirsBroughtChunks`, `importDrift`, `absorbDrift`,
  `mergeInProgress`
- `src/server/reload.ts` — `syncDataDir`, the tick order
- `src/server/features.ts` — `saveFeature`, `foldDiskEdit`,
  `assertPublishedUnchanged`
- `src/server/automerge/netsync.ts` — header comment only; it exists so you
  model double delivery over two transports
- `src/server/git/backend.ts` — the `GitBackend` interface is the exact
  surface to axiomatize (`pull`, `resolveConflict` with `alsoAdd`,
  `syncSavedChanges`, `stageVersion` 1/2/3, `diffNames`, `existsIn`)

Existing tests are the behavioural oracle. Run them alone before anything
else, since the git-engine tests hang under load when run with the full suite:

```bash
bun test tests/automerge
```

Read `tests/automerge/automergeSync.test.ts` and
`tests/automerge/automergeStore.test.ts` closely. Every scenario they exercise
should correspond to a lemma or a differential test vector.

## Abstraction boundary

Model exactly, as executable Lean definitions:

- All of `merge.ts`, `reconcile.ts`, `project.ts` except `mergeText`.
- The chunk store as a finite set of named chunks plus a `docid`, and
  `loadDoc`, `saveDoc`, `compactDoc` over it.
- The tick (`syncDataDir`) and `autoResolveOne` as a transition system over
  peers, a remote, and external editors.

Axiomatize, in one file `Crdt.lean`, with every axiom justified in a comment:

- An abstract document type `Doc` with `merge : Doc → Doc → Doc` forming a
  join-semilattice (commutative, associative, idempotent) and a change set
  model: `Change`, `apply`, `saveSince heads doc : List Change`,
  `loadIncremental`. Loading a chunk whose dependencies are absent is held
  pending, as Automerge does, so state and use a dependency-closure predicate.
- `mergeText base ours theirs`. Required equations: the three short circuits
  in `merge.ts` (theirs = base, theirs = ours, ours = base). Required
  property: the result contains both sides' insertions. Do not assume the
  result is deterministic across peers. `A.from` and `A.clone` mint random
  actor ids, and concurrent inserts at one position tie-break on actor id, so
  two peers computing `mergeText` on the same inputs may get different bytes.
  Carry this as an explicit nondeterminism in the model.
- `updateText doc path newText` applied on two forks of the same document
  with the same `newText` produces two concurrent sets of insert operations.
  Merging those forks does not yield `newText`; it yields text with the
  inserted characters duplicated. This is the single most important modeling
  decision. Model `updateText` as minting fresh operations, never as an
  idempotent assignment.
- Git as a per-path three-way merge over the repository's file set: same
  content both sides merges clean, one side changed merges clean, both
  changed differently conflicts on that path. Added files union. Deleted on
  one side and untouched on the other deletes. Chunk files are write-once and
  content-addressed, so two chunk directories always merge clean.

Everything else in the app (plugins, pages drift, test management, websocket
transport) is out of scope except where named in a theorem below.

## Theorems to state and prove

Each theorem names its TypeScript anchor and the spec scenario it discharges.
Write the informal statement as a doc comment above the Lean theorem.

Store layer:

- **T1 Order-independent load.** `loadDoc` over any permutation of the same
  dependency-closed chunk set yields the same `Doc`. Anchor: `chunkFiles`
  sorts, `loadDoc` folds. Spec: "Storage layout".
- **T2 Union convergence.** Two peers whose chunk sets have the same union
  after a pull load equal documents. Follows from T1 and semilattice axioms.
  Spec: "two peers edit the same scenario concurrently".
- **T3 Compaction safety.** `loadDoc (compactDoc s) = loadDoc s`; chunks in
  `skippedChunks` are never deleted; a concurrent chunk added by another peer
  on top of any sub-closure of `s` still loads to the same merged document
  after `compactDoc` on this peer. Anchor: `compactDoc`, the `applied` set.
- **T4 Double delivery is a no-op.** Applying a change set already contained
  in the document leaves it unchanged. Anchor: `netsync.ts` header. Spec:
  "optional live sync over websocket".
- **T5 Migration idempotence.** `migrated (migrated d) = migrated d`, and
  `migrated` leaves entry ids, names, versions, bodies and tests unchanged.
  Anchor: `store.ts` `migrated`. Spec: "Documents from before the status
  field".

Pure merge layer:

- **T6 Status latch.** `mergeScenario` yields a status at least as far along
  as either input and equal to one of them. Anchor: `STATUS_RANK`. Spec:
  "draft scenarios live in the document only", last sentence.
- **T7 Three-way identities.** `threeWayFeature base ours base` returns
  `ours`, and `threeWayFeature base base theirs` returns `theirs`, up to the
  normalization `docToFeature` performs. A conflict is returned exactly when
  one side deleted a scenario the other side changed. Anchor:
  `threeWayFeature`.
- **T8 Strict refines lenient.** When `threeWayFeatureStrict` returns ok its
  result equals `threeWayFeature`'s. When it conflicts, some text field was
  changed on both sides to different values. Same for the page variants.
  Anchor: `threeWayFeatureStrict`, `threeWayPageStrict`.
- **T9 Pages never conflict.** `threeWayPage` is total and every metadata
  field of its result equals one of the three inputs. Anchor:
  `threeWayPage`.

Reconcile layer:

- **T10 Published immutability.** If `reconcile doc target` returns without
  error and `force` is false, then for every entry `e` in `doc` with status
  published there is an entry in the result with the same id, same name,
  same version, status published and the same body. Anchor:
  `assertPublishedKept`, `reconcile`. Spec: "published scenarios stay
  immutable".
- **T11 Drafts survive markdown.** Every draft entry of `doc` that the match
  plan does not claim is present in the result with the same id and body and
  status draft. A claimed draft keeps its id. Anchor: the removal loop skips
  `status === "draft"`. Spec: "draft scenarios live in the document only".
- **T12 Reconcile reaches the target.** For a well-formed `target` (distinct
  (name, version) keys, no drafts), `projectFeature (reconcile doc target)`
  equals `serializeFeature (sortScenarios target)`. Anchor: `reconcile` doc
  comment, first sentence.
- **T13 Projection fixpoint.** `reconcile doc (parseFeature (projectFeature
  doc))` produces no operations: the saved delta is empty. Anchor:
  `saveDoc` "a no-op delta writes nothing". This is what makes a tick on an
  undrifted repo quiet.
- **T14 Identity stability under rename.** When `scenario.id` names an
  unpublished entry and the target holds a scenario with `scenario`'s name
  and version that no other entry carries, the result keeps that entry's id
  under the new name. Anchor: the `scenario?.id` claim block.
- **T15 Match plan determinism.** The match plan is a function of `doc`,
  `target` and `scenario` only. State and prove that no two target scenarios
  claim the same entry and no entry is claimed twice.

Protocol layer, over the transition system:

- **T16 Tick preserves the projection invariant.** Define
  `Consistent(repo)`: every committed `.feature.md` with a document is
  `isProjectionOf` that document in one of its two link forms. Prove that
  from any reachable state, one tick on a peer with no concurrent writes
  during the tick restores `Consistent` for its working tree, and a second
  tick with no new external input writes nothing. Anchor: `syncDataDir`,
  `importDrift`, `isProjectionOf`. Spec: "markdown edited outside the app".
- **T17 No absorption during merge.** `importDrift` is never invoked while
  `conflictedFiles` is non-empty. Prove it as a guard theorem over the tick.
  Anchor: `mergeInProgress`.
- **T18 Deletion carries intent.** After a pull that removed a feature file,
  the next tick removes its document directory and never recreates the file
  from the stale document. Anchor: `importDrift`'s second loop. Spec: "A
  feature file deleted outside the app".
- **T19 Refused drift repairs.** When `absorbDrift` refuses, the document is
  unchanged and the file is rewritten to the document's projection. Anchor:
  `importDrift`'s `refused` branch. Spec: "published scenarios stay
  immutable".
- **T20 Concurrent edits converge without a dialog.** Two peers on this app
  version edit the same scenario body, each saves, each pushes, the second
  pull conflicts on the markdown. `autoResolveOne` takes the ops-arrived
  branch and both edits appear in the resolved file on both peers,
  byte-identical. Spec: "two peers edit the same scenario concurrently".
- **T21 Lineage race resolution.** Two peers import the same feature
  concurrently with different docids. After the merge, `autoResolveOne` on
  the `docid` path writes the loaded document's id, and on the feature path
  takes the lineage-race branch so that every scenario present on either
  side and not conflicting survives. Spec: "a repo that predates
  documents".
- **T22 Disk edits are never dropped silently.** For `saveFeature`, exactly
  one of: the disk edit is folded into the save; the save fails with the
  strict-conflict error and the disk edit stays on disk; or the disk edit
  tampers with a published scenario and the next tick repairs it. Anchor:
  `foldDiskEdit`.

## Hypotheses to try to refute

These are places where the implementation may be weaker than the spec. For
each, build the trace in the transition system. If the model confirms the
problem, write the trace as a `bun test` under `tests/automerge/` that fails
against the real implementation, and record it in the report. Do not fix the
TypeScript; report.

- **H1 Mixed-origin conflict.** A peer on this app version saves a scenario
  through the app (producing chunks) and in the same push also hand-edits a
  different scenario in the same file (no chunks). The other peer's pull
  conflicts. `autoResolveOne` sees `opsArrived` true, skips the three-way
  merge, and re-projects from the merged document. Does the hand edit
  survive, or is it silently discarded until some later drift pass, and
  does that later pass even see it after the projection overwrote the file?
- **H2 Concurrent absorb duplicates text.** Two peers pull the same GitHub
  PR that changed a scenario body, and both tick before either pushes. Each
  `reconcile` mints its own `updateText` operations for the same new text.
  After their chunks meet, does the merged document hold duplicated text?
  Then: does the next `importDrift` self-heal, because the file (identical on
  both sides, so no markdown conflict) is no longer `isProjectionOf` the
  doubled document and `absorbDrift` drives the document back to the file?
  Prove the self-heal or exhibit a state where it does not happen, in
  particular when the doubled text belongs to the description, the feature
  name, or a scenario that became published between the two ticks.
- **H3 Nondeterministic `mergeText`.** Two peers each hold a different local
  unpushed commit and both pull the same remote markdown-only edit. Each
  resolves via the three-way branch and `mergeText` tie-breaks on random
  actor ids. Their resolutions may differ in bytes. Show whether the next
  pull between them conflicts again and whether the ops-arrived branch then
  converges them, and bound the number of ticks to convergence.
- **H4 Same-body claim mis-match.** Two unmatched entries with identical
  bodies (for example two empty-bodied scenarios) and a target that renamed
  only one of them. Does the same-body claim attach the rename to the wrong
  entry, moving edit history and `prs` links to the wrong scenario?
- **H5 Compaction versus a lagging peer.** Peer A compacts and deletes
  twelve change files. Peer B, who has not pulled those, pushes a change
  chunk built on an older head. Peer C pulls both. Is the chunk set still
  dependency-closed under the loader's pending-change semantics? Does any
  peer ever see a document missing B's change?

## Modeling rules

- Lean 4 with the current stable toolchain pinned in `lean-toolchain`. Use
  Lean core and `Std` or Batteries only. Do not add Mathlib; the build time
  is not worth it for finite structures.
- Represent scenarios and entries as `structure`s mirroring `schema.ts`,
  with `List` for ordered collections. Represent text as `String`; the
  character-level merge is axiomatized, not computed.
- Derive `DecidableEq` and `Repr` for every structure so that `decide`,
  `#eval` and the differential test all work.
- Every executable definition must be a direct translation of its TypeScript
  anchor. Keep the control flow shape recognisable: the same branches, the
  same loop order. Where TypeScript iterates a `Map` or `Set`, state the
  iteration order you chose and why it matches (insertion order).
- No `sorry` in the final deliverable. Any `axiom` lives in `Crdt.lean` or
  `Git.lean` with a justification comment and a reference to the Automerge
  or git behaviour it encodes.
- A theorem you cannot prove but believe true goes in `Open.lean` as a
  `theorem … := by sorry` with a comment stating what blocked you, and the
  report lists it. A theorem you disproved becomes a `example` exhibiting the
  counterexample with `decide` or `rfl`, and a failing `bun test`.
- Keep each Lean file under about 400 lines. Prefer `simp`, `omega`,
  `decide` and small lemmas over long tactic blocks.

## Differential test bridge

A model proof is only as good as the model's fidelity. Build
`verification/lean/Vectors.lean` and `tests/automerge/leanModel.test.ts`:

- The bun test generates JSON vectors by running the real TypeScript
  functions (`threeWayFeature`, `threeWayFeatureStrict`, `reconcile` followed
  by `projectFeature`, `assertPublishedKept`, `mergeScenario`) over a
  property-style corpus of at least 200 generated inputs, writes them to
  `verification/lean/vectors/*.json`, then runs `lake exe check-vectors` and
  asserts a zero exit.
- The Lean executable decodes the vectors, evaluates the model, and prints
  every mismatch with both outputs.
- Exclude `mergeText` on inputs where both sides changed the same text; those
  are nondeterministic by design and the vector should only check that the
  three short-circuit cases match.

## Project layout

```
verification/lean/
  lakefile.lean
  lean-toolchain
  README.md                 theorem index: id, Lean name, TS anchor, spec scenario, status
  REPORT.md                 findings, written last
  SpecDriven/Sync/
    Crdt.lean               axioms for Automerge
    Git.lean                axioms for the git backend
    Schema.lean             FeatureDoc, SpecEntry, PageDoc, Scenario, Feature
    Projection.lean         docToFeature, projectFeature, isProjectionOf
    Merge.lean              merge.ts
    Reconcile.lean          reconcile.ts
    Store.lean              chunk store, load, save, compact, migrate
    Protocol.lean           peers, remote, tick, autoResolveOne as transitions
    Theorems/Store.lean     T1–T5
    Theorems/Merge.lean     T6–T9
    Theorems/Reconcile.lean T10–T15
    Theorems/Protocol.lean  T16–T22
    Hypotheses.lean         H1–H5 traces, as examples or counterexamples
    Open.lean               anything left with sorry
  Vectors.lean              differential checker
```

## Phases

1. **Toolchain.** Lean is not installed here. Ask the user before installing
   `elan`; it is a software install on their machine. Once present, `lake
   build` an empty project to confirm the toolchain, and commit the pin.
2. **Pure core.** `Schema`, `Projection`, `Merge`, `Reconcile`. Then the
   differential bridge for these four, and run it until the model matches
   the implementation on every vector. Only then start proving T6–T15.
3. **Store.** `Crdt` axioms, `Store`, T1–T5.
4. **Protocol.** `Git` axioms, `Protocol`, T16–T22, then H1–H5.
5. **Report.** `REPORT.md` and `README.md`.

Do not start phase 3 while any phase 2 vector mismatches. A mismatch means
the model is wrong, and a proof over a wrong model is worthless.

## Report format

`REPORT.md` has four sections and nothing else:

1. **Proved.** Theorem id, one-line informal statement, the Lean name.
2. **Disproved.** Theorem or hypothesis id, the counterexample as a numbered
   trace of peer actions, the failing bun test's path, and the spec sentence
   it violates.
3. **Open.** What is in `Open.lean`, and what blocked each one.
4. **Axioms.** Every axiom, where it lives, and the Automerge or git
   behaviour it stands for, with a note on how it could be discharged
   (for example by a property test against the real Automerge library).

Report outcomes faithfully. A theorem is proved only when `lake build`
passes with no `sorry` on its path. If a phase is cut short, say which
theorems were never attempted.

## Done criteria

- `lake build` succeeds from a clean checkout with no warnings about `sorry`
  outside `Open.lean`.
- `bun test tests/automerge/leanModel.test.ts` passes.
- `README.md` lists all 22 theorems and 5 hypotheses with a status each.
- `REPORT.md` exists and follows the format above.
- Nothing under `src/` was changed. New tests under `tests/automerge/` are
  the only TypeScript additions.

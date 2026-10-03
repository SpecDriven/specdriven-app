import SpecDriven.Sync.Schema

/-!
# Git: what the model assumes of the git backend

`src/server/git/backend.ts` is the surface the sync tick uses. The protocol
model does not simulate git. It takes what a pull delivered for one feature
path as data (`Pulled`), in the terms `autoResolveOne` reads it:

- `conflicted`: the path is in `conflictedFiles` after the pull.
- `opsArrived`: `theirsBroughtChunks` — the other side added chunk files for
  this document in the same merge.
- `lineageRace`: this feature's `docid` file conflicted in the same merge.
- `base`, `ours`, `theirs`: `stageVersion` 1, 2 and 3 of the path, parsed
  (`theirsVersion` stands in for stage 3); `none` is "absent on that side".

Assumptions about git itself, stated here rather than proved:

1. **Chunk directories merge as a file-set union.** Chunk files are
   content-addressed and write-once (`store.ts`), so two peers never change
   the same chunk path and a merge adds both sides' files. This is what lets
   the store theorems (T2) speak of "the union of chunk files" and what
   `resolveConflict`'s `alsoAdd` relies on when it stages the doc dir into
   the merge commit.
2. **A path identical on both sides merges clean**; a path changed on one
   side only takes that side; a path changed differently on both sides is
   conflicted and the three stages are available. Standard git.
3. **A deletion on one side with no change on the other deletes.** This is
   why "deleted on one side" is left for the dialog and why a compaction's
   deletions of chunk files propagate.
4. **`resolveConflict` on the last conflicted path completes the merge
   commit and pushes**, so a peer that auto-resolved everything leaves no
   merge in progress for the drift pass to skip.
-/

namespace SpecDriven.Sync

/-- What one pull delivered for one feature path. -/
structure Pulled where
  conflicted : Bool
  opsArrived : Bool
  lineageRace : Bool
  base : Option Feature
  ours : Option Feature
  theirs : Option Feature
  deriving Repr

end SpecDriven.Sync

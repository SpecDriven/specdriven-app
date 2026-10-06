import Lean.Data.Json
import SpecDriven
/-!
# Differential checker

`lake exe check-vectors` replays the JSON vectors `tests/automerge/leanModel.test.ts`
generated from the TypeScript through the Lean model and prints every
mismatch. Exit code 0 means the model agreed on every vector.
-/

open Lean SpecDriven.Sync

deriving instance FromJson for Status
deriving instance FromJson for SpecType
deriving instance FromJson for ExternalLink
deriving instance FromJson for PullRequestLink
deriving instance FromJson for Scenario
deriving instance FromJson for Feature
deriving instance FromJson for SpecEntry
deriving instance FromJson for FeatureDoc
deriving instance FromJson for ScenarioPick
deriving instance FromJson for ScenarioTarget

structure ThreeWayResult where
  ok : Bool
  feature : Option Feature := none
  conflict : Option String := none
  deriving FromJson

structure ThreeWayVector where
  base : Feature
  ours : Feature
  theirs : Feature
  textClash : Bool
  result : ThreeWayResult
  deriving FromJson

structure ReconcileResult where
  ok : Bool
  projection : Option Feature := none
  specs : Option (List SpecEntry) := none
  feature : Option Feature := none
  conflict : Option String := none
  deriving FromJson

structure ReconcileVector where
  doc : FeatureDoc
  target : Feature
  force : Bool
  scenario : Option ScenarioTarget
  publishedKept : Bool
  healed : Option (List SpecEntry) := none
  result : ReconcileResult
  deriving FromJson

def readVectors (α : Type) [FromJson α] (file : String) : IO (List α) := do
  let text ← IO.FS.readFile file
  match Json.parse text >>= fromJson? with
  | .ok v => pure v
  | .error e => throw (IO.userError s!"{file}: {e}")

def checkThreeWay (strict : Bool) (file : String) : IO Nat := do
  let vs ← readVectors ThreeWayVector file
  let mut bad := 0
  for (i, v) in enumerate vs do
    let got := if strict then threeWayFeatureStrict 0 v.base v.ours v.theirs
               else threeWayFeature 0 v.base v.ours v.theirs
    match got, v.result.ok, v.result.feature with
    | .ok f, true, some want =>
      if !v.textClash && f != want then
        bad := bad + 1
        IO.println s!"{file}[{i}]: result differs\n  model: {repr f}\n  ts:    {repr want}"
    | .error _, false, _ => pure ()
    | .ok _, false, _ =>
      bad := bad + 1
      IO.println s!"{file}[{i}]: model merged, ts conflicted ({v.result.conflict.getD ""})"
    | .error e, true, _ =>
      bad := bad + 1
      IO.println s!"{file}[{i}]: model conflicted ({e}), ts merged"
    | _, _, _ =>
      bad := bad + 1
      IO.println s!"{file}[{i}]: malformed vector"
  IO.println s!"{file}: {vs.length} vectors, {bad} mismatches"
  pure bad

def checkReconcile (file : String) : IO Nat := do
  let vs ← readVectors ReconcileVector file
  let mut bad := 0
  for (i, v) in enumerate vs do
    let kept := publishedKept v.doc v.target
    if kept != v.publishedKept then
      bad := bad + 1
      IO.println s!"{file}[{i}]: publishedKept model={kept} ts={v.publishedKept}"
    if let some hs := v.healed then
      if (healPublished v.doc).specs != hs then
        bad := bad + 1
        IO.println s!"{file}[{i}]: healPublished differs\n  model: {repr (healPublished v.doc).specs}\n  ts:    {repr hs}"
    let got := reconcile (fun _ => "*") v.doc v.target v.force v.scenario
    match got, v.result.ok with
    | .ok (d, _), true =>
      let proj := projectFeature d true
      if some proj != v.result.projection then
        bad := bad + 1
        IO.println s!"{file}[{i}]: projection differs\n  model: {repr proj}\n  ts:    {repr v.result.projection}"
      if some d.specs != v.result.specs then
        bad := bad + 1
        IO.println s!"{file}[{i}]: specs differ\n  model: {repr d.specs}\n  ts:    {repr v.result.specs}"
      if some (docToFeature d) != v.result.feature then
        bad := bad + 1
        IO.println s!"{file}[{i}]: docToFeature differs\n  model: {repr (docToFeature d)}\n  ts:    {repr v.result.feature}"
    | .error _, false => pure ()
    | .ok _, false =>
      bad := bad + 1
      IO.println s!"{file}[{i}]: model reconciled, ts refused ({v.result.conflict.getD ""})"
    | .error e, true =>
      bad := bad + 1
      IO.println s!"{file}[{i}]: model refused ({e}), ts reconciled"
  IO.println s!"{file}: {vs.length} vectors, {bad} mismatches"
  pure bad

def main : IO UInt32 := do
  let a ← checkThreeWay false "vectors/threeWay.json"
  let b ← checkThreeWay true "vectors/threeWayStrict.json"
  let c ← checkReconcile "vectors/reconcile.json"
  pure (if a + b + c == 0 then 0 else 1)

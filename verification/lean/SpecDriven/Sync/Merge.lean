import SpecDriven.Sync.Schema
import SpecDriven.Sync.Projection

/-!
# Merge

`src/server/automerge/merge.ts`: the scenario-level three-way merge for
markdown that arrives without CRDT operations.

`mergeText` is the one function not translated. Its both-sides-changed case
runs Automerge's `updateText` on two forks of the base and merges them, and
`A.from` / `A.clone` mint random actor ids, so concurrent inserts at one
position tie-break differently on different peers. That case is `charMerge`,
an opaque function of an extra `seed` standing for the actor ids; the three
short-circuit cases are translated exactly.
-/

namespace SpecDriven.Sync

/-- The both-sides-changed case of `mergeText`, per peer (`seed`). Only the
axioms in `Crdt.lean` say anything about it. -/
opaque charMerge (seed : Nat) (base ours theirs : String) : String

/-- `mergeText` in merge.ts. -/
def mergeText (seed : Nat) (base ours theirs : String) : String :=
  if theirs == base || theirs == ours then ours
  else if ours == base then theirs
  else charMerge seed base ours theirs

/-- Both sides changed a text to different values. -/
def clash (b o t : String) : Bool := o != b && t != b && o != t

/-- `pick` inside `threeWayPage`: a set-whole value; the side that changed it
wins, ours when both did. -/
def pickValue {α : Type} [DecidableEq α] (b o t : Option α) (same : Option α → Option α → Bool) :
    Option α :=
  if !same t b && same o b then t else o

/-- `threeWayPage` in merge.ts. -/
def threeWayPage (seed : Nat) (base ours theirs : MarkdownPage) : MarkdownPage :=
  let eqS (x y : Option String) : Bool := (x.getD "") == (y.getD "")
  let eqB (x y : Option Bool) : Bool := (x.getD false) == (y.getD false)
  let eqN (x y : Option Nat) : Bool := (x.getD 0) == (y.getD 0)
  let eqL (x y : Option Supersedes) : Bool :=
    ((x.map (·.title)).getD "") == ((y.map (·.title)).getD "") &&
    ((x.map (·.url)).getD "") == ((y.map (·.url)).getD "")
  let eqK (x y : Option EntryKind) : Bool := x == y
  let assigned := pickValue base.assigned ours.assigned theirs.assigned eqS
  let estimate := pickValue base.estimate ours.estimate theirs.estimate eqN
  let done := pickValue base.done ours.done theirs.done eqB
  let author := pickValue base.author ours.author theirs.author eqS
  let date := pickValue base.date ours.date theirs.date eqS
  let kind := pickValue base.kind ours.kind theirs.kind eqK
  let supersedes := pickValue base.supersedes ours.supersedes theirs.supersedes eqL
  { name := mergeText seed base.name ours.name theirs.name,
    body := mergeText seed base.body ours.body theirs.body,
    -- `if (assigned) merged.assigned = assigned`: an empty string is falsy.
    assigned := match assigned with | some "" => none | a => a,
    estimate := match estimate with | some 0 => none | e => e,
    done := match done with | some true => some true | _ => none,
    author := match author with | some "" => none | a => a,
    date := match date with | some "" => none | d => d,
    kind := kind,
    supersedes := supersedes }

/-- `threeWayPageStrict` in merge.ts. -/
def threeWayPageStrict (seed : Nat) (base ours theirs : MarkdownPage) :
    Except String MarkdownPage :=
  if clash base.name ours.name theirs.name then .error "the heading was changed on both sides"
  else if clash base.body ours.body theirs.body then .error "the text was changed on both sides"
  else .ok (threeWayPage seed base ours theirs)

/-- `mergeLink` in merge.ts. -/
def mergeLink (base ours theirs : Option ExternalLink) : Option ExternalLink :=
  if linkKey theirs != linkKey base && linkKey ours == linkKey base then theirs else ours

/-- `mergeScenario` in merge.ts: one scenario present on both sides. -/
def mergeScenario (seed : Nat) (base : Option Scenario) (ours theirs : Scenario) : Scenario :=
  let baseTests := (base.map (·.tests)).getD []
  let tests := if theirs.tests != baseTests && ours.tests == baseTests then theirs.tests else ours.tests
  let link := mergeLink (base.bind (·.link)) ours.link theirs.link
  { name := ours.name, version := ours.version,
    status := if ours.status.rank ≥ theirs.status.rank then ours.status else theirs.status,
    body := mergeText seed ((base.map (·.body)).getD "") ours.body theirs.body,
    tests := tests, id := none, link := link, prs := none }

/-- `sameScenario` in merge.ts: same body, status, tests and link. -/
def sameContent (a b : Scenario) : Bool :=
  a.body == b.body && a.status == b.status && a.tests == b.tests && linkKey a.link == linkKey b.link

/-- `byKey`: a JS `Map` built from the list, so a repeated key keeps the last
value and the first position. -/
def byKey (f : Feature) : List (String × Nat × Scenario) :=
  f.scenarios.foldl (fun acc s =>
    if acc.any (fun (n, v, _) => n == s.name && v == s.version)
    then acc.map (fun (n, v, old) => if n == s.name && v == s.version then (n, v, s) else (n, v, old))
    else acc ++ [(s.name, s.version, s)]) []

def lookupKey (m : List (String × Nat × Scenario)) (k : String × Nat) : Option Scenario :=
  (m.find? (fun (n, v, _) => n == k.1 && v == k.2)).map (·.2.2)

/-- `new Set([...b.keys(), ...o.keys(), ...t.keys()])`: insertion order, first
occurrence kept. -/
def keyUnion (b o t : List (String × Nat × Scenario)) : List (String × Nat) :=
  (b ++ o ++ t).foldl (fun acc (n, v, _) => if acc.contains (n, v) then acc else acc ++ [(n, v)]) []

/-- One key of the `for` loop in `threeWayFeature`: the merged scenario to
keep, nothing, or the conflict. -/
def mergeKey (seed : Nat) (b o t : List (String × Nat × Scenario)) (k : String × Nat) :
    Except String (Option Scenario) :=
  match lookupKey o k, lookupKey t k with
  | some mine, some yours => .ok (some (mergeScenario seed (lookupKey b k) mine yours))
  | some mine, none =>
    match lookupKey b k with
    | none => .ok (some mine)
    | some was =>
      if sameContent mine was then .ok none
      else .error s!"scenario {k.1}@v{k.2} was edited here and deleted there"
  | none, some yours =>
    match lookupKey b k with
    | none => .ok (some yours)
    | some was =>
      if sameContent yours was then .ok none
      else .error s!"scenario {k.1}@v{k.2} was deleted here and edited there"
  | none, none => .ok none

/-- The loop itself, over the keys in `keyUnion` order. -/
def mergeKeys (seed : Nat) (b o t : List (String × Nat × Scenario)) :
    List (String × Nat) → Except String (List Scenario)
  | [] => .ok []
  | k :: ks => do
    let head ← mergeKey seed b o t k
    let rest ← mergeKeys seed b o t ks
    return (head.toList ++ rest)

/-- `threeWayFeature` in merge.ts. -/
def threeWayFeature (seed : Nat) (base ours theirs : Feature) : Except String Feature := do
  let b := byKey base
  let o := byKey ours
  let t := byKey theirs
  let scenarios ← mergeKeys seed b o t (keyUnion b o t)
  let assigned :=
    if (theirs.assigned.getD "") != (base.assigned.getD "") && (ours.assigned.getD "") == (base.assigned.getD "")
    then theirs.assigned else ours.assigned
  return { name := mergeText seed base.name ours.name theirs.name,
           description := mergeText seed base.description ours.description theirs.description,
           scenarios := scenarios,
           link := mergeLink base.link ours.link theirs.link, prs := none,
           assigned := match assigned with | some "" => none | a => a }

/-- The scenario loop of `threeWayFeatureStrict`: some scenario of ours has a
counterpart in theirs and the two bodies clash against the base. -/
def bodyClash (base ours theirs : Feature) : Bool :=
  let b := byKey base
  let t := byKey theirs
  ours.scenarios.any fun s =>
    match lookupKey t s.key with
    | some other => clash (((lookupKey b s.key).map (·.body)).getD "") s.body other.body
    | none => false

/-- `threeWayFeatureStrict` in merge.ts. -/
def threeWayFeatureStrict (seed : Nat) (base ours theirs : Feature) : Except String Feature :=
  if clash base.name ours.name theirs.name then
    .error "the feature name was changed on both sides"
  else if clash base.description ours.description theirs.description then
    .error "the feature description was changed on both sides"
  else if bodyClash base ours theirs then
    .error "a scenario was changed on both sides"
  else threeWayFeature seed base ours theirs

end SpecDriven.Sync

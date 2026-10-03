import SpecDriven.Sync.Schema
import SpecDriven.Sync.Projection

/-!
# Reconcile

`src/server/automerge/reconcile.ts`. `reconcile` returns the document after
the `A.change` block together with the list of operations that block issued,
so a theorem can say "no operation was produced" (`saveSince` then writes
nothing) rather than merely "the value is unchanged".

Fresh ids for added entries come from a supply `fresh : Nat → String`
(`randomUUID` in the TypeScript); theorems that need distinctness assume it
of the supply.
-/

namespace SpecDriven.Sync

/-- One operation the `A.change` block issues. `updateText` is the only one
whose concurrent application on two forks is not idempotent (Crdt.lean). -/
inductive Op where
  | updateName (new : String)
  | updateDescription (new : String)
  | setLink (link : Option ExternalLink)
  | setAssigned (member : Option String)
  | entryUpdateName (i : Nat) (new : String)
  | entrySetVersion (i : Nat) (v : Nat)
  | entrySetStatus (i : Nat) (s : Status)
  | entryUpdateBody (i : Nat) (new : String)
  | entrySetTests (i : Nat) (tests : List String)
  | entrySetLink (i : Nat) (link : Option ExternalLink)
  | deleteAt (i : Nat)
  | push (e : SpecEntry)
  deriving DecidableEq, Repr

/-- `newEntry` in reconcile.ts. -/
def newEntry (id : String) (s : Scenario) : SpecEntry :=
  { id := id, type := .scenario, name := s.name, version := s.version, status := s.status,
    body := s.body, tests := s.tests, link := s.link, prs := none }

/-- `importFeatureDoc` in reconcile.ts, with the identity the store mints. -/
def importFeatureDoc (docId : String) (fresh : Nat → String) (f : Feature) : FeatureDoc :=
  { schemaVersion := 3, id := docId, name := f.name, description := f.description,
    specs := (enumerate f.scenarios).map (fun (i, s) => newEntry (fresh i) s),
    link := f.link, prs := none, assigned := f.assigned }

def samePickE (e : SpecEntry) (p : ScenarioPick) : Bool :=
  e.name == p.name && e.version == p.version

def samePickS (s : Scenario) (p : ScenarioPick) : Bool :=
  s.name == p.name && s.version == p.version

/-- `assertPublishedKept`: every published entry survives under its key,
still published, body intact. -/
def publishedKept (d : FeatureDoc) (target : Feature) : Bool :=
  d.specs.all fun e =>
    e.status != .published ||
    match target.scenarios.find? (fun s => samePickS s ⟨e.name, e.version⟩) with
    | some s => s.status == .published && s.body == e.body
    | none => false

/-- The match plan: entry index ↦ target scenario, computed exactly as the
three `claim` passes do (the editor's id claim first, then by key, then by
body). A target scenario is claimed at most once, an entry at most once. -/
structure Plan where
  matchAt : List (Nat × Scenario) := []
  matched : List Scenario := []
  deriving Repr

def Plan.has (p : Plan) (i : Nat) : Bool := p.matchAt.any (·.1 == i)
def Plan.isMatched (p : Plan) (s : Scenario) : Bool := p.matched.contains s
def Plan.at? (p : Plan) (i : Nat) : Option Scenario := (p.matchAt.find? (·.1 == i)).map (·.2)

/-- One `claim` pass. `entries.forEach` in index order; for each unclaimed
entry, the first unmatched target scenario the candidate accepts. -/
def claimPass (entries : List SpecEntry) (target : Feature)
    (candidate : Scenario → SpecEntry → Bool) (p : Plan) : Plan :=
  (enumerate entries).foldl (fun p (i, e) =>
    if p.has i then p
    else match target.scenarios.find? (fun s => !p.isMatched s && candidate s e) with
      | some s => { matchAt := p.matchAt ++ [(i, s)], matched := p.matched ++ [s] }
      | none => p) p

/-- The `scenario?.id` claim block. -/
def idClaim (entries : List SpecEntry) (target : Feature) (scenario : Option ScenarioTarget)
    (p : Plan) : Plan :=
  match scenario with
  | some ⟨pick, some id⟩ =>
    let at? := (enumerate entries).find? (fun (_, e) => e.id == id)
    let claimed := target.scenarios.find? (fun s => samePickS s pick)
    match at?, claimed with
    | some (i, e), some s =>
      let blocked :=
        (enumerate entries).any (fun (j, e') => j != i && samePickE e' pick) ||
        (e.status == .published && !samePickE e pick)
      if blocked then p else { matchAt := [(i, s)], matched := [s] }
    | _, _ => p
  | _ => p

def plan (entries : List SpecEntry) (target : Feature) (scenario : Option ScenarioTarget) : Plan :=
  let p := idClaim entries target scenario {}
  let p := claimPass entries target (fun s e => samePickE e ⟨s.name, s.version⟩) p
  claimPass entries target (fun s e => s.body == e.body) p

/-- `assignLink` in reconcile.ts. -/
def assignLinkOps (before after : Option ExternalLink) (mk : Option ExternalLink → Op) : List Op :=
  if linkKey before == linkKey after then [] else [mk after]

/-- The `A.change` block of `reconcile`, given the plan: the ops it issues
and the document afterwards. Updates first, removals in descending index
order skipping drafts, additions last. -/
def applyPlan (fresh : Nat → String) (d : FeatureDoc) (target : Feature) (p : Plan) :
    FeatureDoc × List Op :=
  let nameOps := if d.name != target.name then [Op.updateName target.name] else []
  let descOps := if d.description != target.description then [Op.updateDescription target.description] else []
  let linkOps := assignLinkOps d.link target.link Op.setLink
  let assignedOps :=
    if (d.assigned.getD "") != (target.assigned.getD "") then [Op.setAssigned target.assigned] else []
  let updated : List (SpecEntry × List Op) := (enumerate d.specs).map fun (i, e) =>
    match p.at? i with
    | none => (e, [])
    | some m =>
      let ops :=
        (if e.name != m.name then [Op.entryUpdateName i m.name] else []) ++
        (if e.version != m.version then [Op.entrySetVersion i m.version] else []) ++
        (if e.status != m.status then [Op.entrySetStatus i m.status] else []) ++
        (if e.body != m.body then [Op.entryUpdateBody i m.body] else []) ++
        (if e.tests != m.tests then [Op.entrySetTests i m.tests] else []) ++
        assignLinkOps e.link m.link (Op.entrySetLink i)
      ({ e with name := m.name, version := m.version, status := m.status, body := m.body,
                tests := m.tests, link := m.link }, ops)
  let updateOps := updated.foldl (fun acc (_, ops) => acc ++ ops) []
  let kept := ((enumerate updated).filter fun (i, e, _) => p.has i || e.status == .draft).map (·.2.1)
  let deleteOps := (((enumerate d.specs).filter fun (i, e) => !p.has i && e.status != .draft).map (·.1)).reverse.map Op.deleteAt
  let additions := target.scenarios.filter (fun s => !p.isMatched s)
  let added := (enumerate additions).map fun (i, s) => newEntry (fresh i) s
  ({ d with name := target.name, description := target.description, link := target.link,
            assigned := match target.assigned with | some "" => none | a => a,
            specs := kept ++ added },
   nameOps ++ descOps ++ linkOps ++ assignedOps ++ updateOps ++ deleteOps ++ added.map Op.push)

/-- `reconcile` in reconcile.ts. -/
def reconcile (fresh : Nat → String) (d : FeatureDoc) (target : Feature)
    (force : Bool := false) (scenario : Option ScenarioTarget := none) :
    Except String (FeatureDoc × List Op) :=
  if !force && !publishedKept d target then
    .error "a published scenario is immutable"
  else
    .ok (applyPlan fresh d target (plan d.specs target scenario))

/-- `removeDraftScenario` in reconcile.ts. -/
def removeDraftScenario (d : FeatureDoc) (target : ScenarioPick) : Option FeatureDoc :=
  match (enumerate d.specs).find? (fun (_, e) => e.status == .draft && samePickE e target) with
  | none => none
  | some (i, _) => some { d with specs := d.specs.eraseIdx i }

/-- `absorbDrift` in driftSync.ts: reconcile, or refuse and keep the doc. -/
def absorbDrift (fresh : Nat → String) (d : FeatureDoc) (text : Feature) :
    FeatureDoc × Bool :=
  match reconcile fresh d (parseFeature text) with
  | .ok (d', _) => (d', false)
  | .error _ => (d, true)

end SpecDriven.Sync

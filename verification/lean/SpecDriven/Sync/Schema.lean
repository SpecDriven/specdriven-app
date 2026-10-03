/-!
# Schema

Lean mirrors of `src/server/parser.ts` (`Scenario`, `Feature`, `MarkdownPage`)
and `src/server/automerge/schema.ts` (`SpecEntry`, `FeatureDoc`, `PageDoc`).

Field order and optionality follow the TypeScript. Document-only fields that
never reach markdown (`id`, `prs`) are `Option`s on `Scenario`, as in
`parser.ts`.
-/

namespace SpecDriven.Sync

/-- `Array.prototype.entries`-style enumeration: (index, element) pairs. -/
def enumerate {α : Type} (l : List α) : List (Nat × α) :=
  l.zipIdx.map fun (a, i) => (i, a)

/-- `ScenarioStatus` in parser.ts. -/
inductive Status where
  | draft
  | proposed
  | published
  deriving DecidableEq, Repr, Inhabited

/-- `STATUS_RANK` in merge.ts: the lifecycle only moves forward. -/
def Status.rank : Status → Nat
  | .draft => 0
  | .proposed => 1
  | .published => 2

/-- `ExternalLink` in parser.ts. -/
structure ExternalLink where
  program : String
  ticket : String
  url : String
  deriving DecidableEq, Repr, Inhabited

/-- `PullRequestLink` in parser.ts. -/
structure PullRequestLink where
  url : String
  title : String
  deriving DecidableEq, Repr, Inhabited

/-- `Scenario` in parser.ts: what the parser reads from markdown, plus the
document-only handles the server adds (`id`, `prs`). -/
structure Scenario where
  name : String
  version : Nat
  status : Status
  body : String
  tests : List String
  id : Option String := none
  link : Option ExternalLink := none
  prs : Option (List PullRequestLink) := none
  deriving DecidableEq, Repr, Inhabited

/-- `Feature` in parser.ts. -/
structure Feature where
  name : String
  description : String
  scenarios : List Scenario
  link : Option ExternalLink := none
  prs : Option (List PullRequestLink) := none
  assigned : Option String := none
  deriving DecidableEq, Repr, Inhabited

/-- `SpecType` in schema.ts. -/
inductive SpecType where
  | scenario
  | rule
  deriving DecidableEq, Repr, Inhabited

/-- `SpecEntry` in schema.ts. -/
structure SpecEntry where
  id : String
  type : SpecType
  name : String
  version : Nat
  status : Status
  body : String
  tests : List String
  link : Option ExternalLink := none
  prs : Option (List PullRequestLink) := none
  deriving DecidableEq, Repr, Inhabited

/-- `FeatureDoc` in schema.ts. The Automerge wrapper is dropped: this is the
plain value a document holds; the operations it took to get there are the
`Op` list `Reconcile.reconcile` returns alongside. -/
structure FeatureDoc where
  schemaVersion : Nat
  id : String
  name : String
  description : String
  specs : List SpecEntry
  link : Option ExternalLink := none
  prs : Option (List PullRequestLink) := none
  assigned : Option String := none
  deriving DecidableEq, Repr, Inhabited

/-- `EntryKind` in parser.ts. -/
inductive EntryKind where
  | observation
  | decision
  deriving DecidableEq, Repr, Inhabited

/-- `Supersedes` in parser.ts. -/
structure Supersedes where
  title : String
  url : String
  deriving DecidableEq, Repr, Inhabited

/-- `MarkdownPage` in parser.ts (and, field for field, `PageDoc` in
schema.ts minus the identity). -/
structure MarkdownPage where
  name : String
  body : String
  assigned : Option String := none
  estimate : Option Nat := none
  done : Option Bool := none
  author : Option String := none
  date : Option String := none
  kind : Option EntryKind := none
  supersedes : Option Supersedes := none
  deriving DecidableEq, Repr, Inhabited

/-- `ScenarioPick` in parser.ts: identity of one scenario in a file. -/
structure ScenarioPick where
  name : String
  version : Nat
  deriving DecidableEq, Repr, Inhabited

/-- `ScenarioTarget` in parser.ts: a pick plus the document id the editor
read it under, when it holds one. -/
structure ScenarioTarget extends ScenarioPick where
  id : Option String := none
  deriving DecidableEq, Repr, Inhabited

/-- `key` in merge.ts: `${name}@v${version}`. Two scenarios share a key
exactly when they share name and version. -/
def Scenario.key (s : Scenario) : String × Nat := (s.name, s.version)

def SpecEntry.key (e : SpecEntry) : String × Nat := (e.name, e.version)

/-- `linkKey` in merge.ts / reconcile.ts: a link's identity for change
detection, the empty string for none. Modelled as the option itself, which
is injective on the three fields the string concatenation joins. -/
def linkKey (l : Option ExternalLink) : Option ExternalLink := l

/-- `sameScenario` in reconcile.ts: same name and version. -/
def samePick (a : ScenarioPick) (b : ScenarioPick) : Bool :=
  a.name == b.name && a.version == b.version

end SpecDriven.Sync

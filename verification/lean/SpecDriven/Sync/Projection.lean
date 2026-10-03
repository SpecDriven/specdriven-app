import SpecDriven.Sync.Schema

/-!
# Projection

`src/server/automerge/project.ts` and the two parser functions it relies on,
`sortScenarios` and `serializeFeature`.

## How markdown text is modelled

A `.feature.md` is represented by its parse: the `Feature` value
`parseFeature` would return for it. `serializeFeature` is then the
normalisation that drops what markdown cannot carry (`id`, `prs`, and the
links when the "Publish external links" setting is off) and sorts the
scenarios, and `parseFeature ∘ serializeFeature` is the identity on
normalised features. That round trip is a property of the parser, exercised
by `tests/parser.test.ts`, and is assumed here rather than modelled: the sync
theorems never look inside the bytes, only at `=` between projections.

`sortScenarios` uses `localeCompare`; the model uses Lean's code-point order
on `String`. The two agree on names drawn from lowercase letters, digits and
spaces, which is what the differential vectors use.
-/

namespace SpecDriven.Sync

/-- `sortScenarios`: by name, then version; a stable sort, like
`Array.prototype.sort`. -/
def sortScenarios (ss : List Scenario) : List Scenario :=
  ss.mergeSort (fun a b => a.name < b.name || (a.name == b.name && a.version ≤ b.version))

/-- What `serializeFeature` keeps of a scenario. `links = false` is the
projection form with "Publish external links" off. -/
def serializeScenario (links : Bool) (s : Scenario) : Scenario :=
  { name := s.name, version := s.version, status := s.status, body := s.body,
    tests := s.tests, id := none, link := if links then s.link else none, prs := none }

/-- `serializeFeature` as a normalisation, see the module comment. The
scenario order is the caller's: `parseFeature` sorts on the way in, and
`docToFeature` sorts, so every projection is sorted. -/
def serializeFeature (links : Bool) (f : Feature) : Feature :=
  { name := f.name, description := f.description,
    scenarios := f.scenarios.map (serializeScenario links),
    link := if links then f.link else none, prs := none, assigned := f.assigned }

/-- `parseFeature` on well-formed markdown: the identity on the parse, with
the sort `parseFeature` applies. -/
def parseFeature (text : Feature) : Feature :=
  { text with scenarios := sortScenarios text.scenarios }

/-- `docToFeature` in project.ts. -/
def entryToScenario (e : SpecEntry) : Scenario :=
  { name := e.name, version := e.version, status := e.status, body := e.body,
    tests := e.tests, id := none, link := e.link, prs := e.prs }

def docToFeature (d : FeatureDoc) : Feature :=
  { name := d.name, description := d.description,
    scenarios := sortScenarios (d.specs.map entryToScenario),
    link := d.link, prs := d.prs, assigned := d.assigned }

/-- `projectFeature` in project.ts: the `.feature.md` this document projects
to, drafts left out. -/
def projectFeature (d : FeatureDoc) (links : Bool := true) : Feature :=
  let f := docToFeature d
  serializeFeature links { f with scenarios := f.scenarios.filter (·.status != .draft) }

/-- `isProjectionOf` in project.ts: the text is the document's projection in
either link form. -/
def isProjectionOf (text : Feature) (d : FeatureDoc) : Bool :=
  text == projectFeature d true || text == projectFeature d false

end SpecDriven.Sync

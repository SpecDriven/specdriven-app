# Development

How this code base is worked on. Running a checkout is covered in
[running.md](running.md); the design in [ARCHITECTURE.md](ARCHITECTURE.md).

## Clone the spec repo

This app's own specs live in a separate repo,
[SpecDriven/specs-specdriven](https://github.com/SpecDriven/specs-specdriven),
and `specs/` here is a checked-in symlink to `../specs-specdriven/specs`.
Clone it as a sibling of this checkout, or `specs/` dangles:

```sh
gh repo clone SpecDriven/specs-specdriven ../specs-specdriven
```

Without `gh`, `git clone https://github.com/SpecDriven/specs-specdriven.git ../specs-specdriven`
does the same. Nothing at runtime reads `specs/` — it is there for the
workflow below — so a dangling symlink costs you only the links in this
file and the spec references in the code, and the release zip leaves the
symlink out (`.gitattributes`). `bun run build:desktop` is the exception:
electron-builder stats every path in the project, so a dangling `specs`
fails the desktop build with `ENOENT ... stat '<checkout>/specs'`. Point it
somewhere real or delete it.

For testing against a data repo of your own, fork
[SpecDriven/specs-insurance](https://github.com/SpecDriven/specs-insurance)
and clone the fork locally so you have write permission.

## Workflow

This app is built the way it asks you to build: the spec is written first,
and the code and its tests point back at it.

1. **Write or update the spec.** Behavior lives in [specs/](../specs) as
   `<area>/<feature>.feature.md` — plain markdown, one feature per file, with
   a `## S<n>: <name> @v<version> [status]` heading per scenario and
   Given / When / Then bullets under it. If a change has no home in an
   existing feature, add one.
2. **Implement, and reference the spec from the code.** Modules carry a
   comment naming the spec that governs them, e.g.
   `// Per specs/ui/app-start.feature.md, the data repo may be given as a GitHub url`.
   That reference is how the next reader (human or agent) finds the
   authority for the behavior.
3. **Cover it with a test that names the same spec.** Each test file opens
   with a comment citing the spec it automates; assertions follow the
   scenarios.
4. **Run `bun test`** — the suite is fast and expected to be green before
   commit.
5. **Commit with the spec in the subject** when a change is driven by one:
   `feat: links to automated tests per scenario (specs/editor/traceability.feature.md)`.

Specs written *in* the app (in a data repo) go further: a scenario is
atomic, immutable, and versioned — `@v<n> [proposed | published | deleted |
archived]` — and ends with `[test: <test name> : <url> ]` lines, one per
GitHub url of a test that automates it (older files carry a `### Tests`
table, still read, and a `[test: <url> ]` line without a name is still
fine). The url names a line (`…Test.java#L32`); when the link is added the
app reads the test function declared there from GitHub — Java, Kotlin,
TypeScript, JavaScript, Python and Go — and stores its name in the token. A
single rule inside a scenario can name its test on its own line the same
way, and the app shows every reference as a link named after the test
(`quotesAHomeownersPolicy`, or the file name `QuoteHomeownersPolicyTest`
when no name is stored). Published scenarios never change; a new version
supersedes them. That link is bidirectional: the test carries a `@Spec`
annotation naming `file#scenario@version`, so tooling can flag a spec that
moved without its test. PMs publish spec versions; developers own the tests.

## Layout

```
src/index.ts        web entry — Bun.serve() over the shared route table
src/server/         api (routes shared by web + desktop), features, parser, search, entities,
                    git/ (gh + cli + js engines), automerge/ (CRDT store + sync), auth, github,
                    tokenStore, repo, state, user, reload, telemetry, agents, integrations
src/electron/       desktop shell — main, app:// static serving, deep links, token encryption
src/frontend/       React app (App.tsx, markdown editor, scenario table, search, routing)
src/plugins/        plugin kernel, host/client SDKs, built-in module tabs
src/gateway/        hosted multi-user gateway (sign-in, one worker per user)
specs/              this app's own specifications — a symlink to ../specs-specdriven/specs
tests/              bun test suite
scripts/            build.ts (binaries), build-desktop.ts (dmg/AppImage/deb), dev-electron.ts,
                    bump-version.ts (version, commit, tag), crash-test-desktop.ts
docs/               this folder; user guides under docs/user-guide
```

## Writing a plugin

Every module tab is a plugin (specs/app/plugins.feature.md): a host half
that runs in the server and a browser half the server serves to the app.
The built-in ones live under `src/plugins/builtin/`; one from a folder is
loaded the same way. To make one:

```bash
bun src/index.ts plugin new my-tab ../my-tab
bun src/index.ts plugin link ../my-tab
```

Start the dev server: the tab is there, `GET /api/my-tab` answers, and
edits under `../my-tab/src` rebuild and remount the plugin — the browser
picks the new build up without a reload. The folder's package.json carries
the manifest under `specdriven` (id, `api`, both halves, url prefixes);
`src/plugins/manifest.ts` is what the app checks it against. The browser
half imports `react` like any component: the app builds it over its own
React (src/plugins/host/build.ts), so a bundle that brings a React of its
own is refused. The desktop app cannot build (its main process runs on
node) and loads `dist/` only, which `bun src/index.ts plugin build ../my-tab`
writes. Plugins are also found under `~/.specdriven/plugins/<id>` and, after
a trust step in Settings → Plugins, under the data repo's
`.specdriven/plugins/<id>`.

## Releasing

Version bumps, tags and the release workflow are in
[releasing.md](releasing.md).

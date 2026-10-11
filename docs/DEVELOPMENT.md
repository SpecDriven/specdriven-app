# Testing

Fork https://github.com/SpecDriven/specs-insurance and 'git clone' locally in order to have write permissions.

# Development

## The spec repo submodule

This app's own specs live in a separate repo, [SpecDriven/specs-specdriven](https://github.com/SpecDriven/specs-specdriven),
checked out here as a git submodule at `specs-specdriven/`; `specs` is a
checked-in symlink to `specs-specdriven/specs`, so `specs/<area>/<name>.feature.md`
paths work as before. Clone with the submodule, or fetch it into an existing
checkout, or `specs/` dangles:

```sh
git clone --recurse-submodules https://github.com/SpecDriven/specdriven-app.git
git submodule update --init          # in a checkout made without it
```

The submodule is pinned to one commit of the spec repo and checks out on a
detached HEAD. To write specs from here, put it on its branch first, push from
inside it, then record the new pin in this repo:

```sh
git -C specs-specdriven switch main
# …edit, commit and push in specs-specdriven…
git add specs-specdriven && git commit -m "Bump specs"
```

`git submodule update --remote specs-specdriven` moves the pin to the newest
specs on `main` without editing them. `git config submodule.recurse true` makes
`git pull` and `git checkout` update the submodule too.

To edit the specs in the SpecDriven app itself, open a standalone clone of
specs-specdriven (an older `../specs-specdriven` beside this checkout is fine to
keep for that): the app syncs a repository whose `.git` is a folder, and treats
a submodule checkout — whose `.git` is a file — as a plain folder it saves into
without committing or pushing.

Nothing at runtime reads `specs/` — it is there for the workflow below — so
without the submodule you lose only the links in this README and the spec
references in the code, and the release zip leaves both out
(`.gitattributes`). `bun run build:desktop` is the exception: electron-builder
stats every path in the project, so a dangling `specs` fails the desktop build
with `ENOENT ... stat '<checkout>/specs'`. Run `git submodule update --init`
first.

## Deleting old releases

```gh release delete v0.1.x --repo SpecDriven/specdriven-app-release --cleanup-tag --yes```

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

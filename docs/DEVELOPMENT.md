# Testing

Fork https://github.com/SpecDriven/specs-insurance and 'git clone' locally in order to have write permissions.

# Development

## Clone the spec repo

This app's own specs live in a separate repo, [SpecDriven/specs-specdriven](https://github.com/SpecDriven/specs-specdriven),
and `specs/` here is a checked-in symlink to `../specs-specdriven`. Clone it as a
sibling of this checkout, or `specs/` dangles:

```sh
gh repo clone SpecDriven/specs-specdriven ../specs-specdriven
```

Without `gh`, `git clone https://github.com/SpecDriven/specs-specdriven.git ../specs-specdriven`
does the same. Nothing at runtime reads `specs/` — it is there for the workflow
below — so a dangling symlink costs you only the links in this README and the
spec references in the code, and the release zip leaves the symlink out
(`.gitattributes`). `bun run build:desktop` is the exception: electron-builder
stats every path in the project, so a dangling `specs` fails the desktop build
with `ENOENT ... stat '<checkout>/specs'`. Point it somewhere real or delete
it.

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

# Versioning and releasing

How a version is bumped, tagged and published as a release on
[SpecDriven/specdriven-app](https://github.com/SpecDriven/specdriven-app).
What the published installers do is in [installation.md](installation.md).

## Versioning

`package.json`'s `version` is the one place the release version lives — it is
what electron-builder names the desktop artifacts after, what the release is
tagged as, and what the installer looks for under `releases/download/v<version>`.

```sh
bun run bump patch    # 0.1.4 -> 0.1.5
bun run bump minor    # 0.1.4 -> 0.2.0
bun run bump major    # 0.1.4 -> 1.0.0
bun run bump 1.2.3    # an explicit version
```

The bump rewrites that one line in `package.json`, commits it, and tags
`v<version>`. It refuses a dirty tree — so the release commit is the bump
alone — a tag that already exists, and a version that does not come after the
current one, since a released version names artifacts people already have.
`--dry-run` shows the move without making it; `--no-git` writes `package.json`
and stops there. See [scripts/bump-version.ts](../scripts/bump-version.ts).

## Publishing

Pushing is deliberately left to you, because pushing the tag is what
publishes the release:

```sh
git push origin main --follow-tags
```

The tag push runs [.github/workflows/release.yml](../.github/workflows/release.yml),
which:

- checks the tag against `package.json`;
- zips the tagged tree with `git archive` (tracked files only — no
  `node_modules`, `dist`, or `.env`; paths marked `export-ignore` in
  [.gitattributes](../.gitattributes) are left out too);
- creates a `v<version>` release on this repository with the zip, its
  `SHASUMS256.txt`, `install.sh` and `install.ps1` attached.

It publishes with the workflow's own `GITHUB_TOKEN` (`contents: write`), so no
secret is needed. The `curl | sh` and `irm | iex` lines fetch `install.sh` and
`install.ps1` from `main`. A release that already exists is not overwritten —
re-running on the same tag fails, on purpose.

Build the desktop artifacts from the tagged commit, not from whatever is
checked out — electron-builder reads the version out of `package.json`, so a
build from any other commit is mislabelled.

## Deleting a release

```sh
gh release delete v0.1.x --repo SpecDriven/specdriven-app --cleanup-tag --yes
```

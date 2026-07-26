Build and deploy similar to Claude Claude via a curl command
Ex: `curl -fsSL https://claude.ai/install.sh | bash`
Domain is: specdriven.app

specdriven.app is hosted on CloudFlare

## Build matrix (done)

`bun run build:all` cross-compiles every target into `dist/`, plus a
`SHASUMS256.txt` for the installer to verify against:

| asset | bun target |
| --- | --- |
| `specdriven-darwin-arm64` | `bun-darwin-arm64` |
| `specdriven-darwin-x64` | `bun-darwin-x64` |
| `specdriven-linux-arm64` | `bun-linux-arm64` |
| `specdriven-linux-x64` | `bun-linux-x64` |
| `specdriven-linux-x64-baseline` | `bun-linux-x64-baseline` |
| `specdriven-windows-x64.exe` | `bun-windows-x64` |

`bun run build` still emits just `dist/specdriven` for the host platform.
Binaries are 60–95 MB each (the Bun runtime is embedded).

## Installer (done)

`install.sh` — POSIX sh, fetched as `curl -fsSL https://specdriven.app/install.sh | sh`.
Detects os/arch, downloads `$BASE_URL/$VERSION/$asset`, verifies against
`SHASUMS256.txt`, installs to `~/.specdriven/bin`, prints PATH setup.

Fails closed: a checksum mismatch, a missing `SHASUMS256.txt`, or a 404 all
abort without writing anything. Overridable via `SPECDRIVEN_VERSION`,
`SPECDRIVEN_BASE_URL`, `SPECDRIVEN_HOME`.

Falls back to the baseline build on linux-x64 hosts without AVX2 — the default
Bun x64 build dies with an illegal instruction there, and the crash gives the
user nothing to go on.

Windows is rejected with a pointer to the `.exe`; `curl | sh` can't serve it.

## Versioning (done)

`package.json`'s `version` is the one place the release version lives — it is
what electron-builder names the desktop artifacts after, and what the installer
looks for under `$BASE_URL/$VERSION`.

`bun run bump <major|minor|patch|1.2.3>` moves it, commits that one file, and
tags `v<version>`. It refuses a dirty tree (so the release commit is the bump
alone), a tag that already exists, and a version that doesn't come after the
current one — released versions name immutable artifacts. `--no-git` writes
`package.json` alone; `--dry-run` shows the move without making it.

Pushing is deliberately left to the caller, since pushing the tag is what
publishes the release: `git push origin main --follow-tags`.

## Still to do

- **Host the assets.** The repo is private, so GitHub Release assets need auth
  and can't be `curl`ed anonymously — R2 behind specdriven.app is the way,
  which is also why `BASE_URL` defaults to `https://specdriven.app/dist`.
- **Publish on tag.** Nothing yet uploads a build: the installer defaults to
  `latest`, so a tagged version has to land in `dist/latest/` (and ideally
  `dist/v1.2.3/` alongside it).
- **Serve `install.sh`** at the domain root from the same bucket.
- No `--version` flag on the binary, so an installed copy can't report what it
  is. Worth adding before there are versions to tell apart.

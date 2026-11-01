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
- builds the Windows installers, `SpecDriven-<version>-x64-setup.exe` and
  `SpecDriven-<version>-arm64-setup.exe`, each on a GitHub Windows runner of
  its own architecture (`bun run build:desktop --win --host-arch`), installs
  each one silently and checks the installed app opens its window;
- zips the tagged tree with `git archive` (tracked files only — no
  `node_modules`, `dist`, or `.env`; paths marked `export-ignore` in
  [.gitattributes](../.gitattributes) are left out too);
- signs `SHASUMS256.txt` with the release signing key (below), as
  `SHASUMS256.txt.sig`, and checks the signature against the public key
  `install.sh` and `install.ps1` embed;
- lists the zip and both installers in `SHASUMS256.txt`;
- attests the zip, the installers and `SHASUMS256.txt` with GitHub build
  provenance;
- creates a `v<version>` release on this repository with the zip, the two
  Windows installers, `SHASUMS256.txt` and `SHASUMS256.txt.sig`,
  `install.sh` and `install.ps1` attached.

Releases on this repository are immutable: nothing can be attached to one
after it is created, and once a release has existed its tag name can never
be used again. So the release is only created after both Windows builds have
passed. If one fails, nothing is published. Fix it and re-run the workflow
on the same tag, or cut the next version. A pull request that touches
`release.yml`, `scripts/build-desktop.ts`, `src/electron/`, `package.json`
or `bun.lock` runs the Windows builds on their own, without publishing, so a
broken build shows up before a tag is spent on it.

The Windows installers are not code-signed yet, so SmartScreen asks before
running one. How to add signing is described in the header of
[scripts/build-desktop.ts](../scripts/build-desktop.ts).

It publishes with the workflow's own `GITHUB_TOKEN` (`contents: write`, plus
`id-token: write` and `attestations: write` for the provenance); the one
secret it needs is the signing key. The `curl | sh` and `irm | iex` lines
fetch `install.sh` and `install.ps1` from `main`. A release that already
exists is not overwritten — re-running on the same tag fails, on purpose.

Build the desktop artifacts from the tagged commit, not from whatever is
checked out — electron-builder reads the version out of `package.json`, so a
build from any other commit is mislabelled.

## Signing and provenance

A release can be verified by origin, not only by checksum
([installation.md](installation.md#verifying-a-release-by-hand) has the
commands):

- **GitHub build provenance.** `actions/attest-build-provenance` records,
  in Sigstore's public log, that `specdriven-<version>-src.zip` and
  `SHASUMS256.txt` were produced by this workflow at this commit; `gh
  attestation verify specdriven-<version>-src.zip --repo
  SpecDriven/specdriven-app` checks it. It needs no key of ours: the
  workflow's OIDC identity is what is signed. The attestation is made
  before the release is created, so a published release always has one.
- **The release signature.** `SHASUMS256.txt.sig` is an SSH signature
  (`ssh-keygen -Y sign`) by the SpecDriven release key, as
  `release@specdriven.app` in the `specdriven-release` namespace. This is
  what the installers check, since `ssh-keygen` is on every machine they
  run on and `gh` is not. The public key is the `SIGNER_KEY` line in
  `install.sh` and the `$signerKey` line in `install.ps1`; the workflow
  reads it out of `install.sh`, verifies its own signature against it, and
  refuses to publish when `install.ps1` carries a different one — so the
  secret and the installers cannot drift apart unnoticed.

### The signing key

The private key is an Ed25519 SSH key, made with `ssh-keygen -t ed25519`
and no passphrase, kept as the repository secret
`SPECDRIVEN_RELEASE_SIGNING_KEY` (the whole private key file, `-----BEGIN
OPENSSH PRIVATE KEY-----` to the end). The workflow writes it to a `mktemp`
file for the one `ssh-keygen -Y sign` call and deletes it; it never appears
in a log or an artifact. Only repository admins can read or change secrets,
and only an admin can push a `v*` tag (the tag ruleset), so publishing a
release that the installers accept takes both.

The maintainer keeps the only other copy offline, outside any repository,
at `~/.specdriven/release-signing/specdriven-release` (mode 0600, in a 0700
directory) with the public half beside it. It is never committed, never
pasted into a chat or an issue, and never used for anything but releases.

To set the secret from that copy:

```sh
gh secret set SPECDRIVEN_RELEASE_SIGNING_KEY --repo SpecDriven/specdriven-app < ~/.specdriven/release-signing/specdriven-release
```

### Rotating the key

If the private key may have leaked, or is lost:

1. `ssh-keygen -t ed25519 -N '' -C 'SpecDriven release signing (release@specdriven.app)' -f ~/.specdriven/release-signing/specdriven-release`
   (move the old pair aside first).
2. Put the new public key — `cut -d' ' -f1,2 specdriven-release.pub` — in
   `install.sh` (`SIGNER_KEY=`), `install.ps1` (`$signerKey =`) and
   [installation.md](installation.md#verifying-a-release-by-hand), and merge
   that to `main`. The test "the installers trust the one key the release
   workflow checks against" in `tests/install.test.ts` holds the three
   together.
3. Set the secret from the new private key, as above.
4. Cut a release.

Installers fetched from `main` after step 2 accept releases signed with
the new key and refuse the old ones; `SPECDRIVEN_VERSION=<older>` therefore
stops working for releases signed before the rotation, which is the point.
Someone holding an installer from before the rotation sees "not signed by
the SpecDriven release key" with a pointer at the current `install.sh`.

## Deleting a release

```sh
gh release delete v0.1.x --repo SpecDriven/specdriven-app --cleanup-tag --yes
```

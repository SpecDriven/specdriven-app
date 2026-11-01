# Installing a release

SpecDriven is distributed as a **source zip**, so you can apply your own
security review to the code — and your own supply chain to the dependencies
— before building a binary. Releases live on
[SpecDriven/specdriven-app](https://github.com/SpecDriven/specdriven-app).

## macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.sh | sh
```

[install.sh](../install.sh) (POSIX sh; curl or wget; unzip, bsdtar or
python3; sha256sum or shasum; ssh-keygen) needs macOS 13 or later on a Mac —
Electron 44 dropped macOS 12 — and:

1. follows the redirect from the releases page's `latest` to find the newest
   `v<version>`;
2. downloads `specdriven-<version>-src.zip`, `SHASUMS256.txt` and
   `SHASUMS256.txt.sig` from that release, checks that the signature was
   made by the SpecDriven release key (the public key is embedded in the
   script), and then that the zip's checksum is the one `SHASUMS256.txt`
   lists;
3. unpacks the zip to `~/.specdriven/app/specdriven-<version>`, points
   `~/.specdriven/app/current` at it, and keeps the verified zip and its
   checksum alongside;
4. runs `bun install` and `bun run build:desktop --local`;
5. starts what electron-builder leaves beside the installer — the `.app` on
   macOS, the `.AppImage` on Linux, which it makes executable first and starts
   only when there is a display to start it on.

This is the unattended path. To review the source before any of it runs,
take the zip from the releases page, [verify it by hand](#verifying-a-release-by-hand)
and unpack it yourself, then build by hand (below). The behaviour is
specified in
[specs/app/installation.feature.md](../specs/app/installation.feature.md).

### Why a signature, and why ssh-keygen

A checksum proves the zip is the one `SHASUMS256.txt` names — which is only
worth something if `SHASUMS256.txt` itself came from SpecDriven. Anyone who
could put a release on the releases page could put a matching checksum file
beside it. So the release workflow signs `SHASUMS256.txt` with the SpecDriven
release key, and the installers refuse a release whose signature is missing,
made by another key, made in another namespace, or made over a different
checksum file: the signature is checked first, the checksum second, and
nothing is unpacked until both pass. See
[releasing.md](releasing.md#signing-and-provenance) for where the key lives.

The signature is an [SSH signature](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig)
(`ssh-keygen -Y`), rather than a Sigstore or minisign one, because
verifying it needs only `ssh-keygen`: OpenSSH 8.1 or later, which every
macOS since Catalina, nearly every Linux, and Windows 10 and 11 (the OpenSSH
Client, installed by default) already have. A keyless Sigstore signature
cannot be checked from POSIX sh without `cosign` or `gh`, and nothing ships
`minisign`. A machine without `ssh-keygen` is refused, like one without a
sha256 tool: Debian and Ubuntu have it in `openssh-client`, Fedora and Arch
in `openssh`, Alpine in `openssh-keygen`; on Windows it is the OpenSSH Client
optional feature (`Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0`).

### Bun

Building needs [Bun](https://bun.sh), so a machine without it is offered
one: the question goes to `/dev/tty` (`curl | sh` has already spent stdin on
the pipe), and only a `y` runs Bun's own installer — downloaded first, then
run with bash under the invoking user, into `BUN_INSTALL` (default `~/.bun`).
No sudo, nothing system-wide, and a refusal to run as root. With no terminal
to ask at — a build step, a provisioning script — the question is skipped
rather than answered for you, and `SPECDRIVEN_INSTALL_BUN=1` or `=0` settles
it in advance. With no Bun, the run stops at the unpacked source and prints
the build steps rather than guessing; a failed `bun install` or build is an
error, with the verified checkout left in place.

### Failure modes and overrides

It fails closed: a signature that is missing or does not verify, a checksum
mismatch, a missing or incomplete `SHASUMS256.txt`, a 404, or a machine with
no sha256 tool or no `ssh-keygen` aborts without writing anything, and a
version that is already unpacked is not re-extracted — someone may have
edited or built in it — though the build then runs on it as it stands. A Bun
install that fails is reported and left at that. A signature that fails
against the embedded key can also mean the key was rotated after this copy
of the installer was fetched; the message says so and names the current
`install.sh`.

| variable | meaning |
| --- | --- |
| `SPECDRIVEN_VERSION` | `0.1.40` or `v0.1.40`; default `latest` |
| `SPECDRIVEN_HOME` | the install prefix (the same one the settings live under) |
| `SPECDRIVEN_INSTALL_BUN` | `1` or `0`: answer the Bun question in advance |
| `BUN_INSTALL` | where Bun's installer puts Bun (default `~/.bun`) |
| `SPECDRIVEN_RELEASES_URL` | anything serving GitHub's `/latest` → `/tag/v<version>` redirect and `/download/v<version>/<asset>` layout, which is what [tests/install.test.ts](../tests/install.test.ts) stands up on loopback |
| `SPECDRIVEN_RELEASE_PUBKEY` | the `ssh-ed25519 AAAA…` key releases must be signed with, instead of the SpecDriven one embedded in the script — for a release server of your own, signed with a key of your own; the tests sign their fake releases this way |

A Windows shell (Git Bash, MSYS, Cygwin) is pointed at install.ps1 instead:
`curl | sh` needs a Unix shell.

## Windows

```powershell
irm https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.ps1 | iex
```

[install.ps1](../install.ps1) does the same in the same order — the same
overrides, the same signature and checksum rules, the same Bun question —
under `%USERPROFILE%\.specdriven\app`, with `current` a junction (which
needs neither admin rights nor Developer Mode) rather than a symlink. It
downloads with `Invoke-WebRequest`, verifies the signature with the
`ssh-keygen` of Windows' OpenSSH Client (on PATH, or under
`System32\OpenSSH`), the checksum with `Get-FileHash`, and unpacks with
.NET's `ZipFile`, so it needs nothing Windows 10 and 11 do not ship. Bun
comes from Bun's own `install.ps1`, downloaded first and then run in a
PowerShell of its own, never from an elevated (Administrator) one. After
`bun run build:desktop --local` it adds a Start menu shortcut to
`current\release\win-unpacked\SpecDriven.exe` — through `current`, so the
next install moves it along — and starts the app; it warns when git, which
holds SpecDriven's data, is not on PATH.

### The prebuilt installer

Every release also carries a prebuilt desktop installer for Windows:
`SpecDriven-<version>-x64-setup.exe`, and `SpecDriven-<version>-arm64-setup.exe`
for Windows on ARM. It needs neither Bun nor a build. It installs for the
current user under `%LOCALAPPDATA%\Programs\SpecDriven` and adds a Start menu
shortcut. It does not update itself: install the next release's installer
over it. The installers are not code-signed yet, so SmartScreen asks first:
choose *More info*, then *Run anyway*. To check one before running it, compare
`certutil -hashfile SpecDriven-<version>-x64-setup.exe SHA256` with its line
in the release's signed `SHASUMS256.txt`, or run
`gh attestation verify SpecDriven-<version>-x64-setup.exe --repo SpecDriven/specdriven-app`.

### install.ps1 details

It runs in one script block, so `irm | iex` leaves nothing in the caller's
session, and a failure ends the script without closing their window. It is
ASCII only: Windows PowerShell 5.1 reads a script file without a BOM in the
legacy code page.

[tests/installPs1.test.ts](../tests/installPs1.test.ts) runs it under
PowerShell 7 against the same loopback releases. Each run starts a
PowerShell, which is too slow for every pull request, so those tests run only
when `SPECDRIVEN_TEST_PWSH` names a `pwsh` —
`SPECDRIVEN_TEST_PWSH=$(command -v pwsh) bun test tests/installPs1.test.ts` —
and otherwise skip. The
[install.ps1 workflow](../.github/workflows/install-ps1.yml) runs them on
pushes and pull requests that change the installer or those tests.

## Verifying a release by hand

Every release on the [releases page](https://github.com/SpecDriven/specdriven-app/releases)
carries `specdriven-<version>-src.zip`, `SHASUMS256.txt` and
`SHASUMS256.txt.sig`, and two proofs of where they came from. Either one is
enough; the installers use the second.

**GitHub build provenance.** The release workflow attests the zip and
`SHASUMS256.txt` with
[actions/attest-build-provenance](https://github.com/actions/attest-build-provenance):
a Sigstore-signed statement, kept by GitHub, that this file was built by
`.github/workflows/release.yml` on `SpecDriven/specdriven-app` at a given
commit. With the [GitHub CLI](https://cli.github.com) signed in:

```sh
gh attestation verify specdriven-<version>-src.zip --repo SpecDriven/specdriven-app
```

It downloads the attestation, checks the signature against Sigstore's
public log and the file's digest, and prints the workflow and commit it was
built from. `--repo` is what ties it to this repository: an attestation from
some other repository's workflow does not pass.

**The release signature**, which needs only `ssh-keygen` and works offline.
`SHASUMS256.txt.sig` is an SSH signature by the SpecDriven release key, as
`release@specdriven.app`, in the `specdriven-release` namespace. Write the
public key — the `SIGNER_KEY` line in [install.sh](../install.sh) — into a
one-line `allowed_signers` file, and check the signature, then the checksum:

```sh
echo 'release@specdriven.app ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIdkUdY/iFmbDwh8/NPieR+Wkrx/vaAzXXf1+L5jovKx' > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I release@specdriven.app -n specdriven-release -s SHASUMS256.txt.sig < SHASUMS256.txt
sha256sum -c SHASUMS256.txt      # shasum -a 256 -c on macOS
```

The first prints `Good "specdriven-release" signature for release@specdriven.app
with ED25519 key SHA256:…`; the second, `specdriven-<version>-src.zip: OK`.
Anything else — `Could not verify signature`, a namespace or principal that
does not match, a checksum that fails — means the files are not the ones the
workflow published, or the key has been rotated since this page was written;
the current key is always the one in `install.sh` on `main`.

## Building by hand

After unzipping a release yourself, or when the installer stopped for lack
of Bun:

```sh
cd ~/.specdriven/app/current
bun install
bun run start            # web app at http://localhost:3000
bun run build:desktop    # desktop installer in release/ — dmg on macOS, AppImage + deb on Linux
```

See [building.md](building.md) for the build options.

## What the repository must provide

For the installers to work the repository has to be **public**: GitHub
answers a private repository's release assets and raw files with a 404, not a
login prompt. The `curl | sh` and `irm | iex` lines fetch `install.sh` and
`install.ps1` from `main`; both are also attached to every release (see
[releasing.md](releasing.md)), so
`https://github.com/SpecDriven/specdriven-app/releases/latest/download/install.sh`
serves the copy that shipped with the latest one.

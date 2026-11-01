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
python3) needs macOS 13 or later on a Mac — Electron 44 dropped macOS 12 —
and:

1. follows the redirect from the releases page's `latest` to find the newest
   `v<version>`;
2. downloads `specdriven-<version>-src.zip` and `SHASUMS256.txt` from that
   release and verifies the checksum;
3. unpacks the zip to `~/.specdriven/app/specdriven-<version>`, points
   `~/.specdriven/app/current` at it, and keeps the verified zip and its
   checksum alongside;
4. runs `bun install` and `bun run build:desktop --local`;
5. starts what electron-builder leaves beside the installer — the `.app` on
   macOS, the `.AppImage` on Linux, which it makes executable first and starts
   only when there is a display to start it on.

This is the unattended path. To review the source before any of it runs,
take the zip from the releases page and unpack it yourself, then build by
hand (below). The behaviour is specified in
[specs/app/installation.feature.md](../specs/app/installation.feature.md).

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

It fails closed: a checksum mismatch, a missing or incomplete
`SHASUMS256.txt`, a 404, or a machine with no sha256 tool aborts without
writing anything, and a version that is already unpacked is not re-extracted
— someone may have edited or built in it — though the build then runs on it
as it stands. A Bun install that fails is reported and left at that.

| variable | meaning |
| --- | --- |
| `SPECDRIVEN_VERSION` | `0.1.40` or `v0.1.40`; default `latest` |
| `SPECDRIVEN_HOME` | the install prefix (the same one the settings live under) |
| `SPECDRIVEN_INSTALL_BUN` | `1` or `0`: answer the Bun question in advance |
| `BUN_INSTALL` | where Bun's installer puts Bun (default `~/.bun`) |
| `SPECDRIVEN_RELEASES_URL` | anything serving GitHub's `/latest` → `/tag/v<version>` redirect and `/download/v<version>/<asset>` layout, which is what [tests/install.test.ts](../tests/install.test.ts) stands up on loopback |

A Windows shell (Git Bash, MSYS, Cygwin) is pointed at install.ps1 instead:
`curl | sh` needs a Unix shell.

## Windows

```powershell
irm https://raw.githubusercontent.com/SpecDriven/specdriven-app/main/install.ps1 | iex
```

[install.ps1](../install.ps1) does the same in the same order — the same
overrides, the same checksum rules, the same Bun question — under
`%USERPROFILE%\.specdriven\app`, with `current` a junction (which needs
neither admin rights nor Developer Mode) rather than a symlink. It downloads
with `Invoke-WebRequest`, verifies with `Get-FileHash` and unpacks with
.NET's `ZipFile`, so it needs nothing Windows 10 and 11 do not ship. Bun
comes from Bun's own `install.ps1`, downloaded first and then run in a
PowerShell of its own, never from an elevated (Administrator) one. After
`bun run build:desktop --local` it adds a Start menu shortcut to
`current\release\win-unpacked\SpecDriven.exe` — through `current`, so the
next install moves it along — and starts the app; it warns when git, which
holds SpecDriven's data, is not on PATH.

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

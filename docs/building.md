# Building binaries and the desktop app

How to compile the server into a standalone binary and package the Electron
desktop app. Publishing what you build is covered in [releasing.md](releasing.md).

## Server binary

`bun build --compile` embeds the Bun runtime, so each binary is a standalone
60–95 MB executable with no runtime dependency.

```sh
bun run build       # host platform only -> dist/specdriven
bun run build:all   # full cross-compile matrix -> dist/specdriven-<os>-<arch>
```

`build:all` wipes `dist/`, cross-compiles all six targets, and writes
`dist/SHASUMS256.txt`:

| asset | bun target |
| --- | --- |
| `specdriven-darwin-arm64` | `bun-darwin-arm64` |
| `specdriven-darwin-x64` | `bun-darwin-x64` |
| `specdriven-linux-arm64` | `bun-linux-arm64` |
| `specdriven-linux-x64` | `bun-linux-x64` |
| `specdriven-linux-x64-baseline` | `bun-linux-x64-baseline` |
| `specdriven-windows-x64.exe` | `bun-windows-x64` |

The suffixed names are the asset names a binary release would use, and
`SHASUMS256.txt` is what an installer would verify them against — but nothing
publishes them yet; [install.sh](../install.sh) installs the source zip
release instead (see [installation.md](installation.md)). The baseline Linux
build exists for CPUs without AVX2, where the default x64 build dies with an
illegal instruction. See [scripts/build.ts](../scripts/build.ts).

## Desktop app

```sh
bun run build:desktop           # this machine's platform
bun run build:desktop --mac     # dmg + zip
bun run build:desktop --linux   # AppImage + deb, x64 and arm64
bun run build:desktop --all     # both
bun run build:desktop --win     # NSIS installer, x64 and arm64 (on Windows only)
bun run build:desktop --local   # this machine's arch only: AppImage on Linux, dmg on macOS, unpacked app on Windows
```

| platform | artifacts in `release/` |
| --- | --- |
| macOS | `SpecDriven-<version>-arm64.dmg`, `SpecDriven-<version>-arm64-mac.zip` |
| Linux | `SpecDriven-<version>-{x86_64,arm64}.AppImage`, `specdriven_<version>_{amd64,arm64}.deb` |
| Windows | `SpecDriven Setup <version>.exe`; with `--local`, `win-unpacked/SpecDriven.exe` (`win-arm64-unpacked` on ARM) |

Three steps: bundle the frontend into static files (served over the `app://`
protocol), bundle the Electron main process for Node, then hand both to
electron-builder. See [scripts/build-desktop.ts](../scripts/build-desktop.ts);
targets and architectures live under `"build"` in package.json — add `x64` to
the mac arch list for Intel artifacts. Linux cross-builds from macOS, so one
machine can cut a full release; macOS artifacts need macOS, and Windows ones
need Windows (off it, electron-builder needs Wine to stamp the executable), so
`--all` means macOS and Linux.

The desktop build needs the `specs/` symlink to resolve (electron-builder
stats every path in the project); see [DEVELOPMENT.md](DEVELOPMENT.md).

### What the bundle carries

The main-process bundle is self-contained: it carries Automerge's wasm
(`dist/electron/automerge_wasm_bg.wasm`) and cbor-extract's prebuilt native
extractor for every platform package bun installed
(`dist/electron/cbor-extract/`, unpacked from the asar), and reads both from
beside itself. Bun would otherwise bake each dependency's build-time
`__dirname` into the bundle, so a cross-built .deb or a copied .app died at
launch looking for the wasm in the builder's node_modules; the build now
fails on any such path.

The bundle registers the `specdriven://` url scheme with the OS — through
`Info.plist` on macOS, through the desktop entry's `MimeType` on Linux — so
spec links launch or focus the installed app. Builds are unsigned for now:
first launch needs Gatekeeper approval on macOS, and the `.deb` is installed
with `sudo apt install ./specdriven_<version>_amd64.deb` (the AppImage just
needs `chmod +x`).

### `--local`

`--local` is what [install.sh](../install.sh) and [install.ps1](../install.ps1)
run. It skips the `.deb`, whose packager (fpm) runs a bundled Ruby that needs
`libcrypt.so.1` — missing on Arch and other non-Debian distros unless
`libxcrypt-compat` is installed — and the other architecture, which nobody on
that machine would start. On Windows it packages no installer at all: the
unpacked app is what install.ps1 starts and points the Start menu at.

### Linux packaging settings

Two Linux settings are load-bearing and easy to lose, both verified by
installing the artifacts in bare Debian and Ubuntu containers:
`deb.depends` adds `libasound2t64 | libasound2` (Electron loads ALSA;
electron-builder's default list omits it, and the t64 name has to come first
or apt picks an OSS stub with missing symbols), and `toolsets.appimage` pins
the static AppImage runtime — the legacy default builds an arm64 runtime
linked against `libz.so`, which no ordinary desktop has.

## Checking that a build starts

To check that a build actually starts — and starts again — run the restart
crash test:

```sh
bun run test:desktop                # build, package the unpacked app, launch it 3 times
bun run test:desktop --no-build     # the same against what release/ already holds
bun run test:desktop --unpackaged   # skip electron-builder: node_modules' electron on dist/
```

Each launch runs on a throwaway profile, waits for the window to render,
holds a few seconds, then asks the app to quit (SIGTERM, which Electron
treats as `app.quit()`); a launch fails on a crash, an uncaught exception in
the main process, a window that never renders, or a quit that hangs. Logs, a
screenshot per launch and `summary.json` land in `dist/crash-test/`. Headless
Linux gets an Xvfb of its own. The details, and how to read a failure, are in
[.claude/skills/electron-crash-test/SKILL.md](../.claude/skills/electron-crash-test/SKILL.md).

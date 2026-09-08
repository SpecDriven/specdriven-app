#!/bin/sh
#
# SpecDriven installer — specs/app/installation.feature.md "install via curl".
#
#   curl -fsSL https://raw.githubusercontent.com/SpecDriven/specdriven-app-release/main/install.sh | sh
#
# SpecDriven ships as a source zip so you can put the code through your own
# security checks before building it. This script downloads the zip of a
# release from https://github.com/SpecDriven/specdriven-app-release, verifies
# it against that release's SHASUMS256.txt, unpacks it under
# ~/.specdriven/app, builds it, and starts it (on macOS, opens the .dmg).
# Building needs Bun, so if Bun
# is missing it offers to install that, and installs it only if you say yes;
# without Bun it stops after unpacking and says what to run by hand.
#
# To read the code before any of it runs, take the zip from the releases page
# instead and unpack it yourself — this script is the unattended path.
#
# Environment overrides:
#   SPECDRIVEN_VERSION       release to install, e.g. 0.1.40   (default: latest)
#   SPECDRIVEN_HOME          install prefix                     (default: $HOME/.specdriven)
#   SPECDRIVEN_RELEASES_URL  where the releases are             (default: the GitHub releases page)
#   SPECDRIVEN_INSTALL_BUN   answer the Bun question up front   (default: ask; 1 installs, 0 skips)
#   BUN_INSTALL              where Bun would go                 (default: $HOME/.bun)
#   SPECDRIVEN_BUN_INSTALLER_URL  Bun's installer               (default: https://bun.sh/install)
#
# POSIX sh on purpose: this runs on whatever /bin/sh the machine has, before
# we know anything about it.

set -eu

RELEASES_URL="${SPECDRIVEN_RELEASES_URL:-https://github.com/SpecDriven/specdriven-app-release/releases}"
RELEASES_URL="${RELEASES_URL%/}"
PREFIX="${SPECDRIVEN_HOME:-$HOME/.specdriven}"
APP_DIR="$PREFIX/app"
VERSION="${SPECDRIVEN_VERSION:-latest}"
VERSION="${VERSION#v}"

TMP_DIR=""
UNPACK_DIR=""
BUN_TMP=""
# Plain `if`s, not `&&` chains: a chain that stops short returns non-zero, and
# some shells make the EXIT trap's status the script's own.
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
  if [ -n "$UNPACK_DIR" ] && [ -d "$UNPACK_DIR" ]; then rm -rf "$UNPACK_DIR"; fi
  if [ -n "$BUN_TMP" ] && [ -d "$BUN_TMP" ]; then rm -rf "$BUN_TMP"; fi
}
trap cleanup EXIT INT TERM

die() {
  printf '\nerror: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '%s\n' "$1"
}

# --- refuse what cannot work here ---------------------------------------------

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    die "this installer needs a Unix shell.
On Windows, download specdriven-<version>-src.zip from
$RELEASES_URL, check it against SHASUMS256.txt, and unzip it."
    ;;
esac

# --- pick a downloader ----------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
  # --fail so an HTML error page never lands on disk as a "zip".
  download() { curl -fsSL "$1" -o "$2"; }
  # GitHub answers /releases/latest with a redirect to /releases/tag/v<version>.
  latest_tag() {
    curl -fsSL -o /dev/null -w '%{url_effective}' "$RELEASES_URL/latest"
  }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -qO "$2" "$1"; }
  latest_tag() {
    # Stop at the redirect and read where it points; wget's exit status is
    # non-zero for a refused redirect, so only the parsed header matters.
    wget -S --max-redirect=0 -O /dev/null "$RELEASES_URL/latest" 2>&1 \
      | sed -n 's/^ *[Ll]ocation: *\([^[:space:]]*\).*/\1/p' | tail -n 1
  }
else
  die "need curl or wget to download SpecDriven"
fi

# --- pick an unzipper -----------------------------------------------------------

if command -v unzip >/dev/null 2>&1; then
  extract() { unzip -q "$1" -d "$2"; }
elif command -v bsdtar >/dev/null 2>&1; then
  extract() { bsdtar -xf "$1" -C "$2"; }
elif command -v python3 >/dev/null 2>&1; then
  extract() {
    python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$1" "$2"
  }
else
  die "need unzip (or bsdtar, or python3) to unpack the release"
fi

# --- pick a checksum tool -------------------------------------------------------

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  # The whole point of shipping source is that you can check it; an install
  # that cannot be verified is not one this script will do.
  die "need sha256sum or shasum to verify the download"
fi

# --- resolve the version --------------------------------------------------------

# Digits and dots only, three fields: anything else is a mistyped override, a
# redirect that went somewhere unexpected, or a tag this script was not
# written for — all of which are refused before their name reaches a URL.
is_version() {
  case "$1" in
    *[!0-9.]*|.*|*.|*..*) return 1 ;;
    [0-9]*.[0-9]*.[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$VERSION" = "latest" ]; then
  location="$(latest_tag || true)"
  tag="${location##*/}"
  VERSION="${tag#v}"
  [ "$tag" != "$VERSION" ] && is_version "$VERSION" \
    || die "could not find the latest release at $RELEASES_URL/latest"
fi

is_version "$VERSION" \
  || die "\"$VERSION\" is not a release version (expected something like 0.1.40)"

ZIP="specdriven-$VERSION-src.zip"
TARGET="$APP_DIR/specdriven-$VERSION"

# --- already here? --------------------------------------------------------------

if [ -e "$TARGET" ]; then
  # Someone may have run `bun install` or built in there; never throw that
  # away behind their back.
  info "SpecDriven $VERSION is already unpacked at $TARGET — not unpacking over it."
  info "(Delete that directory first to unpack it again.) Building it as it stands."
else
  # --- download -------------------------------------------------------------------

  TMP_DIR="$(mktemp -d)"
  base="$RELEASES_URL/download/v$VERSION"

  info "Downloading SpecDriven $VERSION source…"
  download "$base/$ZIP" "$TMP_DIR/$ZIP" \
    || die "failed to download $base/$ZIP"
  download "$base/SHASUMS256.txt" "$TMP_DIR/SHASUMS256.txt" \
    || die "failed to download $base/SHASUMS256.txt — refusing to install unverified"

  # --- verify ---------------------------------------------------------------------

  expected="$(grep " $ZIP\$" "$TMP_DIR/SHASUMS256.txt" | cut -d' ' -f1 || true)"
  [ -n "$expected" ] || die "no checksum listed for $ZIP — refusing to install"
  actual="$(sha256_of "$TMP_DIR/$ZIP")"
  [ "$actual" = "$expected" ] \
    || die "checksum mismatch for $ZIP
  expected $expected
  got      $actual"
  info "Checksum verified."

  # --- unpack ---------------------------------------------------------------------

  mkdir -p "$APP_DIR"
  # Unpack beside the destination, then rename: one atomic step puts a complete
  # tree in place, so an interrupted install never leaves half a checkout.
  UNPACK_DIR="$(mktemp -d "$APP_DIR/.unpack.XXXXXX")"
  extract "$TMP_DIR/$ZIP" "$UNPACK_DIR"
  [ -d "$UNPACK_DIR/specdriven-$VERSION" ] \
    || die "unexpected archive layout: no specdriven-$VERSION/ directory inside $ZIP"
  mv "$UNPACK_DIR/specdriven-$VERSION" "$TARGET"

  # Keep exactly what was verified, for whoever wants to check it themselves.
  mv -f "$TMP_DIR/$ZIP" "$APP_DIR/$ZIP"
  printf '%s  %s\n' "$expected" "$ZIP" > "$APP_DIR/$ZIP.sha256"

  info "Unpacked to $TARGET"
fi

# --- point `current` at it ------------------------------------------------------

current="$APP_DIR/current"
if [ -L "$current" ] || [ ! -e "$current" ]; then
  rm -f "$current"
  ln -s "specdriven-$VERSION" "$current"
else
  info "warning: $current is not a symlink; not pointing it at specdriven-$VERSION."
fi

# --- Bun, which builds it -------------------------------------------------------

BUN_INSTALLER_URL="${SPECDRIVEN_BUN_INSTALLER_URL:-https://bun.sh/install}"
# Bun's own default, spelled out here so the question can name the directory
# before anything is downloaded. Someone else's BUN_INSTALL still wins.
BUN_DIR="${BUN_INSTALL:-$HOME/.bun}"

# Asked only when there is someone to answer. SPECDRIVEN_INSTALL_BUN answers it
# in advance — 1/yes installs, 0/no skips — so an unattended run never hangs on
# a prompt nobody sees.
wants_bun() {
  case "${SPECDRIVEN_INSTALL_BUN:-ask}" in
    1|y|Y|yes|Yes|YES) return 0 ;;
    0|n|N|no|No|NO) return 1 ;;
  esac
  # `curl | sh` hands the script's stdin to the pipe, so the question and its
  # answer both go to the terminal itself. No terminal, no consent: skip it.
  [ -r /dev/tty ] || return 1
  printf 'Bun is needed to build SpecDriven. Install it into %s now, as %s? [y/N] ' \
    "$BUN_DIR" "$(id -un)" > /dev/tty
  reply=""
  read -r reply < /dev/tty || return 1
  case "$reply" in
    y|Y|yes|Yes|YES) return 0 ;;
    *) info "Leaving Bun alone."; return 1 ;;
  esac
}

# Runs Bun's own installer under this user: it unpacks into $BUN_DIR and edits
# that user's shell rc files. No sudo, nothing system-wide, nothing as root.
install_bun() {
  if [ "$(id -u)" = "0" ]; then
    info "Refusing to install Bun as root — run this as the user who will build SpecDriven."
    return 1
  fi
  if ! command -v bash >/dev/null 2>&1; then
    info "Bun's installer needs bash, which is not on this machine."
    return 1
  fi
  BUN_TMP="$(mktemp -d)"
  # Downloaded, then run: the same script either way, but it lands on disk
  # first, so a failed download cannot be executed as half a script.
  if ! download "$BUN_INSTALLER_URL" "$BUN_TMP/install-bun.sh"; then
    info "Could not download Bun's installer from $BUN_INSTALLER_URL."
    return 1
  fi
  info ""
  # Braces: the ellipsis that follows would otherwise run into the name.
  info "Installing Bun from ${BUN_INSTALLER_URL}…"
  BUN_INSTALL="$BUN_DIR" bash "$BUN_TMP/install-bun.sh" || return 1
  [ -x "$BUN_DIR/bin/bun" ]
}

BUN=""
if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
  info ""
  info "Bun is installed ($BUN)."
elif wants_bun && install_bun; then
  BUN="$BUN_DIR/bin/bun"
  info ""
  info "Bun is installed ($BUN)."
  info "Add $BUN_DIR/bin to PATH to keep it for later; this install uses it either way."
  # `bun run build:desktop` shells out to bun and bunx by name.
  PATH="$BUN_DIR/bin:$PATH"
  export PATH
else
  info "Bun is not installed; get it from https://bun.sh first."
fi

# --- build it -------------------------------------------------------------------

if [ -z "$BUN" ]; then
  info ""
  info "Nothing has been built: Bun is what builds it. Once Bun is there:"
  info ""
  info "  cd $current"
  info "  bun install"
  info "  bun run start            # web app at http://localhost:3000"
  info "  bun run build:desktop    # desktop app in release/"
  exit 0
fi

info ""
info "Installing dependencies…"
( cd "$TARGET" && "$BUN" install ) || die "\`bun install\` failed in $TARGET"

info ""
info "Building the desktop app — this fetches Electron and takes a few minutes…"
( cd "$TARGET" && "$BUN" run build:desktop ) || die "\`bun run build:desktop\` failed in $TARGET"

# --- start it -------------------------------------------------------------------

# On Linux the AppImage is the app, so it is started here. On macOS nothing is
# started: the .dmg is opened at the very end instead, for dragging the app
# into Applications.
started=""
case "$(uname -s)" in
  Linux)
    for image in "$TARGET"/release/*.AppImage; do
      if [ -f "$image" ]; then
        chmod +x "$image"
        if [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
          info ""
          info "Starting ${image}…"
          # Detached, so the app outlives the shell that installed it.
          ( "$image" >/dev/null 2>&1 & )
          started="yes"
        else
          info ""
          info "No display to start it on. When there is one, run $image."
        fi
        break
      fi
    done
    ;;
esac

info ""
if [ -n "$started" ]; then
  info "SpecDriven $VERSION is running."
else
  info "SpecDriven $VERSION is built."
fi
info "The packaged app is in $TARGET/release; the web app runs from $current with:"
info ""
info "  bun run start            # http://localhost:3000"

# --- and, on a Mac, open the installer ------------------------------------------

# The .dmg is the copy to hand on; opening it last mounts it in Finder so it can
# be dragged into Applications. Linux has no equivalent, so nothing runs there.
case "$(uname -s)" in
  Darwin)
    dmg="$TARGET/release/SpecDriven-$VERSION-arm64.dmg"
    if [ -f "$dmg" ]; then
      info ""
      info "Opening ${dmg}…"
      open "$dmg"
    fi
    ;;
esac

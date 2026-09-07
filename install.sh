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
# ~/.specdriven/app, and prints how to build and run it. It builds nothing
# itself — the review comes first, on purpose.
#
# Environment overrides:
#   SPECDRIVEN_VERSION       release to install, e.g. 0.1.40   (default: latest)
#   SPECDRIVEN_HOME          install prefix                     (default: $HOME/.specdriven)
#   SPECDRIVEN_RELEASES_URL  where the releases are             (default: the GitHub releases page)
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
# Plain `if`s, not `&&` chains: a chain that stops short returns non-zero, and
# some shells make the EXIT trap's status the script's own.
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
  if [ -n "$UNPACK_DIR" ] && [ -d "$UNPACK_DIR" ]; then rm -rf "$UNPACK_DIR"; fi
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
  info "SpecDriven $VERSION is already unpacked at $TARGET — leaving it as it is."
  info "(Delete that directory first to unpack it again.)"
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

# --- what happens next ----------------------------------------------------------

info ""
info "Nothing has been built. Review the code, then build and run it:"
info ""
info "  cd $current"
info "  bun install"
info "  bun run start            # web app at http://localhost:3000"
info "  bun run build:desktop    # desktop installer in release/"
info ""
if command -v bun >/dev/null 2>&1; then
  info "Bun is installed ($(command -v bun))."
else
  info "Bun is not installed; get it from https://bun.sh first."
fi

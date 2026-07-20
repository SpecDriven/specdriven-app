#!/bin/sh
#
# SpecDriven installer.
#
#   curl -fsSL https://specdriven.app/install.sh | sh
#
# Environment overrides:
#   SPECDRIVEN_VERSION   version to install          (default: latest)
#   SPECDRIVEN_BASE_URL  where assets are hosted     (default: https://specdriven.app/dist)
#   SPECDRIVEN_HOME      install prefix              (default: $HOME/.specdriven)
#
# POSIX sh on purpose: this runs on whatever /bin/sh the machine has, before
# we know anything about it. See roadmap/deployment.md.

set -eu

VERSION="${SPECDRIVEN_VERSION:-latest}"
BASE_URL="${SPECDRIVEN_BASE_URL:-https://specdriven.app/dist}"
PREFIX="${SPECDRIVEN_HOME:-$HOME/.specdriven}"
BIN_DIR="$PREFIX/bin"

TMP_DIR=""
cleanup() {
  [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

die() {
  printf '\nerror: %s\n' "$1" >&2
  exit 1
}

info() {
  printf '%s\n' "$1"
}

# --- pick a downloader -------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
  # --fail so an HTML error page never lands on disk as a "binary".
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -qO "$2" "$1"; }
else
  die "need curl or wget to download SpecDriven"
fi

# --- detect platform ---------------------------------------------------------

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    die "Windows is not supported by this installer.
Download specdriven-windows-x64.exe from $BASE_URL/$VERSION/ and put it on your PATH."
    ;;
  *) die "unsupported operating system: $os" ;;
esac

case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) die "unsupported architecture: $arch" ;;
esac

asset="specdriven-$os-$arch"

# Bun's default x64 build needs AVX2. Older CPUs and some VMs don't have it,
# and the failure mode is an illegal-instruction crash with no explanation,
# so fall back to the baseline build rather than let that happen.
if [ "$os" = "linux" ] && [ "$arch" = "x64" ]; then
  if [ -r /proc/cpuinfo ] && ! grep -q '\bavx2\b' /proc/cpuinfo; then
    asset="specdriven-linux-x64-baseline"
    info "No AVX2 detected; using the baseline build."
  fi
fi

# --- download ----------------------------------------------------------------

TMP_DIR="$(mktemp -d)"
url="$BASE_URL/$VERSION/$asset"

info "Installing SpecDriven ($VERSION) for $os-$arch…"

download "$url" "$TMP_DIR/$asset" \
  || die "failed to download $url"

# --- verify ------------------------------------------------------------------

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  sha256_of() { return 1; }
fi

if download "$BASE_URL/$VERSION/SHASUMS256.txt" "$TMP_DIR/SHASUMS256.txt"; then
  expected="$(grep " $asset\$" "$TMP_DIR/SHASUMS256.txt" | cut -d' ' -f1 || true)"
  if [ -z "$expected" ]; then
    die "no checksum listed for $asset — refusing to install"
  fi
  if actual="$(sha256_of "$TMP_DIR/$asset")"; then
    [ "$actual" = "$expected" ] \
      || die "checksum mismatch for $asset
  expected $expected
  got      $actual"
    info "Checksum verified."
  else
    info "warning: no sha256 tool found; skipping checksum verification."
  fi
else
  die "failed to download SHASUMS256.txt — refusing to install unverified"
fi

# --- install -----------------------------------------------------------------

mkdir -p "$BIN_DIR"
chmod +x "$TMP_DIR/$asset"
# Move into place last, so an interrupted install never leaves a half-written
# binary where a working one used to be.
mv -f "$TMP_DIR/$asset" "$BIN_DIR/specdriven"

info "Installed to $BIN_DIR/specdriven"

# --- PATH --------------------------------------------------------------------

case ":$PATH:" in
  *":$BIN_DIR:"*)
    info ""
    info "Run: specdriven"
    ;;
  *)
    case "${SHELL##*/}" in
      zsh)  rc="$HOME/.zshrc" ;;
      bash) rc="$HOME/.bashrc" ;;
      fish) rc="$HOME/.config/fish/config.fish" ;;
      *)    rc="your shell profile" ;;
    esac
    info ""
    info "$BIN_DIR is not on your PATH. Add it to $rc:"
    if [ "${SHELL##*/}" = "fish" ]; then
      info "  fish_add_path $BIN_DIR"
    else
      info "  export PATH=\"$BIN_DIR:\$PATH\""
    fi
    info ""
    info "Then run: specdriven"
    ;;
esac

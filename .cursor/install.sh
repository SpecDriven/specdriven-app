#!/usr/bin/env bash
# Cloud Agent bootstrap for the SpecDriven app.
#
# Installs the pinned Bun toolchain (kept in step with the version in
# .github/workflows/test.yml) when it is missing, then refreshes the project
# dependencies from the committed lockfile. Idempotent and non-interactive:
# safe to run repeatedly and against a warm checkout.
set -euo pipefail

# Keep in step with .github/workflows/test.yml (oven-sh/setup-bun bun-version).
BUN_VERSION="1.3.14"

if ! command -v bun >/dev/null 2>&1; then
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
  # install, start and terminals each run in their own shell, so put bun on a
  # PATH they all inherit. Fall back to the per-user install dir when there is
  # no passwordless sudo (this run's PATH is extended either way).
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo install -m 0755 "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
    sudo ln -sf /usr/local/bin/bun /usr/local/bin/bunx
  fi
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

echo "Using bun $(bun --version) at $(command -v bun)"

# --frozen-lockfile mirrors CI: install exactly what bun.lock pins.
bun install --frozen-lockfile

#!/bin/bash
# Called by the PagerMonitor web UI update button.
# Pulls new code, upgrades system + multimon-ng, rebuilds — but does NOT touch
# the systemd service. The Node.js backend handles the service restart after exit.

set -e
PAGEMON_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Privilege helper ──────────────────────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo &>/dev/null; then
  SUDO="sudo"
else
  echo "✗ sudo not found and not running as root"
  exit 1
fi

# ── Detect server-only mode (no SDR → skip multimon-ng) ───────────────────────
SDR_DISABLED=0
grep -qE "^DISABLE_SDR=true" "$PAGEMON_DIR/backend/.env" 2>/dev/null && SDR_DISABLED=1

# ── multimon-ng helpers ────────────────────────────────────────────────────────
_mmon_build() {
  local tag="$1"
  echo "  ► Building multimon-ng ${tag} from source…"
  $SUDO apt-get install -y --no-install-recommends cmake build-essential libpulse-dev libx11-dev
  local tmp; tmp=$(mktemp -d)
  curl -sL "https://github.com/EliasOenal/multimon-ng/archive/refs/tags/${tag}.tar.gz" \
    | tar xz -C "$tmp"
  local src; src=$(find "$tmp" -maxdepth 1 -type d -name 'multimon-ng*' | head -1)
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
    > /dev/null 2>&1
  make -C "$src/build" -j"$(nproc)"
  $SUDO make -C "$src/build" install
  rm -rf "$tmp"
  echo "  ✓ multimon-ng ${tag} installed"
}

check_multimon_ng() {
  echo ""
  echo "► Checking multimon-ng…"
  local installed=""
  if command -v multimon-ng &>/dev/null; then
    installed=$(multimon-ng --version 2>&1 | grep -oP '\d+\.\d+\.\d+' | head -1)
    echo "  Installed : ${installed:-unknown}"
  else
    echo "  Installed : not found"
  fi

  local latest="" resp=""
  resp=$(curl -sf --max-time 10 \
    "https://api.github.com/repos/EliasOenal/multimon-ng/releases/latest" 2>/dev/null) \
    && latest=$(echo "$resp" | grep -oP '"tag_name":\s*"\K[^"]+' | head -1)

  if [ -z "$latest" ]; then
    echo "  ⚠ Cannot reach GitHub — skipping multimon-ng check"
    return
  fi

  local latest_v="${latest#v}"
  local installed_v="${installed#v}"
  echo "  Latest    : ${latest_v}"

  if [ -n "$installed_v" ] && [ "$installed_v" = "$latest_v" ]; then
    echo "  ✓ Already up to date"
    return
  fi

  [ -n "$installed_v" ] \
    && echo "  ↑ Upgrading ${installed_v} → ${latest_v}…" \
    || echo "  ↓ Installing ${latest_v} from source…"

  _mmon_build "$latest"
}

# ══════════════════════════════════════════════════════════════════════════════
echo "════════════════════════════════════════════"
echo "  PagerMonitor Update"
echo "════════════════════════════════════════════"
echo ""

# ── 1. Pull latest code ────────────────────────────────────────────────────────
echo "► Pulling latest code from GitHub…"
if git -C "$PAGEMON_DIR" rev-parse --git-dir &>/dev/null; then
  git -C "$PAGEMON_DIR" pull --ff-only
  echo "  ✓ Done"
else
  echo "  ⚠ Not a git repository — skipping git pull"
fi

# ── 2. System packages ─────────────────────────────────────────────────────────
echo ""
echo "► Updating system packages…"
$SUDO apt-get update -qq
$SUDO apt-get upgrade -y
echo "  ✓ Done"

# ── 3. multimon-ng ────────────────────────────────────────────────────────────
if [ $SDR_DISABLED -eq 0 ]; then
  check_multimon_ng
fi

# ── 4. Backend dependencies ───────────────────────────────────────────────────
echo ""
echo "► Installing backend dependencies…"
cd "$PAGEMON_DIR/backend"
npm install --omit=dev
echo "  ✓ Done"

# ── 5. Frontend rebuild ───────────────────────────────────────────────────────
echo ""
echo "► Building frontend…"
cd "$PAGEMON_DIR/frontend"
npm install
npm run build
echo "  ✓ Done"

echo ""
echo "════════════════════════════════════════════"
echo "  Update complete — service restarting…"
echo "════════════════════════════════════════════"

#!/bin/bash
# PagerMonitor Client Updater
# Lightweight updater for standalone remote clients (no frontend build).
# Run manually or triggered remotely from the server admin panel.
set -e
export DEBIAN_FRONTEND=noninteractive
DIR="$(cd "$(dirname "$0")" && pwd)"

# ── rtl_airband: only needed if a dongle is set to multi/airband mode ─────────
# Best-effort build from source — package availability/build flags vary by
# distro version, so check the live logs here (or via the server's Update
# panel) if this step fails. Skips instantly once installed.
# NFM support requires -DNFM=ON at build time (not the cmake default) — the
# marker file lets us tell a build from before this was added apart from one
# that actually has NFM, and force exactly one rebuild for the former.
AIRBAND_NFM_MARK="/usr/local/bin/.pagermonitor-airband-nfm-ok"
_airband_build() {
  local ref="$1"
  echo "  ► Building rtl_airband (${ref}) from source…"
  sudo apt-get install -y --no-install-recommends \
    cmake build-essential pkg-config git \
    libconfig++-dev libfftw3-dev librtlsdr-dev libshout3-dev libmp3lame-dev
  local tmp; tmp=$(mktemp -d)
  git clone --depth 1 --branch "$ref" https://github.com/szpajder/RTLSDR-Airband.git "$tmp/src" 2>/dev/null \
    || git clone --depth 1 https://github.com/szpajder/RTLSDR-Airband.git "$tmp/src"
  cmake -S "$tmp/src" -B "$tmp/src/build" -DCMAKE_BUILD_TYPE=Release -DNFM=ON
  make -C "$tmp/src/build" -j"$(nproc)"
  sudo make -C "$tmp/src/build" install
  sudo touch "$AIRBAND_NFM_MARK"
  rm -rf "$tmp"
  echo "  ✓ rtl_airband installed from source"
}

check_rtl_airband() {
  echo ""
  echo "► Checking rtl_airband (only used if a dongle is set to multi/airband mode)…"
  if command -v rtl_airband &>/dev/null && [ -f "$AIRBAND_NFM_MARK" ]; then
    echo "  ✓ Already installed — delete $AIRBAND_NFM_MARK to force a rebuild"
    return
  fi
  local latest=""
  latest=$(curl -sf --max-time 10 "https://api.github.com/repos/szpajder/RTLSDR-Airband/releases/latest" 2>/dev/null \
    | grep -oP '"tag_name":\s*"\K[^"]+' | head -1)
  _airband_build "${latest:-master}"
}

echo ""
echo "═══════════════════════════════════════"
echo "  PagerMonitor Client Updater"
echo "  Directory : $DIR"
echo "═══════════════════════════════════════"
echo ""

# ── 1. Pull latest code ───────────────────────────────────────────────────────
# Handles both: full repo clone (client/ is a subdir) and standalone client dir
if git -C "$DIR" rev-parse --git-dir &>/dev/null; then
  echo "► Pulling latest code…"
  git -C "$DIR" pull --ff-only
  echo "  ✓ Done"
elif git -C "$DIR/.." rev-parse --git-dir &>/dev/null; then
  echo "► Pulling latest code (repo root)…"
  git -C "$DIR/.." pull --ff-only
  echo "  ✓ Done"
else
  echo "  ⚠ Not a git repository — skipping git pull"
  echo "    (downloaded as zip? Copy new client files manually)"
fi

echo ""

check_rtl_airband

echo ""

# ── 2. npm install (client deps only — no frontend build) ─────────────────────
echo "► Installing npm dependencies…"
npm install --prefix "$DIR" --omit=dev
echo "  ✓ Done"
echo ""

# ── 3. Restart service ────────────────────────────────────────────────────────
echo "► Restarting pagermonitor-client service…"
sudo systemctl restart pagermonitor-client
echo "  ✓ Done"

echo ""
echo "═══════════════════════════════════════"
echo "  Update complete"
echo "═══════════════════════════════════════"

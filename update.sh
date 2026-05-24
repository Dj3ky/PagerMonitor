#!/bin/bash
# PageMon updater — pulls latest code, upgrades system packages, re-runs installer
# Usage:
#   bash update.sh            # standard (with SDR)
#   bash update.sh --server   # server-only mode (no SDR tools)

set -e
PAGEMON_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Privilege helper ──────────────────────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo &>/dev/null; then
  SUDO="sudo"
else
  echo "✗ 'sudo' not found and not running as root."
  echo "  Either run as root : su -c 'bash update.sh'"
  echo "  Or install sudo    : apt-get install sudo"
  exit 1
fi

# ── Detect mode ───────────────────────────────────────────────────────────────
SERVER_ONLY=0
[ "$1" = "--server" ] && SERVER_ONLY=1
# Also auto-detect from .env
grep -qE "^DISABLE_SDR=true" "$PAGEMON_DIR/backend/.env" 2>/dev/null && SERVER_ONLY=1

echo ""
echo "═══════════════════════════════════════════"
echo "  PageMon Updater"
echo "  Directory : $PAGEMON_DIR"
[ $SERVER_ONLY -eq 1 ] && echo "  Mode      : server-only"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. Pull latest code ───────────────────────────────────────────────────────
if git -C "$PAGEMON_DIR" rev-parse --git-dir &>/dev/null; then
  echo "► Pulling latest code…"
  git -C "$PAGEMON_DIR" pull --ff-only
  echo "  ✓ Done"
else
  echo "  ⚠ Not a git repository — skipping git pull"
  echo "    (downloaded as zip? Copy new files manually, then re-run)"
fi

echo ""

# ── 2. System packages ────────────────────────────────────────────────────────
echo "► Updating system packages…"
$SUDO apt-get update -qq
$SUDO apt-get upgrade -y
echo "  ✓ Done"
echo ""

# ── 3. Delegate rest to install.sh ───────────────────────────────────────────
# install.sh handles: multimon-ng upgrade → stop service → npm → build → restart
if [ $SERVER_ONLY -eq 1 ]; then
  bash "$PAGEMON_DIR/install.sh" --server
else
  bash "$PAGEMON_DIR/install.sh"
fi

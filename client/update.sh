#!/bin/bash
# PagerMonitor Client Updater
# Lightweight updater for standalone remote clients (no frontend build).
# Run manually or triggered remotely from the server admin panel.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

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

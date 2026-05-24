#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
USER="$(whoami)"
NODE="$(which node 2>/dev/null || echo '/usr/bin/node')"

echo ""
echo "═══════════════════════════════════════"
echo "  PagerMonitor Client Installer"
echo "  User: $USER  Node: $NODE"
echo "═══════════════════════════════════════"

# ── multimon-ng: auto-install/upgrade to latest GitHub release ────────────────
_mmon_build() {
  local tag="$1"
  echo "  ► Building multimon-ng ${tag} from source…"
  sudo apt-get install -y --no-install-recommends cmake build-essential libpulse-dev libx11-dev
  local tmp; tmp=$(mktemp -d)
  curl -sL "https://github.com/EliasOenal/multimon-ng/archive/refs/tags/${tag}.tar.gz" \
    | tar xz -C "$tmp"
  local src; src=$(find "$tmp" -maxdepth 1 -type d -name 'multimon-ng*' | head -1)
  cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
    > /dev/null 2>&1
  make -C "$src/build" -j"$(nproc)"
  sudo make -C "$src/build" install
  rm -rf "$tmp"
  echo "  ✓ multimon-ng ${tag} installed from source"
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
    echo "  ⚠ Cannot reach GitHub"
    if [ -z "$installed" ]; then
      echo "  → Falling back to: sudo apt-get install multimon-ng"
      sudo apt-get install -y multimon-ng
    else
      echo "  ✓ Using installed version $installed"
    fi
    return
  fi

  local latest_v="${latest#v}"
  local installed_v="${installed#v}"
  echo "  Latest    : ${latest_v} (github.com/EliasOenal/multimon-ng)"

  if [ -n "$installed_v" ] && [ "$installed_v" = "$latest_v" ]; then
    echo "  ✓ Already up to date"
    return
  fi

  [ -n "$installed_v" ] \
    && echo "  ↑ Upgrading ${installed_v} → ${latest_v}…" \
    || echo "  ↓ Installing ${latest_v} from source…"

  _mmon_build "$latest"
}

# Check hard requirements first
echo ""
echo "► Checking dependencies…"
for cmd in node rtl_fm; do
  command -v "$cmd" &>/dev/null && echo "  ✓ $cmd" || { echo "  ✗ $cmd missing — install it first"; exit 1; }
done

# multimon-ng: auto-install/upgrade from GitHub
check_multimon_ng

# Blacklist DVB-T driver
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/rtlsdr.conf > /dev/null

# udev rule
sudo tee /etc/udev/rules.d/20-rtlsdr.rules > /dev/null << 'UDEV'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", GROUP="plugdev", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666"
UDEV
sudo udevadm control --reload-rules && sudo udevadm trigger

# npm install
cd "$DIR" && npm install --omit=dev

# .env
[ ! -f "$DIR/.env" ] && cp "$DIR/.env.example" "$DIR/.env" && echo "  ✓ Created .env — edit it now!"

# systemd service
sudo tee /etc/systemd/system/pagermonitor-client.service > /dev/null << SVCEOF
[Unit]
Description=PagerMonitor Client — SDR forwarder
After=network.target dev-bus-usb.device
Wants=network.target
StartLimitBurst=5
StartLimitIntervalSec=120

[Service]
Type=simple
User=$USER
Group=$USER
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=$NODE src/index.js
Restart=on-failure
RestartSec=10
TimeoutStartSec=60
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pagermonitor-client

[Install]
WantedBy=multi-user.target
SVCEOF

sudo systemctl daemon-reload
sudo systemctl enable pagermonitor-client

echo ""
echo "═══════════════════════════════════════"
echo "  Done! Next steps:"
echo "  1. Edit .env: nano $DIR/.env"
echo "     Set SERVER_URL, CLIENT_KEY, RTL_FM_FREQ"
echo "  2. Start: sudo systemctl start pagermonitor-client"
echo "  3. Logs:  sudo journalctl -u pagermonitor-client -f"
echo "═══════════════════════════════════════"

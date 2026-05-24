#!/bin/bash
# PageMon install script for Raspberry Pi
# Run from the pagermonitor directory: cd ~/pagermonitor && bash install.sh

set -e
PAGEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
CURRENT_USER="$(whoami)"
NODE_PATH="$(which node 2>/dev/null || echo '/usr/bin/node')"
SERVER_ONLY=0
[ "$1" = "--server" ] && SERVER_ONLY=1

# Remember if the service was already running so we can restart it at the end
WAS_RUNNING=0
systemctl is-active --quiet pagermonitor 2>/dev/null && WAS_RUNNING=1

# ── Privilege helper ──────────────────────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo &>/dev/null; then
  SUDO="sudo"
else
  echo "✗ 'sudo' not found and not running as root."
  echo "  Either run as root : su -c 'bash install.sh'"
  echo "  Or install sudo    : apt-get install sudo"
  exit 1
fi

# ── multimon-ng: auto-install/upgrade to latest GitHub release ────────────────
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
      $SUDO apt-get install -y multimon-ng
    else
      echo "  ✓ Using installed version $installed"
    fi
    return
  fi

  # Strip possible leading 'v' for comparison (e.g. v1.5.1 → 1.5.1)
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

echo ""
echo "═══════════════════════════════════════════"
echo "  PageMon Installer"
echo "  Directory : $PAGEMON_DIR"
echo "  User      : $CURRENT_USER"
echo "  Node      : $NODE_PATH"
[ $SERVER_ONLY -eq 1 ] && echo "  Mode      : server-only (no SDR)"
echo "═══════════════════════════════════════════"
echo ""

# ── Check dependencies ────────────────────────────────────────────────────────
echo "► Checking dependencies…"
MISSING=0
for cmd in node npm; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "  ✗ $cmd not found — install: sudo apt install nodejs npm"; MISSING=1
  else echo "  ✓ $cmd $(command -v $cmd)"; fi
done
if [ $SERVER_ONLY -eq 0 ]; then
  if ! command -v rtl_fm &>/dev/null; then
    echo "  ✗ rtl_fm not found — install: sudo apt install rtl-sdr"; MISSING=1
  else echo "  ✓ rtl_fm $(command -v rtl_fm)"; fi
fi
[ $MISSING -eq 1 ] && echo "" && echo "Install missing dependencies first, then re-run." && exit 1

if [ $SERVER_ONLY -eq 0 ]; then
  check_multimon_ng
fi

if [ $SERVER_ONLY -eq 0 ]; then
  # ── Blacklist DVB-T driver ──────────────────────────────────────────────────
  echo ""
  echo "► Blacklisting DVB-T driver…"
  if ! grep -q "dvb_usb_rtl28xxu" /etc/modprobe.d/rtlsdr.conf 2>/dev/null; then
    echo 'blacklist dvb_usb_rtl28xxu' | $SUDO tee /etc/modprobe.d/rtlsdr.conf > /dev/null
    $SUDO modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true
    echo "  ✓ Blacklisted"
  else
    echo "  ✓ Already blacklisted"
  fi

  # ── Add user to plugdev for USB access ─────────────────────────────────────
  echo ""
  echo "► Adding $CURRENT_USER to plugdev group…"
  $SUDO usermod -aG plugdev "$CURRENT_USER"
  echo "  ✓ Done"
fi

# ── Stop service if running ───────────────────────────────────────────────────
if [ $WAS_RUNNING -eq 1 ]; then
  echo ""
  echo "► Stopping pagermonitor service…"
  $SUDO systemctl stop pagermonitor
  echo "  ✓ Stopped"
fi

# ── Backend deps ──────────────────────────────────────────────────────────────
echo ""
echo "► Installing backend dependencies…"
cd "$PAGEMON_DIR/backend"
npm install --omit=dev
echo "  ✓ Done"

# ── .env ──────────────────────────────────────────────────────────────────────
if [ ! -f "$PAGEMON_DIR/backend/.env" ]; then
  echo ""
  echo "► Creating .env…"
  cp "$PAGEMON_DIR/backend/.env.example" "$PAGEMON_DIR/backend/.env"
  echo "  ✓ Created — edit $PAGEMON_DIR/backend/.env to set RTL_FM_FREQ"
fi

# ── Frontend ──────────────────────────────────────────────────────────────────
echo ""
echo "► Building frontend…"
cd "$PAGEMON_DIR/frontend"
npm install
npm run build
echo "  ✓ Done"

# ── Data dir ──────────────────────────────────────────────────────────────────
mkdir -p "$PAGEMON_DIR/backend/data"

# ── systemd service ───────────────────────────────────────────────────────────
echo ""
echo "► Installing systemd service…"

if [ $SERVER_ONLY -eq 1 ]; then
  AFTER_UNITS="network.target"
else
  AFTER_UNITS="network.target dev-bus-usb.device"
fi

$SUDO tee /etc/systemd/system/pagermonitor.service > /dev/null << EOF
[Unit]
Description=PageMon — Real-time Pager Monitor
After=$AFTER_UNITS
Wants=network.target
StartLimitBurst=5
StartLimitIntervalSec=120

[Service]
Type=simple
User=$CURRENT_USER
Group=$CURRENT_USER
WorkingDirectory=$PAGEMON_DIR/backend
EnvironmentFile=$PAGEMON_DIR/backend/.env
ExecStart=$NODE_PATH src/index.js
Restart=on-failure
RestartSec=10
TimeoutStartSec=60
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pagermonitor

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable pagermonitor
echo "  ✓ Service installed and enabled at boot"

# ── Sudoers rule for web-triggered updates ────────────────────────────────────
echo ""
echo "► Configuring sudoers for web updates…"
SUDOERS_CONTENT="$CURRENT_USER ALL=(ALL) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /bin/systemctl, /usr/bin/systemctl, /usr/bin/make, /usr/local/bin/make"
echo "$SUDOERS_CONTENT" | $SUDO tee /tmp/pm-sudoers-check > /dev/null
if $SUDO visudo -c -f /tmp/pm-sudoers-check 2>/dev/null; then
  $SUDO cp /tmp/pm-sudoers-check /etc/sudoers.d/pagermonitor
  $SUDO chmod 440 /etc/sudoers.d/pagermonitor
  echo "  ✓ Done"
else
  echo "  ⚠ Sudoers validation failed — web updates may need manual sudo"
fi
$SUDO rm -f /tmp/pm-sudoers-check

if [ $SERVER_ONLY -eq 0 ]; then
  # ── udev rule for RTL-SDR ───────────────────────────────────────────────────
  echo ""
  echo "► Installing RTL-SDR udev rule…"
  $SUDO tee /etc/udev/rules.d/20-rtlsdr.rules > /dev/null << 'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", GROUP="plugdev", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666"
EOF
  $SUDO udevadm control --reload-rules
  $SUDO udevadm trigger
  echo "  ✓ udev rules installed"
fi

# ── Start / restart service ───────────────────────────────────────────────────
IP=$(hostname -I 2>/dev/null | awk '{print $1}')

echo ""
echo "═══════════════════════════════════════════"
if [ $WAS_RUNNING -eq 1 ]; then
  echo "  Update complete!"
else
  echo "  Installation complete!"
fi
echo "═══════════════════════════════════════════"
echo ""

if [ $WAS_RUNNING -eq 1 ]; then
  # ── Re-install: just restart and show status ──────────────────────────────
  echo "► Restarting pagermonitor service…"
  $SUDO systemctl start pagermonitor
  sleep 2
  if $SUDO systemctl is-active --quiet pagermonitor; then
    echo "  ✓ pagermonitor is running"
  else
    echo "  ✗ Service failed to start — check logs:"
    echo "     sudo journalctl -u pagermonitor -n 30"
  fi
  echo ""
  echo "  Dashboard : http://${IP:-<pi-ip>}:3000"
  echo "  Logs      : sudo journalctl -u pagermonitor -f"
else
  # ── Fresh install: guide user through first-time config ───────────────────
  if [ $SERVER_ONLY -eq 1 ]; then
    echo "  1. Enable server-only mode:"
    echo "     nano $PAGEMON_DIR/backend/.env"
    echo "     → Set DISABLE_SDR=true"
    echo ""
    echo "  2. Start PageMon:"
    echo "     sudo systemctl start pagermonitor"
    echo ""
    echo "  3. Open in browser and generate a client key:"
    echo "     http://${IP:-<server-ip>}:3000"
    echo "     → Admin → Client Key → Generate → copy for RPi client"
  else
    echo "  1. Set your frequency:"
    echo "     nano $PAGEMON_DIR/backend/.env"
    echo "     → RTL_FM_FREQ=your_frequency  (e.g. 152.240M)"
    echo ""
    echo "  2. Start PageMon:"
    echo "     sudo systemctl start pagermonitor"
    echo ""
    echo "  3. Watch logs:"
    echo "     sudo journalctl -u pagermonitor -f"
    echo ""
    echo "  4. Open in browser:"
    echo "     http://${IP:-<pi-ip>}:3000"
    echo ""
    echo "  NOTE: You may need to log out and back in"
    echo "  for plugdev group membership to take effect."
  fi
fi
echo ""

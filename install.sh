#!/bin/bash
# PageMon install script for Raspberry Pi
# Run from the pagermonitor directory: cd ~/pagermonitor && bash install.sh

set -e
PAGEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
CURRENT_USER="$(whoami)"
NODE_PATH="$(which node 2>/dev/null || echo '/usr/bin/node')"
SERVER_ONLY=0
[ "$1" = "--server" ] && SERVER_ONLY=1

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
  for cmd in rtl_fm multimon-ng; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "  ✗ $cmd not found — install: sudo apt install rtl-sdr multimon-ng"; MISSING=1
    else echo "  ✓ $cmd $(command -v $cmd)"; fi
  done
fi
[ $MISSING -eq 1 ] && echo "" && echo "Install missing dependencies first, then re-run." && exit 1

if [ $SERVER_ONLY -eq 0 ]; then
  # ── Blacklist DVB-T driver ──────────────────────────────────────────────────
  echo ""
  echo "► Blacklisting DVB-T driver…"
  if ! grep -q "dvb_usb_rtl28xxu" /etc/modprobe.d/rtlsdr.conf 2>/dev/null; then
    echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/rtlsdr.conf > /dev/null
    sudo modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true
    echo "  ✓ Blacklisted"
  else
    echo "  ✓ Already blacklisted"
  fi

  # ── Add user to plugdev for USB access ─────────────────────────────────────
  echo ""
  echo "► Adding $CURRENT_USER to plugdev group…"
  sudo usermod -aG plugdev "$CURRENT_USER"
  echo "  ✓ Done"
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

sudo tee /etc/systemd/system/pagermonitor.service > /dev/null << EOF
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

sudo systemctl daemon-reload
sudo systemctl enable pagermonitor
echo "  ✓ Service installed and enabled at boot"

if [ $SERVER_ONLY -eq 0 ]; then
  # ── udev rule for RTL-SDR ───────────────────────────────────────────────────
  echo ""
  echo "► Installing RTL-SDR udev rule…"
  sudo tee /etc/udev/rules.d/20-rtlsdr.rules > /dev/null << 'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", GROUP="plugdev", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666"
EOF
  sudo udevadm control --reload-rules
  sudo udevadm trigger
  echo "  ✓ udev rules installed"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  Installation complete!"
echo "═══════════════════════════════════════════"
echo ""
if [ $SERVER_ONLY -eq 1 ]; then
  echo "  1. Enable server-only mode:"
  echo "     nano $PAGEMON_DIR/backend/.env"
  echo "     → Set DISABLE_SDR=true"
  echo ""
  echo "  2. Start PageMon now:"
  echo "     sudo systemctl start pagermonitor"
  echo ""
  echo "  3. Open in browser and generate a client key:"
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "     http://${IP:-<server-ip>}:3000"
  echo "     → Admin → Client Key → Generate → copy for RPi client"
else
  echo "  1. Set your frequency:"
  echo "     nano $PAGEMON_DIR/backend/.env"
  echo "     → Set RTL_FM_FREQ=your_frequency (e.g. 152.240M)"
  echo ""
  echo "  2. Start PageMon now:"
  echo "     sudo systemctl start pagermonitor"
  echo ""
  echo "  3. Watch logs:"
  echo "     sudo journalctl -u pagermonitor -f"
  echo ""
  echo "  4. Open in browser:"
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "     http://${IP:-<pi-ip>}:3000"
  echo ""
  echo "  NOTE: You may need to log out and back in"
  echo "  for plugdev group membership to take effect."
fi
echo ""

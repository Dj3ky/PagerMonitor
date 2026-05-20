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

# Check deps
for cmd in node rtl_fm multimon-ng; do
  command -v "$cmd" &>/dev/null && echo "  ✓ $cmd" || { echo "  ✗ $cmd missing"; exit 1; }
done

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

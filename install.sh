#!/bin/bash
# PagerMonitor install script for Raspberry Pi
# Run from the pagermonitor directory: cd ~/pagermonitor && bash install.sh

set -e
export DEBIAN_FRONTEND=noninteractive
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

# Fresh Raspberry Pi OS images often run unattended-upgrades/apt-daily in the background
# right after first boot, holding the dpkg lock for a few minutes — retry instead of
# failing outright (confirmed in the field: "Could not get lock /var/lib/dpkg/lock-frontend",
# worked fine on a bare manual re-run once that background process finished).
apt_retry() {
  local tries=0
  until "$@"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 20 ]; then echo "  ✗ apt-get still failing after multiple retries — giving up"; return 1; fi
    echo "  ⏳ apt-get busy (dpkg lock held by another process?) — retrying in 10s… (attempt $tries)"
    sleep 10
  done
}

# ── multimon-ng: auto-install/upgrade to latest GitHub release ────────────────
_mmon_build() {
  local tag="$1"
  echo "  ► Building multimon-ng ${tag} from source…"
  apt_retry $SUDO apt-get install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" \
    --no-install-recommends cmake build-essential libpulse-dev libx11-dev
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
      apt_retry $SUDO apt-get install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" multimon-ng
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

# ── rtl_airband: only needed if a dongle is set to multi/airband mode ─────────
# Best-effort build from source — package availability/build flags vary by
# distro version, so check the output here (or Admin → System → Update's live
# log) if this step fails. Skips instantly once installed.
# NFM support requires -DNFM=ON at build time (not the cmake default) — the
# marker file lets us tell a build from before this was added apart from one
# that actually has NFM, and force exactly one rebuild for the former.
AIRBAND_NFM_MARK="/usr/local/bin/.pagermonitor-airband-nfm-ok"

# ── librtlsdr: RTL-SDR Blog's fork ─────────────────────────────────────────────
# RTL-SDR Blog-branded dongles (confirmed on both V3 and V4 during testing) need this
# fork instead of stock Debian librtlsdr for correct gain tables/tuner detection — stock
# librtlsdr can misbehave with these dongles, especially under rtl_airband's more demanding
# real-time multi-channel operation (a client that works fine in single/rtl_fm mode but
# fails specifically in multi/airband mode is a symptom of this).
LIBRTLSDR_BLOG_MARK="/usr/local/bin/.pagermonitor-librtlsdr-blog-ok"
_librtlsdr_blog_install() {
  echo "  ► Installing RTL-SDR Blog's librtlsdr fork (replaces stock librtlsdr)…"
  apt_retry $SUDO apt-get remove -y librtlsdr0 librtlsdr-dev rtl-sdr 2>/dev/null || true
  apt_retry $SUDO apt-get install -y --no-install-recommends cmake build-essential git libusb-1.0-0-dev pkg-config
  local tmp; tmp=$(mktemp -d)
  git clone --depth 1 https://github.com/rtlsdrblog/rtl-sdr-blog.git "$tmp/src"
  (
    cd "$tmp/src" && mkdir build && cd build \
      && cmake ../ -DINSTALL_UDEV_RULES=ON -DDETACH_KERNEL_DRIVER=ON \
      && make -j"$(nproc)" \
      && $SUDO make install
  )
  $SUDO cp "$tmp/src/rtl-sdr.rules" /etc/udev/rules.d/ 2>/dev/null || true
  $SUDO ldconfig
  $SUDO udevadm control --reload-rules && $SUDO udevadm trigger
  $SUDO touch "$LIBRTLSDR_BLOG_MARK"
  rm -rf "$tmp"
  # rtl_airband links against librtlsdr at build time — force it to rebuild against the
  # fork instead of whatever it was previously linked against.
  $SUDO rm -f "$AIRBAND_NFM_MARK"
  echo "  ✓ RTL-SDR Blog librtlsdr installed — rtl_airband will rebuild against it"
}

check_librtlsdr_blog() {
  echo ""
  echo "► Checking RTL-SDR Blog librtlsdr fork…"
  if [ -f "$LIBRTLSDR_BLOG_MARK" ]; then
    echo "  ✓ Already installed — delete $LIBRTLSDR_BLOG_MARK to force a reinstall"
    return
  fi
  _librtlsdr_blog_install
}

_airband_build() {
  local ref="$1"
  echo "  ► Building rtl_airband (${ref}) from source…"
  apt_retry $SUDO apt-get install -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" \
    --no-install-recommends cmake build-essential pkg-config git \
    libconfig++-dev libfftw3-dev librtlsdr-dev libshout3-dev libmp3lame-dev
  local tmp; tmp=$(mktemp -d)
  git clone --depth 1 --branch "$ref" https://github.com/rtl-airband/RTLSDR-Airband.git "$tmp/src" 2>/dev/null \
    || git clone --depth 1 https://github.com/rtl-airband/RTLSDR-Airband.git "$tmp/src"
  # rtl_airband's own CMakeLists.txt calls its version-detection script via execute_process()
  # with no WORKING_DIRECTORY set, so it inherits whatever directory we're in when cmake
  # runs — and that script just calls plain `git describe` with no explicit repo path, which
  # walks up from the CWD to find the nearest .git. If we invoke cmake from inside our own
  # repo checkout (e.g. `cd ~/pagermonitor/client && bash update.sh`), it describes OUR repo,
  # not the freshly cloned rtl_airband source — confirmed: a PagerMonitor commit hash showed
  # up in "rtl_airband -v" output. Run cmake from inside $tmp/src so it can only see its own.
  ( cd "$tmp/src" && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DNFM=ON )
  make -C "$tmp/src/build" -j"$(nproc)"
  $SUDO make -C "$tmp/src/build" install
  $SUDO touch "$AIRBAND_NFM_MARK"
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
  latest=$(curl -sf --max-time 10 "https://api.github.com/repos/rtl-airband/RTLSDR-Airband/releases/latest" 2>/dev/null \
    | grep -oP '"tag_name":\s*"\K[^"]+' | head -1)
  _airband_build "${latest:-master}"
}

echo ""
echo "═══════════════════════════════════════════"
echo "  PagerMonitor Installer"
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
  check_librtlsdr_blog
  check_rtl_airband
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
Description=PagerMonitor — Real-time Pager Monitor
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
    echo "  2. Start PagerMonitor:"
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
    echo "  2. Start PagerMonitor:"
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

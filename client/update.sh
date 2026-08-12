#!/bin/bash
# PagerMonitor Client Updater
# Lightweight updater for standalone remote clients (no frontend build).
# Run manually or triggered remotely from the server admin panel.
set -e
export DEBIAN_FRONTEND=noninteractive
DIR="$(cd "$(dirname "$0")" && pwd)"

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

# ── rtl_airband: only needed if a dongle is set to multi/airband mode ─────────
# Best-effort build from source — package availability/build flags vary by
# distro version, so check the live logs here (or via the server's Update
# panel) if this step fails. Skips instantly once installed.
# NFM support requires -DNFM=ON at build time (not the cmake default) — the
# marker file lets us tell a build from before this was added apart from one
# that actually has NFM, and force exactly one rebuild for the former.
AIRBAND_NFM_MARK="/usr/local/bin/.pagermonitor-airband-nfm-ok"

# ── librtlsdr: RTL-SDR Blog's fork ─────────────────────────────────────────────
# RTL-SDR Blog-branded dongles (confirmed on both V3 and V4 during testing) need this
# fork instead of stock Debian librtlsdr for correct gain tables/tuner detection — stock
# librtlsdr can misbehave with these dongles, especially under rtl_airband's more demanding
# real-time multi-channel operation (a client that works fine in single/rtl_fm mode but
# fails specifically in multi/airband mode is a symptom of this). This was previously only
# ever installed by hand on one test unit — automating it here so every client gets it via
# a normal remote update, no SSH required.
LIBRTLSDR_BLOG_MARK="/usr/local/bin/.pagermonitor-librtlsdr-blog-ok"
_librtlsdr_blog_install() {
  echo "  ► Installing RTL-SDR Blog's librtlsdr fork (replaces stock librtlsdr)…"
  apt_retry sudo apt-get remove -y librtlsdr0 librtlsdr-dev rtl-sdr 2>/dev/null || true
  apt_retry sudo apt-get install -y --no-install-recommends cmake build-essential git libusb-1.0-0-dev pkg-config
  local tmp; tmp=$(mktemp -d)
  git clone --depth 1 https://github.com/rtlsdrblog/rtl-sdr-blog.git "$tmp/src"
  (
    cd "$tmp/src" && mkdir build && cd build \
      && cmake ../ -DINSTALL_UDEV_RULES=ON -DDETACH_KERNEL_DRIVER=ON \
      && make -j"$(nproc)" \
      && sudo make install
  )
  sudo cp "$tmp/src/rtl-sdr.rules" /etc/udev/rules.d/ 2>/dev/null || true
  sudo ldconfig
  sudo udevadm control --reload-rules && sudo udevadm trigger
  sudo touch "$LIBRTLSDR_BLOG_MARK"
  rm -rf "$tmp"
  # rtl_airband links against librtlsdr at build time — force it to rebuild against the
  # fork instead of whatever it was previously linked against (installing this fork
  # *after* rtl_airband was already built made things worse, not better, until it was
  # explicitly rebuilt — see the NFM marker's own rebuild-trigger pattern below).
  sudo rm -f "$AIRBAND_NFM_MARK"
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
  apt_retry sudo apt-get install -y --no-install-recommends \
    cmake build-essential pkg-config git \
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
  latest=$(curl -sf --max-time 10 "https://api.github.com/repos/rtl-airband/RTLSDR-Airband/releases/latest" 2>/dev/null \
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

check_librtlsdr_blog
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

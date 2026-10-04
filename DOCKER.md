# PagerMonitor — Docker Setup

## Prerequisites

- Docker and Docker Compose installed
- For SDR mode: RTL-SDR dongle connected

## Quick Start

### Option A — Single device (RPi or PC with SDR dongle)

Everything on one machine: web server + SDR pipeline.

```bash
# 1. Clone the repo
git clone https://github.com/dj3ky/pagermonitor.git
cd pagermonitor

# 2. Create and edit config
make setup        # copies .env.example → .env
nano .env         # set RTL_FM_FREQ to your pager frequency

# 3. Start
make start

# 4. Open browser
# http://localhost:3000
# Login: admin / <see "First login" section below for the password>
```

### First login — finding your admin password

On first boot (empty database), PagerMonitor generates a random admin password and prints it once to the container log:

```bash
cd ~/
docker logs pagermonitor | grep "Default admin"
# ⚠  Default admin created  username=admin  password=3f9a1c...
```

**If you missed it**, set `DEFAULT_ADMIN_PASS` in `.env` and recreate the container with a fresh volume:

```bash
make stop

# Add a known password to .env
echo "DEFAULT_ADMIN_PASS=changeme123" >> .env

# Remove the data volume (all messages will be lost — back up first if needed)
docker volume rm pagermonitor-data

# Start again — the password will now be "changeme123"
make start
```

Change the password immediately after login: **Admin → Users → admin → Change password**.

### Option B — Distributed (server + remote RPi clients)

Server runs on a Proxmox VM / NAS / PC. One or more Raspberry Pis with SDR dongles forward messages to it.

**On the server:**
```bash
git clone https://github.com/dj3ky/pagermonitor.git
cd pagermonitor

make setup
# Edit .env — set DISABLE_SDR=true

make start-server
# Open http://server-ip:3000
# Go to Admin → SDR Client Key → generate a key
```

**On each Raspberry Pi:**
```bash
git clone https://github.com/dj3ky/pagermonitor.git
cd pagermonitor

cp client/.env.example client/.env
nano client/.env
# Set:
#   SERVER_URL=http://192.168.1.100:3000
#   CLIENT_KEY=<key from Admin → SDR Client Key>
#   CLIENT_ID=rpi-garage       ← unique name for this Pi
#   RTL_FM_FREQ=173.250M

make start-client
```

## Commands

| Command | Description |
|---|---|
| `make setup` | Copy `.env.example` → `.env` |
| `make start` | Start single-device mode |
| `make start-server` | Start server-only mode |
| `make start-client` | Start RPi client |
| `make logs` | Follow live logs |
| `make stop` | Stop containers |
| `make restart` | Restart containers |
| `make update` | Pull latest + rebuild |
| `make build` | Rebuild images (no cache) |
| `make clean` | Remove everything (**deletes database!**) |

## Configuration

All settings are in `.env`. Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `DISABLE_SDR` | `false` | `true` = server-only mode |
| `RTL_FM_FREQ` | `173.250M` | Pager frequency |
| `RTL_FM_GAIN` | `40` | SDR gain (0 = auto) |
| `RTL_FM_PPM` | `0` | Frequency correction |
| `MULTIMON_PROTOCOLS` | `POCSAG1200` | Protocols to decode |
| `LOG_LEVEL` | `info` | `error`/`warn`/`info`/`debug` |
| `DEFAULT_ADMIN_PASS` | _(random)_ | First-run admin password (min. 10 characters). If unset or shorter, a random password is generated and printed to the log. |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Which reverse proxies may set `X-Forwarded-For`, so the login rate limits see the real client IP. The default trusts proxies on the same host or a private network (nginx, Docker bridge). `true`/`false`, a hop count, or an address/subnet list |
| `CORS_ORIGINS` | `https://localhost,capacitor://localhost` | Comma-separated origins allowed to call the API cross-origin. The web UI is same-origin and needs no entry; the default covers the Android/iOS app. Add an origin only if another site must call this server |

See `.env.example` for all options with descriptions.

## Data persistence

The database is stored in a Docker volume `pagermonitor-data`. It persists across container restarts and rebuilds.

```bash
# Backup the database
docker compose exec pagermonitor wget -qO- http://localhost:3000/admin/backup/download \
  -H "Authorization: Bearer YOUR_TOKEN" > backup.pmbackup

# Or use Admin → Backup & Restore in the web UI
```

## Monitoring with Uptime Kuma

Add an HTTP monitor pointing to `http://your-server:3000/health`.
Expected response: `{"ok":true,"status":"healthy",...}`

## Updating

```bash
make update
# or manually:
git pull
docker compose down
docker compose up -d --build
```

## Troubleshooting

**SDR not detected:**
```bash
# Check if dongle is visible on host
lsusb | grep -i rtl

# Check container logs
make logs
```

**Port already in use:**
```bash
# Change port in .env
PORT=3001
make restart
```

**RTL-SDR: `usb_open error -3` (permission denied):**

The container can see the dongle but can't open it. Fix on the host:

```bash
# 1. Create a udev rule
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", MODE="0666", GROUP="plugdev"' \
  | sudo tee /usr/lib/udev/rules.d/20-rtlsdr.rules
sudo udevadm control --reload-rules && sudo udevadm trigger

# 2. Find the plugdev group ID
getent group plugdev   # e.g. plugdev:x:46:pi
```

Then add these two lines to the `pagermonitor` service in `docker-compose.yml`:

```yaml
privileged: true
user: "node:46"   # replace 46 with your actual plugdev GID
```

**RTL-SDR: `usb_open error -4` (no device / not accessible):**

The host kernel's built-in DVB driver has claimed the dongle before rtl_fm can open it. Blacklist it on the host, then replug the dongle and restart the container:

```bash
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtlsdr.conf
sudo rmmod dvb_usb_rtl28xxu          # unload immediately (no reboot needed)
sudo update-initramfs -u             # persist across reboots (Debian/Ubuntu/RPiOS)
```

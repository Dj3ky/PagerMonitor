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
# Login: admin / admin123 (change immediately in Admin → Users!)
```

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
| `DEFAULT_ADMIN_PASS` | `admin123` | First-run admin password |

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

**RTL-SDR permission error:**
```bash
# Add udev rule on host
echo 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", MODE="0666"' \
  | sudo tee /etc/udev/rules.d/rtl-sdr.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

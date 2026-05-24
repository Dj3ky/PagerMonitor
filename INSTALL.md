# PagerMonitor — Real-Time Pager Monitoring System

Decode POCSAG/FLEX pager transmissions with an RTL-SDR dongle and monitor them live from any browser.

---

## How it works

```
RTL-SDR dongle(s)
      │
  rtl_fm        — tunes to frequency, outputs raw PCM audio
      │
multimon-ng     — decodes POCSAG/FLEX protocol from audio
      │
Node.js server  — stores messages, serves web UI, sends notifications
      │
  Browser       — live feed via WebSocket, map, search, admin panel
```

---

## Deployment options

### Option A — Single device (RPi with SDR dongle)

RTL-SDR plugged directly into the Pi. Everything on one machine.

```
┌─────────────────────────────────────────────┐
│   Raspberry Pi (with RTL-SDR dongle)        │
│                                             │
│   rtl_fm → multimon-ng → Node.js server    │
│   React web UI (port 3000)                  │
│   SQLite database                           │
└─────────────────────────────────────────────┘
         ↑ any browser on your network
```

### Option B — Distributed (RPi client + server)

Minimal decoder on the Pi, everything else on a server (Proxmox VM, NAS, PC).

```
┌──────────────────────┐        ┌─────────────────────────────────────┐
│  Raspberry Pi         │        │  Server (Proxmox / NAS / PC)        │
│  (with RTL-SDR)       │  HTTP  │                                     │
│                       │ ─────► │  Node.js server (port 3000)         │
│  rtl_fm               │  POST  │  SQLite database                    │
│  multimon-ng          │        │  React web UI + admin panel         │
│  pagermonitor-client  │        │  Notifications + webhooks           │
└──────────────────────┘        └─────────────────────────────────────┘
                                          ↑ all browsers connect here
```

Multiple RPi clients can forward to the same server — useful for monitoring multiple frequencies from different locations.

---

## Quick start

### Native install (systemd)

#### Option A — Single device

```bash
# 1. Install dependencies
# Note: multimon-ng latest is built automatically from source by install.sh
sudo apt update && sudo apt install -y rtl-sdr nodejs npm

# 2. Clone and install
git clone https://github.com/dj3ky/pagermonitor.git ~/pagermonitor
cd ~/pagermonitor
bash install.sh

# 3. Configure
nano ~/pagermonitor/backend/.env
# Set RTL_FM_FREQ to your local pager frequency

# 4. Start
sudo systemctl start pagermonitor

# 5. Open browser
# http://<pi-ip>:3000
# Login: admin / <see "First login" section below for the password>
```

#### Option B — Server (no SDR dongle)

Run this on the machine that will host the web UI and database (Proxmox VM, NAS, PC).
No RTL-SDR hardware required — the RPi client (next section) forwards decoded messages here.

```bash
# 1. Install Node.js only (no SDR tools needed)
sudo apt update && sudo apt install -y nodejs npm

# 2. Clone and install
git clone https://github.com/dj3ky/pagermonitor.git ~/pagermonitor
cd ~/pagermonitor
bash install.sh --server

# 3. Configure
nano ~/pagermonitor/backend/.env
# Set DISABLE_SDR=true

# 4. Start
sudo systemctl start pagermonitor

# 5. Open browser and generate a client key for the RPi
# http://<server-ip>:3000
# Login: admin / <see "First login" section below for the password>
# Then: Admin → Client Key → Generate → copy the key
```

#### Option B — RPi client

Run this on the Raspberry Pi with the RTL-SDR dongle. It decodes pager traffic and
forwards it to the server set up above. No web UI runs on the Pi itself.

```bash
# 1. Install dependencies
# Note: multimon-ng latest is built automatically from source by client/install.sh
sudo apt update && sudo apt install -y rtl-sdr nodejs npm

# 2. Clone repo
git clone https://github.com/dj3ky/pagermonitor.git ~/pagermonitor

# 3. Run client installer (sets up systemd service pagermonitor-client)
cd ~/pagermonitor/client
bash install.sh

# 4. Configure
nano ~/pagermonitor/client/.env
# Required:
#   SERVER_URL=http://<server-ip>:3000
#   CLIENT_KEY=<key copied from Admin → Client Key on the server>
#   RTL_FM_FREQ=173.250M   (your local pager frequency)

# 5. Start
sudo systemctl start pagermonitor-client

# 6. Watch logs
sudo journalctl -u pagermonitor-client -f

# 7. Verify connection
# Server browser: Admin → SDR Clients — this Pi should appear as connected
```

### First login — finding your admin password

On first boot (empty database), PagerMonitor generates a random admin password and prints it once to the log:

```bash
sudo journalctl -u pagermonitor -n 50 --no-pager | grep "Default admin"
# ⚠  Default admin created  username=admin  password=3f9a1c...
```

**If you missed it**, set `DEFAULT_ADMIN_PASS` in `backend/.env` and wipe the user table so the first-run setup runs again:

```bash
# Stop the service
sudo systemctl stop pagermonitor

# Remove the database (all messages will be lost — back up first if needed)
rm ~/pagermonitor/backend/data/pagermonitor.db

# Set a known password for next start
echo "DEFAULT_ADMIN_PASS=changeme123" >> ~/pagermonitor/backend/.env

# Start again — the password will now be "changeme123"
sudo systemctl start pagermonitor
```

Change the password immediately after login: **Admin → Users → admin → Change password**.

### Docker

```bash
# Option A — single device
cp .env.example .env && nano .env
make start

# Option B — server only (no SDR)
# Set DISABLE_SDR=true in .env
make start-server

# RPi client (on the Pi)
cp client/.env.example client/.env && nano client/.env
make start-client

# Logs, stop, update
make logs
make stop
make update
```

See [DOCKER.md](DOCKER.md) for full Docker documentation.

---

## Configuration

Edit `backend/.env` (native) or `.env` (Docker):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `DISABLE_SDR` | `false` | `true` = server-only mode (no dongle) |
| `RTL_FM_FREQ` | `173.250M` | Pager frequency. Multiple: `173.250M:152.240M` |
| `RTL_FM_GAIN` | `40` | SDR gain in dB. `0` = auto AGC |
| `RTL_FM_PPM` | `0` | Frequency correction (run `rtl_test -p` to find) |
| `RTL_FM_DEVICE_INDEX` | `0` | Dongle index when using one dongle |
| `MULTIMON_PROTOCOLS` | `POCSAG1200` | Space-separated: `POCSAG512 POCSAG1200 FLEX` |
| `MULTIMON_POCSAG_CHARSET` | _(empty)_ | e.g. `ISO-8859-2` for Slovenian Š Č Ž |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `DEFAULT_ADMIN_PASS` | _(random)_ | First-run admin password. If unset, a random password is generated and printed to the startup log. |

All SDR settings can also be changed live in **Admin → SDR Control** without editing files.

### Multiple SDR dongles

To run multiple dongles in parallel on one machine, set `DONGLES` as a JSON array:

```bash
# backend/.env (native) or .env (Docker)
DONGLES=[{"device":0,"freq":"173.250M","gain":"40","protocols":"POCSAG1200"},{"device":1,"freq":"152.240M","gain":"35","protocols":"POCSAG512 FLEX"}]
```

Or configure per-dongle in **Admin → SDR Control → Multiple SDR dongles**.

---

## Admin panel

### Roles

| Role | Access |
|---|---|
| `admin` | Full access to all settings |
| `editor` | Aliases, groups, highlights, keyword alerts only |
| `viewer` | Read-only feed, map, archive, search |

### Tabs

| Group | Tab | Description |
|---|---|---|
| **SDR** | SDR Control | Start/stop/restart pipeline. Edit rtl_fm and multimon-ng settings. Multi-dongle config. |
| | Dead Air | Alert when no messages received for configurable time period |
| | Live Logs | Real-time rtl_fm and multimon-ng output |
| | SDR Clients | Monitor connected remote RPi clients |
| | Client Key | Generate authentication key for remote clients |
| **Messages** | Database | Stats, purge old messages, export CSV |
| | Archive | View/search archived messages, CSV export |
| | Statistics | Message counts by hour/day, protocol breakdown |
| | Dedup | Deduplicate identical messages within a time window |
| | Highlights | Regex/text rules to colour-highlight messages in feed |
| | Keyword Alerts | Flash/notify on messages matching keywords or patterns |
| **Notifications** | Services | Discord, Telegram, Gotify, Pushover, MQTT — test each; global filter below controls which messages are sent |
| | Webhooks | HTTP POST webhooks with HMAC-SHA256 signing |
| | Email (SMTP) | Send email notifications via any SMTP provider |
| | User preferences | Per-user email and push filters (by group, alias, capcode, or keyword) |
| **Aliases & Groups** | Groups | Organise aliases into groups/subgroups with colour coding |
| | Aliases | Friendly names for capcodes, CSV import/export |
| **System** | System | RAM, CPU, disk, uptime, connected clients |
| | Update | Compare installed vs latest GitHub commit — one-click update with live output |
| | Activity | Audit log of who changed what and when |
| | Backup & Restore | Download `.pmbackup`, restore from backup |
| | Audit Log | Full audit trail with filtering |
| **Site** | Site Settings | Site name, description, public read-only mode |
| | Users | Create/delete users, assign roles, reset passwords |

---

## Features

**Feed**
- Live WebSocket message feed — zero refresh needed
- Per-user NEW badge tracking across all devices
- Click any row to expand full details
- Filter by capcode, alias, or group with one click
- Pagination with load more — fetch older messages on demand
- Highlight rules colour-code matching messages
- Keyword alerts flash the browser for urgent messages

**Map**
- Pins for messages with GPS coordinates
- Three modes: individual pins, clustered, heatmap
- Fly-to when clicking map button on any message
- Marker popup with message details

**Message notes / annotations**
- Any user can add notes to any message
- Notes can be shared (visible to all) or private (only you)
- Note count badge on the message row
- Admins can delete any note

**Notifications**
- Discord — rich embeds with alias, group, maps link
- Telegram — MarkdownV2 formatted
- Gotify — self-hosted push
- Pushover — native URL button opens Google Maps
- MQTT — publish to any broker (Home Assistant, Mosquitto, etc.)
- Email — HTML formatted with Google Maps button
- Webhooks — HTTP POST to any endpoint with HMAC-SHA256

**Per-user notifications (email + push)**
- Each user sets independent filters for email and push: all / by group / by alias / by capcode / by keyword
- Users manage their own preferences from the profile panel (username button in header)
- Global filter (Admin → Notifications → Services) applies only to Discord, Telegram, Gotify, Pushover, and MQTT

**Password reset**
- "Forgot password" on login page → email with reset link (1 hour expiry)
- Requires email configured in Admin → Email and email set on user account

**Archive**
- Messages older than N hours auto-moved to `archive.db`
- Searchable archive panel with CSV export
- Archive DB size and status shown in Backup & Restore

**Backup & Restore**
- Download `.pmbackup` — contains both main and archive databases
- Restore from `.pmbackup` with overwrite confirmation
- Shows DB file size (including WAL) and last modified time

---

## Notification services

### Gmail (App Password)
1. Enable 2FA on Google account
2. Generate App Password at myaccount.google.com → Security → App passwords
3. Admin → Email: host=`smtp.gmail.com` port=`587` SSL off, username=your email, password=app password

### Discord
Server Settings → Integrations → Webhooks → New Webhook → copy URL → Admin → Notifications → Discord

### Telegram
```bash
# 1. Message @BotFather → /newbot → copy token
# 2. Add bot to your group
# 3. Get chat ID:
curl https://api.telegram.org/bot<TOKEN>/getUpdates
# Look for "chat":{"id":...}
```

### Pushover
1. Create account at pushover.net
2. Create an application → copy API token
3. Copy your user key from the dashboard
4. Admin → Notifications → Pushover — supports native map URL button

### Gotify (self-hosted)
```bash
docker run -p 8080:80 gotify/server
# Create app in Gotify UI → copy token
# Admin → Notifications → Gotify
```

### MQTT (Home Assistant / Mosquitto)
Admin → Notifications → MQTT:
- **Broker URL** — `mqtt://192.168.1.100:1883` (or `mqtt://homeassistant.local`)
- **Topic** — default `pagermonitor/messages`

Each decoded pager message is published as a JSON payload. In Home Assistant, set up an MQTT sensor or automation that subscribes to the same topic.

> **Testing without a local broker:** use the free public HiveMQ broker — set Broker URL to `mqtt://broker.hivemq.com` and subscribe in the [HiveMQ web client](http://www.hivemq.com/demos/websocket-client/).

---

## Health check / monitoring

```
GET /health
```

Returns JSON — use with Uptime Kuma, Zabbix, etc.:

```json
{
  "ok": true,
  "status": "healthy",
  "version": "2.0.0",
  "uptime": { "seconds": 3661, "human": "1h 1m" },
  "database": { "ok": true, "messages": 1247, "today": 23 },
  "sdr": { "running": true, "lastMessage": "2026-05-20T10:14:33.000Z" },
  "memory": { "heapUsedMB": 48, "rssMB": 91 },
  "timestamp": "2026-05-20T10:15:01.234Z"
}
```

**Uptime Kuma:** HTTP monitor → `http://your-pi:3000/health` → expect status 200.

---

## API reference

### Public (no auth)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check for monitoring |
| `GET` | `/api/site-settings` | Site name + public mode flag (shown on login page) |

### Auth required

> When **Public Mode** is enabled in Admin → Site Settings, unauthenticated GET requests are also allowed to the feed endpoints below.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/auth/login` | Login → token |
| `POST` | `/auth/logout` | Logout |
| `POST` | `/auth/forgot-password` | Send password reset email |
| `POST` | `/auth/reset-password` | Set new password from token |
| `GET` | `/auth/me` | Current user info |
| `PUT` | `/auth/me/email` | Update own email |
| `GET/PUT` | `/auth/me/notif-prefs` | Own notification preferences |
| `GET` | `/api/status` | Server + SDR status |
| `GET` | `/api/history?limit=200&before=<id>` | Messages (paginated) |
| `GET` | `/api/search?q=text` | Full-text search |
| `GET` | `/api/aliases` | All aliases |
| `GET` | `/api/groups` | All groups |
| `GET` | `/api/archive?limit=50&q=text` | Archive search |
| `GET` | `/api/archive/export?q=text` | Archive CSV download |
| `GET` | `/api/messages/:id/notes` | Get notes for a message |
| `POST` | `/api/messages/:id/notes` | Add note to a message |
| `DELETE` | `/api/notes/:id` | Delete a note |
| `GET` | `/api/push/vapid-public-key` | VAPID public key for push subscription |
| `POST` | `/api/push/subscribe` | Subscribe device to background push notifications |
| `DELETE` | `/api/push/subscribe` | Unsubscribe device from push notifications |

### Editor required

| Method | Endpoint | Description |
|---|---|---|
| `PUT` | `/api/aliases/:capcode` | Create or update an alias |
| `DELETE` | `/api/aliases/:capcode` | Delete an alias |

### Admin required

| Method | Endpoint | Description |
|---|---|---|
| `GET/POST` | `/admin/sdr/config` | SDR config (POST restarts) |
| `GET/PUT` | `/admin/sdr/dongles` | Multi-dongle config |
| `POST` | `/admin/sdr/start\|stop\|restart` | Pipeline control |
| `GET` | `/admin/sdr/logs` | Last 300 log lines |
| `GET` | `/admin/system` | System stats |
| `GET` | `/admin/backup/status` | DB sizes and dates |
| `GET` | `/admin/backup/download` | Download `.pmbackup` |
| `POST` | `/admin/backup/restore` | Restore from `.pmbackup` |
| `GET/PUT` | `/admin/email/config` | SMTP config |
| `POST` | `/admin/email/test` | Send test email |
| `GET` | `/admin/user-notif-prefs` | All users' notification prefs |
| `PUT` | `/admin/user-notif-prefs/:id` | Set user notification prefs |
| `GET` | `/admin/audit-log?filter=alias,group&limit=200` | Audit log |
| `GET/PUT` | `/admin/notifications/config` | Push notification config |
| `POST` | `/admin/notifications/test/:svc` | Test push notification |
| `GET/PUT/DELETE` | `/admin/webhooks` | Webhook management |
| `GET/PUT` | `/admin/site-settings` | Site name, public mode |
| `DELETE` | `/admin/db/purge?days=N` | Purge old messages |

### WebSocket events (`/ws`)

| Event | Direction | Description |
|---|---|---|
| `message` | server→browser | New decoded message |
| `sdr_status` | server→browser | Pipeline state + dongle statuses |
| `dead_air` | server→browser | Dead air alert or recovery |
| `keyword_alert` | server→browser | Keyword match on incoming message |
| `log` | server→browser | Live log line |
| `connected` | server→browser | Connection confirmed |

### Remote client (`X-Client-Key` header)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/client/status` | Verify key + get config |
| `POST` | `/client/message` | Submit decoded message |

---

## File structure

```
pagermonitor/
├── backend/src/
│   ├── index.js                   Entry point + /health
│   ├── routes/
│   │   ├── api.js                 Public + auth REST endpoints
│   │   ├── admin.js               Admin endpoints (role-based)
│   │   ├── auth.js                Login, register, password reset
│   │   ├── backup.js              Backup/restore endpoints
│   │   └── client.js              Remote RPi client ingestion
│   ├── services/
│   │   ├── database.js            SQLite + FTS5 + migrations
│   │   ├── websocket.js           WebSocket server + broadcast
│   │   ├── sdr.js                 rtl_fm + multimon-ng (single + multi-dongle)
│   │   ├── notifications.js       Discord, Telegram, Gotify, Pushover, MQTT (global filter)
│   │   ├── webpush.js             VAPID key management + Web Push API
│   │   ├── emailNotifier.js       Per-user email notifications
│   │   ├── email.js               SMTP + password reset tokens
│   │   ├── webhooks.js            HTTP webhooks with HMAC-SHA256
│   │   ├── deadair.js             Dead air detection + alerts
│   │   ├── archive.js             Auto-archive old messages
│   │   ├── config.js              Persistent settings from DB
│   │   └── auth.js                Sessions + bcrypt + roles
│   └── utils/
│       ├── aliases.js             Capcode → alias resolver
│       ├── parseLocation.js       GPS coordinate extractor
│       └── logger.js
│
├── client/src/index.js            RPi client (single + multi-dongle)
│
├── frontend/src/
│   ├── App.jsx
│   ├── components/
│   │   ├── MessageFeed.jsx        Live feed with load more
│   │   ├── MessageRow.jsx         Message row + notes panel
│   │   ├── MessageNotes.jsx       Per-message notes/annotations
│   │   ├── MapView.jsx            Leaflet map (pins/cluster/heatmap)
│   │   ├── ArchivePanel.jsx       Archive viewer + CSV export
│   │   ├── UserProfile.jsx        Self-service email + notif prefs
│   │   ├── PasswordResetPage.jsx  Password reset handler
│   │   └── admin/                 All admin panel tabs
│   ├── hooks/
│   │   ├── useWebSocket.js        WebSocket + message state
│   │   ├── useBrowserNotifications.js  Web Notifications API (tab-open)
│   │   ├── usePushSubscription.js      PWA background push subscription
│   │   └── useAdminFetch.js       Generic admin data fetcher
│   ├── utils/api.js               All API calls
│   └── public/
│       ├── sw.js                  Service worker (caching + push handler)
│       ├── manifest.json          PWA manifest
│       ├── icon-192.png           PWA icon (generated by npm run build)
│       └── icon-512.png           PWA icon (generated by npm run build)
│
├── docker-compose.yml             Unified compose (profiles: single/server)
├── docker-compose.client.yml      RPi client compose
├── docker/
│   ├── Dockerfile.single          All-in-one (SDR + server)
│   ├── Dockerfile.server          Server only (no SDR tools)
│   └── Dockerfile.client          RPi client
├── Makefile                       Simple commands (make start/logs/stop...)
├── .env.example                   All config vars documented
├── DOCKER.md                      Docker setup guide
├── install.sh                     Native RPi installer
└── systemd/pagermonitor.service   Systemd unit file
```

---

## Updating

Always check [CHANGELOG.md](CHANGELOG.md) before updating — major version bumps may require manual steps.

### Native (systemd) — one command

```bash
cd ~/pagermonitor
bash update.sh
```

This does everything automatically:
1. `git pull` — latest code
2. `apt update && apt upgrade` — system packages
3. multimon-ng version check — upgrades from source if newer available
4. `npm install` + frontend rebuild
5. Restarts the service

**Or use the admin panel** — Admin → System → Update compares your installed commit with the latest on GitHub and has an **Update Now** button with live terminal output. The page reloads automatically when the service restarts.

> **RPi client** has no web UI — update via SSH: `cd ~/pagermonitor && bash update.sh`

### Docker

```bash
cd ~/pagermonitor
git pull
make update   # equivalent to: git pull + docker compose down + docker compose up -d --build
```

Or manually:
```bash
docker compose down
docker compose up -d --build
docker compose logs -f
```

### RPi client (distributed mode, native)

```bash
cd ~/pagermonitor
bash update.sh
```

### Check running version

Admin → System → Update shows installed commit vs latest on GitHub. Or:
```bash
curl -s http://localhost:3000/health | grep version
# → "version": "2.3.0"
```

### After a major version bump (x.0.0)

1. Read the CHANGELOG entry carefully — look for **Migration** or **Breaking** notes
2. Back up your database first: Admin → Backup & Restore → Download
3. Follow any manual steps listed in the CHANGELOG
4. Then update normally

Minor and patch versions are always safe — no manual steps needed.

---

## Troubleshooting

### RTL-SDR not detected

```bash
lsusb | grep -i realtek      # should show the dongle
rtl_test -t                  # tests basic detection

# Blacklist DVB driver (required for RTL-SDR to work)
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/rtlsdr.conf
sudo modprobe -r dvb_usb_rtl28xxu
sudo udevadm control --reload-rules && sudo udevadm trigger

# Check udev permissions
sudo usermod -aG plugdev $(whoami)   # log out + in after this
```

### No messages decoded

```bash
# Test reception — record 10 seconds and play back
rtl_fm -f 173.250M -M fm -s 22050 - | \
  sox -t raw -r 22050 -e s -b 16 -c 1 - test.wav

# Silent = wrong frequency
# Noise only = try different gain values (20, 30, 40, 50)
# Tones present but no decode = wrong protocol/baud, try POCSAG512 or FLEX
```

### Slovenian/special characters (Š Č Ž) not showing

Admin → SDR Control → **POCSAG charset (-C)** = `ISO-8859-2`

### SDR OFFLINE in status bar

Check Admin → Live Logs. Common causes:
- Another process holds the dongle: `fuser /dev/bus/usb/*`
- Wrong device index: try `RTL_FM_DEVICE_INDEX=1`
- DVB driver not blacklisted

### Multiple dongles: one shows as down

Each dongle needs a unique device index (`0`, `1`, `2`…). Find indices with `rtl_test`. The status bar shows one dot per dongle — green = OK, red = down. Hover for details.

### RPi client not connecting

```bash
curl http://<server-ip>:3000/client/status \
  -H "X-Client-Key: <your-key>"
# 200 OK = working
# 401 = wrong key
# Connection refused = wrong SERVER_URL or firewall
```

### Blank page after login

Clear browser cache and reload. If it persists, check the browser console for JavaScript errors and `sudo journalctl -u pagermonitor -n 30`.

### Mixed content / WebSocket broken over HTTPS

Use nginx to proxy both HTTP and WebSocket on the same port. See the nginx config in `docker/nginx-standalone.conf`.

### SD card longevity on Pi

```bash
# Reduce writes — set in backend/.env:
LOG_LEVEL=warn          # less logging
DB_PATH=/mnt/usb/pagermonitor.db  # move DB to USB SSD
```

---

## Raspberry Pi recommendations

- **Pi 4 (2GB+)** for Option A (single device). Pi 3B+ or Pi Zero 2W fine for Option B client.
- **Powered USB hub** if RTL-SDR causes USB instability.
- **USB SSD** for the database in high-message environments (extends SD card life).
- `vcgencmd measure_temp` — add heatsink/fan if consistently above 70°C.

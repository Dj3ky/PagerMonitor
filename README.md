<div align="center">

# 📟 PagerMonitor

**Real-time POCSAG & FLEX pager monitoring — from RF to your browser in seconds**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![SQLite](https://img.shields.io/badge/SQLite-FTS5-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](DOCKER.md)
[![PWA](https://img.shields.io/badge/PWA-ready-5A0FC8?logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)

*Plug in an RTL-SDR dongle, set your frequency, and get a live dashboard of every pager message on the air.*

[**Quick Start**](#-quick-start) · [**Features**](#-features) · [**Screenshots**](#-screenshots) · [**Installation**](INSTALL.md) · [**Docker**](DOCKER.md)

</div>

---

## What is this?

PagerMonitor turns a cheap RTL-SDR USB dongle (~€25) into a full pager monitoring station. It decodes POCSAG and FLEX transmissions in real time, stores them in a searchable database, and serves a polished web dashboard that works on any device — phone, tablet, desktop.

Built for emergency services monitoring, amateur radio enthusiasts, and anyone curious about what's being paged in their area.

```
RTL-SDR dongle → rtl_fm → multimon-ng → Node.js → Browser (WebSocket)
```

---

## ✨ Features

### 🔴 Live feed
- **Real-time WebSocket feed** — messages appear instantly, no refresh
- **Per-user NEW badge** — tracks what you've already seen, synced across all your devices
- **Highlight rules** — regex or text patterns that colour-code matching messages
- **Keyword alerts** — flash the browser and trigger notifications for urgent keywords
- **Click to expand** — full details, raw data, timestamp on any message
- **Filter by capcode, alias, or group** with one click
- **Pagination + load more** — browse the full history, not just the last 200

### 🗺️ Map view
- Pins for messages with GPS coordinates extracted from message text
- Three modes: **individual pins** · **clustered** · **heatmap**
- Fly-to animation when clicking the map button on any message row
- **Re-geocode** button on every message — retries address extraction and pins the result on the map

### 🤖 AI-assisted geocoding (optional)
When enabled, the raw pager message text is sent to an AI model to extract the street, house number, and settlement **before** falling back to the built-in regex pipeline — useful for unusual or abbreviated address formats that regex misses.

| Provider | Cost | Notes |
|---|---|---|
| **Groq** | Free tier (14 400 req/day) | Llama 3.1 8B Instant — fastest option; no local hardware needed |
| **OpenAI** | Paid (GPT-4o-mini) | Most accurate; requires an API key |
| **Ollama** | Free / local | Runs on the same Raspberry Pi; no internet required. Llama 3.2 1B fits in 2 GB RAM |

Configure under **Admin → Site → AI Geocode**. API keys are stored server-side and never sent to the browser. Disabling AI falls back silently to the regex pipeline with no data loss.

### 📋 Aliases & groups
- Give capcodes friendly names: `1234567` → `Fire Station Alpha`
- Organise aliases into **groups and subgroups** with colour coding
- Per-alias and per-group row colours and notification sounds
- **CSV import/export** — manage hundreds of aliases in a spreadsheet

### 📝 Message notes & annotations
- Any user can add notes to any message
- Notes can be **shared** (all users see it) or **private** (only you)
- Note count badge on each message row
- Admins can delete any note

### 🔔 Notifications
| Service | Features |
|---|---|
| **Browser push** | OS-level notification on any subscribed device, even with the app closed |
| **Discord** | Rich embeds — alias, group, Google Maps link |
| **Telegram** | MarkdownV2 formatted, inline Maps link |
| **Gotify** | Self-hosted push, any priority |
| **Pushover** | Native Maps URL button in the app |
| **Email (SMTP)** | HTML formatted, Maps button, any SMTP provider |
| **Webhooks** | HTTP POST to any endpoint, HMAC-SHA256 signed |

**Per-user notification filters** — email and push each have independent filters per user (by group, alias, capcode, or keyword). The global filter on the Services page applies only to Discord, Telegram, Gotify, Pushover, and MQTT. Set preferences from the profile panel.

### 📲 PWA — installable app
Install PagerMonitor directly to your home screen on Android, iOS, or desktop. No app store needed.
- Standalone window — no browser bar, feels like a native app
- Background push notifications — alerted even when the phone is locked or the app is closed
- Click the **bell icon** in the header to enable — automatically subscribes the device to push

### 👥 Multi-user access
| Role | Access |
|---|---|
| `admin` | Full access — all settings, users, SDR control |
| `editor` | Aliases, groups, highlights, keyword alerts |
| `viewer` | Read-only feed, map, archive, search |

- Password reset via email (time-limited link)
- Session tokens with 7-day expiry

### 📡 Multi-SDR support
Run **multiple RTL-SDR dongles in parallel** — each on its own frequency, protocol, or gain setting. Status bar shows per-dongle health with individual indicators and hover tooltips.

### 🗄️ Archive & history
- Auto-archive old messages to a separate `archive.db`
- Full-text search across both live and archived messages
- CSV export from the archive panel
- Backup & restore as a single `.pmbackup` file

### ⚙️ Admin panel
Dead air detection · Live log viewer · System stats · Webhook management · Audit log · Site settings · Dedup · Statistics dashboard · **AI Geocode** (Groq / OpenAI / Ollama)

---

## 🚀 Quick start

### Raspberry Pi (single device, 5 minutes)

```bash
# Prerequisites
sudo apt update && sudo apt install -y rtl-sdr multimon-ng nodejs npm

# Install
git clone https://github.com/dj3ky/pagermonitor.git ~/pagermonitor
cd ~/pagermonitor && bash install.sh

# Configure frequency
nano ~/pagermonitor/backend/.env
# Set: RTL_FM_FREQ=173.250M

# Start
sudo systemctl start pagermonitor
```

Open `http://<pi-ip>:3000` · Login: **admin** / *see startup log for generated password* · Change password immediately.

### Docker (any machine)

```bash
git clone https://github.com/dj3ky/pagermonitor.git
cd pagermonitor
make setup        # creates .env from template
nano .env         # set your frequency
make start        # builds and starts
```

### Distributed (RPi client → server)

```bash
# On the server (no dongle needed)
make start-server
# Open admin panel → SDR Client Key → generate key

# On the Raspberry Pi
cp client/.env.example client/.env
nano client/.env   # set SERVER_URL, CLIENT_KEY, RTL_FM_FREQ
make start-client
```

---

## 🛠️ Hardware

| Item | Notes |
|---|---|
| RTL-SDR dongle | RTL2832U chipset, ~€25. RTL-SDR Blog V3/V4 recommended |
| Antenna | Dipole or discone for best reception |
| Raspberry Pi | Pi 4 (2GB+) for single-device. Pi 3B+ or Zero 2W for client-only |

**No RTL-SDR dongle?** You can still run PagerMonitor in server mode (`DISABLE_SDR=true`) and forward messages from a remote Pi client.

---

## 📐 Architecture

```
┌─────────────────── Single device ────────────────────────┐
│                                                           │
│   RTL-SDR dongle                                          │
│        │                                                  │
│   rtl_fm (frequency tuner)                               │
│        │  raw PCM audio                                   │
│   multimon-ng (POCSAG/FLEX decoder)                      │
│        │  decoded text                                    │
│   Node.js server ──── SQLite database                    │
│        │                                                  │
│   React frontend ◄──── WebSocket                         │
└───────────────────────────────────────────────────────────┘

┌── Distributed ────────────────────────────────────────────┐
│                                                           │
│  Raspberry Pi          Server (VM / NAS / PC)             │
│  ┌──────────────┐      ┌──────────────────────────┐      │
│  │ rtl_fm       │      │ Node.js + SQLite          │      │
│  │ multimon-ng  │─────►│ React web UI              │      │
│  │ pm-client    │ HTTP │ Admin panel               │      │
│  └──────────────┘ POST │ Notifications             │      │
│                        └──────────────────────────┘      │
│                               ▲ browsers                  │
└───────────────────────────────────────────────────────────┘
```

Multiple RPi clients can connect to the same server.

---

## 📦 Tech stack

| Layer | Technology |
|---|---|
| SDR | rtl_fm + multimon-ng |
| Backend | Node.js 20, Express, better-sqlite3, ws |
| Database | SQLite with FTS5 full-text search |
| Frontend | React 18, Vite, Leaflet (maps) |
| Auth | bcrypt, Bearer token sessions |
| Notifications | node-fetch, nodemailer, web-push (VAPID) |
| AI geocoding | Groq API · OpenAI API · Ollama (local) — all optional |
| Process | systemd (native) or Docker Compose |

No external services required by default. Everything runs locally. AI geocoding is optional — enable it for better address extraction without any impact on the core pipeline.

---

## 🔄 Updating

Check [CHANGELOG.md](CHANGELOG.md) first to see what changed.

### Native (systemd)

```bash
cd ~/pagermonitor
git pull
cd frontend && npm install && npm run build && cd ..
cd backend && npm install && cd ..
sudo systemctl restart pagermonitor
```

### Docker

```bash
cd ~/pagermonitor
git pull
make update        # pulls, rebuilds, restarts in one command
```

### Check your current version

Admin panel footer shows the running version, or:
```bash
curl -s http://localhost:3000/health | grep version
```

> **After major version bumps** (e.g. `2.x → 3.0`) always read the CHANGELOG — there may be a manual migration step. Minor and patch versions (`2.1.0 → 2.1.1` or `2.2.0`) are always safe to update without any extra steps.

---

## ⚡ API & monitoring

```bash
# Health check — use with Uptime Kuma, Zabbix, etc.
curl http://localhost:3000/health

# Response
{
  "ok": true,
  "status": "healthy",
  "uptime": { "human": "2d 4h 13m" },
  "database": { "messages": 4821, "today": 47 },
  "sdr": { "running": true }
}
```

Full REST API + WebSocket documented in [INSTALL.md](INSTALL.md#api-reference).

---

## 🗂️ Documentation

| Document | Contents |
|---|---|
| [INSTALL.md](INSTALL.md) | Full installation guide, configuration reference, API docs, troubleshooting |
| [DOCKER.md](DOCKER.md) | Docker setup, profiles, Makefile commands, environment variables |
| [CHANGELOG.md](CHANGELOG.md) | Version history — what changed in each release |
| [client/.env.example](client/.env.example) | RPi client configuration with multi-dongle examples |
| [.env.example](.env.example) | Server configuration — all variables documented |

---

## 📝 License

MIT — free to use, modify, and distribute.

---

<div align="center">

Built for the amateur radio and emergency services monitoring community.

If this project is useful to you, consider giving it a ⭐

---

*Made with ❤️ in Slovenia · RTL-SDR + Node.js + React*

**[⬆ Back to top](#-pagermonitor)**

</div>

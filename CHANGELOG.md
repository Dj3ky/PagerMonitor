# Changelog

All notable changes to PagerMonitor are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`

- **MAJOR** — breaking change (e.g. DB migration requiring manual step, config rename)
- **MINOR** — new feature, backward compatible
- **PATCH** — bug fix, small improvement

---

## [2.3.0] — 2026-05-24

### Added
- **One-click update** — Admin → System → Update tab shows installed commit vs latest on GitHub. Update Now button streams live terminal output and auto-reloads the page when the service restarts
- **`update.sh`** — single command updater: `git pull` + `apt upgrade` + multimon-ng check + npm install + frontend rebuild + service restart. Auto-detects server-only mode from `.env`
- **Auto-install latest multimon-ng from source** — `install.sh` and `client/install.sh` now query the GitHub API for the latest release and build it from source automatically, replacing the outdated apt package (1.3.1 → 1.5.1+). Falls back to apt if GitHub is unreachable
- **Sudo check** — all install scripts now check for `sudo` at startup and exit with a clear message if missing (some minimal Debian/server installs don't have it). Running as root skips sudo entirely
- **Sudoers rule** — `install.sh` configures passwordless sudo for `apt-get`, `systemctl`, and `make` so the web update button works without manual password input
- **AI-assisted geocoding (optional)** — When enabled, the raw pager message text is sent to an AI model to extract the street, house number, and settlement before falling back to the built-in regex pipeline — useful for unusual or abbreviated address formats that regex misses.

### Fixed
- **FLEX messages not appearing in feed** — multimon-ng ≥ 1.3 outputs FLEX in a pipe-delimited format (`FLEX|date|baud|frame|capcode|type|message`) that the old regex didn't match. Both old (`FLEX: capcode [func] type msg`) and new formats are now supported
- **UI fixes**

---

## [2.2.0] — 2026-05-21

### Added
- **PWA (Progressive Web App)** — installable on Android, iOS, and desktop Chrome/Edge. Add to home screen for a native app feel with standalone window and no browser bar
- **Background push notifications** — browser/OS-level notifications delivered even when the app is closed. Uses Web Push API with VAPID keys (auto-generated on first start, stored in DB)
- **Service worker** — caches the app shell for faster loads; network-first for API calls
- **PWA icons** — 192×192 and 512×512 PNG icons auto-generated from `favicon.svg` as part of `npm run build`
- **Bell button now dual-purpose** — enabling browser notifications also subscribes the device to background push. Disabling unsubscribes
- **Minor bug fixes**

### Notes
- VAPID keys are generated automatically on first backend start and stored in the database — no manual configuration needed
- Push subscriptions are stored per-user; guest/public users cannot subscribe
- Push respects the existing global notification filter (Admin → Notifications → Filter)

---

## [2.1.0] — 2026-05-20

### Added
- **Multiple SDR dongles** — run parallel rtl_fm/multimon-ng pipelines, each on its own frequency. Configure per-dongle in Admin → SDR Control or via `DONGLES` env var
- **Per-dongle status indicators** — StatusBar shows one dot per dongle; green = OK, amber = partial, red = all down. Hover for details
- **Message notes & annotations** — add shared or private notes to any message. Note count badge on each row
- **Per-user email notifications** — each user sets their own filter (all / by group / by alias / by capcode / by keyword)
- **Email (SMTP) support** — HTML-formatted notifications with Google Maps button when coordinates available
- **Password reset via email** — "Forgot password" on login sends a time-limited reset link
- **Editor role** — new role between admin and viewer: can manage aliases, groups, highlights, keyword alerts
- **Activity feed** — compact recent-changes panel embedded in Aliases and Groups pages
- **Load more** — "Load more" button in feed fetches older messages beyond the initial 200
- **Archive CSV export** — download archive as CSV from the Archive panel
- **Cluster map icon** — replaced text label with SVG icon
- **Health check endpoint** — `/health` returns uptime, DB stats, memory, SDR status
- **Docker improvements** — single `docker-compose.yml` with profiles, `Makefile` with `make start/stop/logs/update`, `.env.example` at root
- **Notification improvements** — alias, group name, and Google Maps link in all notification services (Discord, Telegram, Gotify, Pushover, Email)
- **Backup & Restore** — includes WAL file in size calculation, accurate last-modified date
- **User management** — email field on create/edit user, edit button with inline panel
- **SSL toggle auto-switches port** — checking SSL/TLS in email config auto-sets port 465/587

### Fixed
- Login page blank page (missing `form` state)
- Hooks violation in App.jsx (conditional return before hooks)
- `updateUserPassword` missing from database exports
- Duplicate `/auth/me` route shadowing email field
- Role validation rejecting `editor` on registration
- Double restart when switching multi→single dongle mode

---

## [2.0.0] — 2026-03-01

### Added
- Complete rewrite of frontend in React 18 + Vite
- WebSocket live feed replacing polling
- Map view with Leaflet (pins, cluster, heatmap)
- Full-text search with SQLite FTS5
- Admin panel with tabbed layout
- Discord, Telegram, Gotify push notifications
- Webhooks with HMAC-SHA256 signing
- Highlight rules (regex/text)
- Keyword alerts
- Alias/group management with CSV import/export
- Per-user NEW badge tracking
- Dead air detection
- Archive with separate database
- Backup & Restore
- Distributed mode (RPi client → server over HTTP)
- Docker support
- Audit log
- Statistics dashboard
- Deduplication
- Public read-only mode
- Site settings

### Changed
- Replaced MongoDB with SQLite (no external DB required)
- Replaced Express session with Bearer token auth
- Single systemd service replaces multiple processes

---

## [1.0.0] — 2024-01-01

Initial release.
- Basic POCSAG decoding via rtl_fm + multimon-ng
- Simple web feed with polling
- SQLite message storage
- Basic alias support

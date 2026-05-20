# Changelog

All notable changes to PagerMonitor are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`

- **MAJOR** — breaking change (e.g. DB migration requiring manual step, config rename)
- **MINOR** — new feature, backward compatible
- **PATCH** — bug fix, small improvement

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

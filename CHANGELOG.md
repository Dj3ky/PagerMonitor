# Changelog

All notable changes to PagerMonitor are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`

- **MAJOR** — breaking change (e.g. DB migration requiring manual step, config rename)
- **MINOR** — new feature, backward compatible
- **PATCH** — bug fix, small improvement

---

## [Unreleased]

### Security
- **Password reset links can no longer be redirected** — links were built from the request's `Origin`/`Host` header, so anyone could trigger a genuine reset email pointing at their own domain. They now use the new **Public URL** setting (Admin → Site settings); password reset stays disabled until it is set
- **Reset tokens now actually expire** after 1 hour, are single-use (using one invalidates all other outstanding links for that user), and are stored only as a SHA-256 hash in a new `password_resets` table. Outstanding legacy tokens are dropped on upgrade
- Reset token is removed from the address bar as soon as the reset page loads; `Referrer-Policy: strict-origin-when-cross-origin` is now sent explicitly
- **Org admins can no longer take over a platform admin** — an org admin could reset the password, change the email, change the role of, or delete a platform admin in the same organization (the default setup), gaining instance-wide access. Platform admin accounts can now only be managed by platform admins; the role endpoint also only accepts `admin`/`editor`/`viewer`
- **Sessions are now revocable and always current** — role, organization and platform-admin status were copied into the session at login and kept for 7 days. They are now read from the user's current record on every request, so demotions, org moves and deletions apply immediately. Changing your password logs out all your other sessions; an admin reset or emailed reset logs the user out everywhere. Open WebSocket connections are re-checked every 30 s and closed when the session is gone or the user's org/platform access changed
- **Session tokens are stored hashed** — the `sessions` table is replaced by `auth_sessions`, keyed by SHA-256 of the token. Active sessions are migrated on upgrade, so nobody is logged out

- **Brute-force protection on login** — `/auth/login` allows 10 failed attempts per 15 minutes per IP and per username; forgot-password 5 requests per 15 minutes per IP and 3 per hour per username; reset-password and invite sign-up are capped per IP too (`express-rate-limit`). New `TRUST_PROXY` setting so the limits see the real client IP behind a reverse proxy
- **Minimum password length raised from 6 to 10 characters** for every newly set password (existing passwords keep working). A `DEFAULT_ADMIN_PASS` shorter than that is ignored in favour of a random one
- Login with an unknown username now takes as long as with a wrong password, so response time no longer reveals which usernames exist
- **Request bodies capped at 1 MB** — every JSON body was parsed with a 500 MB limit before any authentication, so anyone could exhaust the server's memory with a few requests. Only backup restore still accepts large uploads, and only after the platform-admin check. The unused global raw-body parser is gone; oversized or malformed bodies get a JSON error
- **CORS restricted** — the API reflected any origin (with credentials). Cross-origin access is now limited to `CORS_ORIGINS` (default: the native app's `https://localhost` / `capacitor://localhost`); the web UI is same-origin and unaffected
- **Invite sign-up is atomic** — the account was created before the invite's use was counted, so two people racing the last use of a limited invite could both end up with an account. User creation and invite use now happen in one transaction; a failed sign-up (e.g. username taken) no longer uses up the invite
- Client key (remote SDR clients, audio-source WebSocket) is compared in constant time
- `docker/nginx-standalone.conf` logs requests without query strings, so session tokens (`/ws?token=`), reset tokens and invite codes no longer end up in the access log; HSTS is included as a commented-out option for setups with a trusted certificate
- **Public mode no longer exposes internal data** — message notes, the archive CSV export, per-user last-seen and the push device list now require a login even when public read-only mode is on; the export button is hidden for guests

### Fixed
- In public mode, logged-in users were served the anonymous guest view on every read request (public org, no per-user data); a valid login now always takes precedence
- Changing your password from the profile panel always failed (the request sent the wrong field names)

## [2.5.0] — 2026-08-12

### Added
- **Live voice channels** — listen to a voice frequency (e.g. dispatch) live in the browser alongside POCSAG decoding on the same dongle, via `rtl_airband`. Audio relays over the existing WebSocket connection, no extra server or port
- **Discord voice relay** — stream any voice channel live into a Discord voice channel via a bot (Admin → SDR → Discord Relay), independent of the existing Discord message-notification service. Multiple relay mappings supported, org-scoped
- **Live listener counts** for voice channels, with usernames shown on hover
- **Auto-listen** — arm a voice channel to start playing automatically the moment it keys up
- **Voice-only dongle mode** — dedicate a dongle purely to voice channels with no multimon-ng process spawned
- **Per-channel NFM de-emphasis (tau)** setting for voice channels
- **Client Logs** — unified, filterable admin page merging log output from all remote RPi clients (Admin → SDR → Client Logs), replacing per-client ad-hoc log tailing. Server buffers the last 300 lines per client so history persists even if nobody was watching
- **Multi-dongle serial ID selection** — pick dongles by hardware serial (stable across reboots/replugs) instead of USB enumeration order, for both local and remote-client dongles. Documented Windows `rtl_eeprom` workflow for burning serials from a PC
- **Regional data overlays (Slovenia)** — optional live map layers for Aircraft Tracking (OpenSky Network), Traffic (NAP — cameras, roadworks, VMS signs), ARSO weather stations, and ARSO earthquakes. Each independently toggleable under Admin → Site → Optional Features, dormant with no API calls until enabled
- **Alias colour inheritance** — new aliases can inherit their parent group's colour instead of a random one
- **Dongle/client source labels** on feed and archive rows, included in archive CSV export
- Live channel-activity indicator (pulsing dot) in the header for active voice channels
- Audio-relay connection status indicator per client on the SDR Clients admin page

### Fixed
- **Users tab scoped to the admin's own organization**, even for platform admins
- Remote client crash when reconciling a legacy single-dongle config
- Voice-channel edits (squelch/tau/frequency) not propagating to remote clients
- Saving the same voice channel to more than one dongle/client is now blocked
- False-positive update-available badges from unrelated monorepo commits
- Stale "playing" state when a voice channel's source goes offline
- WebSocket connection breakage from two `WebSocketServer` instances sharing one HTTP server
- Archive search clear action not resetting the view
- Zero-byte `.env` now treated the same as a missing one during install
- `apt-get` calls now retry on dpkg lock contention instead of failing outright

---

## [2.4.0] — 2026-07-30

### Added
- **Multi-tenant organizations** — each organization is an isolated workspace with its own groups, aliases, and feed filter, while everyone still shares the same underlying pager feed. Admin → Site → Organizations lets platform admins create/rename/delete organizations and move users between them
- **Platform admin role** — a super-admin flag, separate from the per-org `admin` role, that can see and manage every organization on the instance
- **Invite links to join an organization** — generate an invite code from the Users panel; new accounts created via the link land directly in that org and see its existing groups/aliases/feed filter immediately
- **SDR client colours** — assign a colour to each distributed RPi client from Admin → SDR → SDR Clients; shown on client badges in the live feed so messages are easy to trace back to their source dongle
- **Message content filters in Feed Filter** — drop messages by matching free text or a regex pattern against the message body, in addition to the existing capcode/group/alias filters

### Fixed
- **Feed filter hardened against ReDoS** — regex patterns shaped for catastrophic backtracking, or longer than 200 characters, are rejected at save time since they run on every incoming message; text/regex filter lists are capped at 100 entries each
- **Alias/group badges overflowing** onto the capcode and message text on feed rows
- **Capcode zero-padding and decoding fixes**

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

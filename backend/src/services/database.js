const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { buildDongleSourceId } = require('../utils/dongleSource');

const DB_PATH = process.env.DB_PATH || './data/pagermonitor.db';
let db;

function initDb() {
  const dir = path.dirname(path.resolve(DB_PATH));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  try {
    db = new Database(path.resolve(DB_PATH));
  } catch (e) {
    if (e.code === 'SQLITE_CORRUPT') {
      const dbFile = path.resolve(DB_PATH);
      const backups = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => f.startsWith(path.basename(dbFile) + '.pre-restore-')).sort().reverse()
        : [];
      if (backups.length > 0) {
        const latest = path.join(dir, backups[0]);
        logger.error(`Database is corrupt. A pre-restore backup was found: ${latest}`);
        logger.error(`To recover, run:\n  cp "${latest}" "${dbFile}"\n  sudo systemctl restart pagermonitor`);
      } else {
        logger.error('Database is corrupt and no pre-restore backup was found. Delete the database file to start fresh.');
      }
    }
    throw e;
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.function('regexp', { deterministic: true }, (pattern, str) => {
    try { return new RegExp(pattern, 'i').test(str ?? '') ? 1 : 0; } catch { return 0; }
  });

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT    NOT NULL,
      capcode   TEXT    NOT NULL,
      alias     TEXT,
      protocol  TEXT    NOT NULL DEFAULT 'POCSAG',
      baud      INTEGER,
      funcbits  INTEGER,
      message   TEXT,
      raw       TEXT,
      lat       REAL,
      lng       REAL,
      client_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_capcode   ON messages(capcode);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message, capcode, alias,
      content='messages', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, message, capcode, alias)
      VALUES (new.id, new.message, new.capcode, new.alias);
    END;

    -- Base columns only — clientTracker.ensureTables() migrates in the rest
    -- on first client contact. display_name/color are created here too since
    -- messages queries join and select them even before any remote client connects.
    CREATE TABLE IF NOT EXISTS sdr_clients (
      id              TEXT    PRIMARY KEY,
      first_seen      TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen       TEXT    NOT NULL DEFAULT (datetime('now')),
      message_count   INTEGER NOT NULL DEFAULT 0,
      messages_today  INTEGER NOT NULL DEFAULT 0,
      today_date      TEXT    NOT NULL DEFAULT (date('now')),
      ip              TEXT,
      freq            TEXT,
      protocols       TEXT,
      last_message    TEXT,
      last_message_ts TEXT,
      display_name    TEXT,
      color           TEXT
    );

    CREATE TABLE IF NOT EXISTS groups (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT    NOT NULL,
      color     TEXT    NOT NULL DEFAULT '#4ade80',
      parent_id INTEGER REFERENCES groups(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS aliases (
      capcode  TEXT PRIMARY KEY,
      name     TEXT NOT NULL,
      color    TEXT DEFAULT '#4ade80',
      notes    TEXT,
      group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE,
      password   TEXT NOT NULL,
      role       TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT,
      last_seen_id INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS highlight_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      pattern    TEXT    NOT NULL,
      is_regex   INTEGER NOT NULL DEFAULT 0,
      color      TEXT    NOT NULL DEFAULT '#ffb800',
      bg         TEXT    NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS keyword_alerts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      pattern    TEXT    NOT NULL,
      is_regex   INTEGER NOT NULL DEFAULT 0,
      sound      TEXT    NOT NULL DEFAULT 'alert',
      enabled    INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT    NOT NULL DEFAULT (datetime('now')),
      username  TEXT    NOT NULL,
      action    TEXT    NOT NULL,
      detail    TEXT
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT    NOT NULL,
      url     TEXT    NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      secret  TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token    TEXT    PRIMARY KEY,
      user_id  INTEGER NOT NULL,
      username TEXT    NOT NULL,
      role     TEXT    NOT NULL,
      expires  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
  `);

  _migrate();
  logger.info(`Database initialised at \${path.resolve(DB_PATH)}`);
  return db;
}

function _migrate() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  // Captured before organizations/invites are created below — tells us whether this boot
  // is the one doing the one-time org migration (fresh install or first upgrade to org support).
  const isFreshOrgSetup = !tables.includes('organizations');

  if (!tables.includes('groups')) {
    db.exec(`CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#4ade80', parent_id INTEGER REFERENCES groups(id) ON DELETE SET NULL
    )`);
    logger.info('Migration: created groups table');
  }

  // ── Organizations & invites ──────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT    NOT NULL UNIQUE,
      org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      role       TEXT    NOT NULL DEFAULT 'viewer',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      max_uses   INTEGER NOT NULL DEFAULT 0,
      use_count  INTEGER NOT NULL DEFAULT 0,
      revoked    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(org_id);
    CREATE TABLE IF NOT EXISTS invite_uses (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      invite_id INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      used_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (isFreshOrgSetup) logger.info('Migration: created organizations/invites tables');

  const aliasColumns = db.prepare("PRAGMA table_info(aliases)").all().map(c => c.name);
  if (!aliasColumns.includes('group_id')) {
    db.exec('ALTER TABLE aliases ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL');
    logger.info('Migration: added group_id to aliases');
  }
  if (!aliasColumns.includes('row_color')) {
    db.exec("ALTER TABLE aliases ADD COLUMN row_color TEXT");
    db.exec("ALTER TABLE aliases ADD COLUMN row_sound TEXT");
    logger.info('Migration: added row_color/row_sound to aliases');
  }

  // Aliases PK rebuild — capcode alone can no longer be the PK once a row can be
  // global (org_id NULL, e.g. the owner's bulk-uploaded reference library) or
  // org-specific (an org's own override for the same capcode). Existing rows
  // become global on rebuild — see backfill note below for why.
  if (!aliasColumns.includes('id')) {
    db.exec(`
      CREATE TABLE aliases_new (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id    INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
        capcode   TEXT NOT NULL,
        name      TEXT NOT NULL,
        color     TEXT DEFAULT '#4ade80',
        notes     TEXT,
        group_id  INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        row_color TEXT,
        row_sound TEXT
      );
      INSERT INTO aliases_new (org_id, capcode, name, color, notes, group_id, row_color, row_sound)
        SELECT NULL, capcode, name, color, notes, group_id, row_color, row_sound FROM aliases;
      DROP TABLE aliases;
      ALTER TABLE aliases_new RENAME TO aliases;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_aliases_org_capcode    ON aliases(org_id, capcode) WHERE org_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_aliases_global_capcode ON aliases(capcode)         WHERE org_id IS NULL;
    `);
    logger.info('Migration: rebuilt aliases table with surrogate id + org_id (existing rows became global/shared defaults)');
  }

  const groupColumns = db.prepare("PRAGMA table_info(groups)").all().map(c => c.name);
  if (!groupColumns.includes('row_color')) {
    db.exec("ALTER TABLE groups ADD COLUMN row_color TEXT");
    db.exec("ALTER TABLE groups ADD COLUMN row_sound TEXT");
    logger.info('Migration: added row_color/row_sound to groups');
  }
  if (!groupColumns.includes('org_id')) {
    db.exec('ALTER TABLE groups ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE');
    logger.info('Migration: added org_id to groups (NULL = global/shared default)');
  }
  // Installs predating parent/child group nesting never got this column — without it,
  // groupMatchesSelection's `SELECT parent_id FROM groups` throws, which passesFilter's
  // catch-all silently turns into "let everything through" (looked like "by group"
  // notification/feed filtering doing nothing).
  if (!groupColumns.includes('parent_id')) {
    db.exec('ALTER TABLE groups ADD COLUMN parent_id INTEGER REFERENCES groups(id) ON DELETE SET NULL');
    logger.info('Migration: added parent_id to groups');
  }

  const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userColumns.includes('last_seen_id')) {
    db.exec('ALTER TABLE users ADD COLUMN last_seen_id INTEGER NOT NULL DEFAULT 0');
    logger.info('Migration: added last_seen_id to users');
  }
  if (!userColumns.includes('email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    logger.info('Migration: added email to users');
  }
  if (!userColumns.includes('org_id')) {
    db.exec('ALTER TABLE users ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL');
    db.exec('ALTER TABLE users ADD COLUMN is_platform_admin INTEGER NOT NULL DEFAULT 0');
    logger.info('Migration: added org_id/is_platform_admin to users');
  }

  const hrColumns = db.prepare("PRAGMA table_info(highlight_rules)").all().map(c => c.name);
  if (!hrColumns.includes('org_id')) {
    db.exec('ALTER TABLE highlight_rules ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE');
    logger.info('Migration: added org_id to highlight_rules');
  }
  const kaColumns = db.prepare("PRAGMA table_info(keyword_alerts)").all().map(c => c.name);
  if (!kaColumns.includes('org_id')) {
    db.exec('ALTER TABLE keyword_alerts ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE');
    logger.info('Migration: added org_id to keyword_alerts');
  }
  const whColumns = db.prepare("PRAGMA table_info(webhooks)").all().map(c => c.name);
  if (!whColumns.includes('org_id')) {
    db.exec('ALTER TABLE webhooks ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE');
    logger.info('Migration: added org_id to webhooks');
  }
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
  if (!sessionColumns.includes('org_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN org_id INTEGER');
    db.exec('ALTER TABLE sessions ADD COLUMN is_platform_admin INTEGER NOT NULL DEFAULT 0');
    logger.info('Migration: added org_id/is_platform_admin to sessions');
  }
  const auditColumns = db.prepare("PRAGMA table_info(audit_log)").all().map(c => c.name);
  if (!auditColumns.includes('org_id')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN org_id INTEGER');
    logger.info('Migration: added org_id to audit_log (NULL = platform-level action)');
  }

  // One-time backfill so an existing single-tenant install keeps working unmodified:
  // every pre-existing user/rule/alert/webhook moves into one synthesized "Default
  // Organization", pre-existing admins additionally become platform admins (nobody
  // should be silently demoted from what "admin" meant before orgs existed), and
  // existing groups/aliases are left global (NULL org_id) so every future org
  // automatically inherits them as shared defaults instead of the owner needing to
  // re-import their alias library into a separate "global" bucket later.
  if (isFreshOrgSetup) {
    const existingUserCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
    if (existingUserCount > 0) {
      const defaultOrgId = db.prepare("INSERT INTO organizations (name) VALUES ('Default Organization')").run().lastInsertRowid;
      db.prepare('UPDATE users SET org_id = ? WHERE org_id IS NULL').run(defaultOrgId);
      db.prepare("UPDATE users SET is_platform_admin = 1 WHERE role = 'admin'").run();
      db.prepare('UPDATE highlight_rules SET org_id = ? WHERE org_id IS NULL').run(defaultOrgId);
      db.prepare('UPDATE keyword_alerts SET org_id = ? WHERE org_id IS NULL').run(defaultOrgId);
      db.prepare('UPDATE webhooks SET org_id = ? WHERE org_id IS NULL').run(defaultOrgId);
      for (const base of ['feed_filter', 'notif_filter', 'notif_config']) {
        const row = db.prepare('SELECT value FROM settings WHERE key=?').get(base);
        if (row) db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(`org:${defaultOrgId}:${base}`, row.value);
      }
      logger.warn(`Migration: created "Default Organization" (id=${defaultOrgId}) and moved ${existingUserCount} existing user(s) into it. Existing groups/aliases remain global/shared defaults. Pre-existing admin(s) were also granted platform-admin access.`);
    }
  }

  // Voice channels — listenable audio channels (e.g. firefighter dispatch), org-scoped like
  // aliases/groups (NULL org_id = global/shared default). Deliberately separate from SDR/dongle
  // config: this table only ever holds channels a user can choose to listen to, never the
  // POCSAG decode frequency itself.
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_channels (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id      INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      description TEXT    NOT NULL,
      freq        TEXT    NOT NULL,
      mode        TEXT    NOT NULL DEFAULT 'nfm',
      squelch     TEXT    NOT NULL DEFAULT '',
      tau         TEXT    NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0
    )
  `);
  const voiceChannelColumns = db.prepare("PRAGMA table_info(voice_channels)").all().map(c => c.name);
  if (!voiceChannelColumns.includes('tau')) {
    // NFM de-emphasis (microseconds) — blank means "use rtl_airband's own built-in default
    // (200us)" rather than us imposing a different one; only emitted into the generated
    // config when a channel has an explicit value set (see buildAirbandConfig).
    db.exec("ALTER TABLE voice_channels ADD COLUMN tau TEXT NOT NULL DEFAULT ''");
    logger.info('Migration: added tau to voice_channels');
  }

  // Voice channels are tied to physical dongles shared by the whole server, so the catalog
  // itself is instance-wide (platform-admin managed) rather than per-org content — org_id on
  // voice_channels above is legacy/unused now. Each org can still opt out of specific shared
  // channels for its own users: a row's mere existence here means "hidden for this org",
  // absence means visible — opt-out rather than opt-in so every existing channel stays visible
  // to every org the moment this ships, instead of every dropdown going empty until reconfigured.
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_channel_hidden (
      channel_id INTEGER NOT NULL REFERENCES voice_channels(id) ON DELETE CASCADE,
      org_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      PRIMARY KEY (channel_id, org_id)
    )
  `);

  // Discord voice relays — streams one voice_channels entry live into a Discord voice
  // channel via a bot connection. Org-scoped like voice_channels itself. Multiple rows can
  // share the same bot_token (one bot, multiple guilds) or use distinct tokens (needed if
  // relaying more than one channel into voice channels within the *same* Discord guild,
  // since a single bot user can only occupy one voice channel per guild at a time).
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_relays (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id              INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      description         TEXT    NOT NULL DEFAULT '',
      voice_channel_id    INTEGER NOT NULL REFERENCES voice_channels(id) ON DELETE CASCADE,
      bot_token           TEXT    NOT NULL,
      guild_id            TEXT    NOT NULL,
      discord_channel_id  TEXT    NOT NULL,
      enabled             INTEGER NOT NULL DEFAULT 1
    )
  `);

  // A relay can now pull from more than one voice_channels entry — whichever one is
  // actively transmitting gets relayed (same "stick with the active one, hand off when it
  // drops" behavior as the browser player's auto-listen; see discordRelay.js). The legacy
  // voice_channel_id column on discord_relays stays populated (mirrors the first channel
  // in the set) purely for its NOT NULL FK and any old code paths still reading it — this
  // table is the source of truth for which channels actually feed a relay.
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_relay_channels (
      relay_id          INTEGER NOT NULL REFERENCES discord_relays(id) ON DELETE CASCADE,
      voice_channel_id  INTEGER NOT NULL REFERENCES voice_channels(id) ON DELETE CASCADE,
      PRIMARY KEY (relay_id, voice_channel_id)
    )
  `);
  const backfilled = db.prepare(`
    INSERT OR IGNORE INTO discord_relay_channels (relay_id, voice_channel_id)
    SELECT id, voice_channel_id FROM discord_relays
  `).run();
  if (backfilled.changes > 0) logger.info(`Migration: backfilled ${backfilled.changes} discord_relay_channels row(s) from discord_relays.voice_channel_id`);

  // Tracked aircraft — user/admin-managed registrations for the Airplanes page, org-scoped
  // like aliases/groups (NULL org_id = global/shared default, visible to every org). Replaces
  // the old hardcoded Fire Boss list in openskyAircraft.js; icao24 is resolved lazily (via
  // aircraftLookup.js) since a user only ever supplies a registration, not the hex code
  // OpenSky actually matches on.
  const hadTrackedAircraft = tables.includes('tracked_aircraft');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_aircraft (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id            INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      registration      TEXT    NOT NULL,
      icao24            TEXT,
      aircraft_type     TEXT,
      manufacturer      TEXT,
      enabled           INTEGER NOT NULL DEFAULT 1,
      added_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      added_by_username TEXT,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tracked_aircraft_org ON tracked_aircraft(org_id);
  `);
  if (!hadTrackedAircraft) {
    logger.info('Migration: created tracked_aircraft table');
    const seedStmt = db.prepare('INSERT INTO tracked_aircraft (org_id, registration, enabled) VALUES (NULL, ?, 1)');
    for (const reg of ['S5-BZR', 'S5-BZS', 'S5-BZT', 'S5-BZU']) seedStmt.run(reg);
    logger.info('Migration: seeded 4 default Fire Boss registrations into tracked_aircraft (global)');
  }

  // Message notes
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL,
      username   TEXT    NOT NULL,
      note       TEXT    NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notes_message ON message_notes(message_id);

    CREATE TABLE IF NOT EXISTS user_notif_prefs (
      user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled          INTEGER NOT NULL DEFAULT 0,
      mode             TEXT    NOT NULL DEFAULT 'all',
      group_ids        TEXT    NOT NULL DEFAULT '[]',
      capcodes         TEXT    NOT NULL DEFAULT '[]',
      keywords         TEXT    NOT NULL DEFAULT '[]',
      alias_color_from_group INTEGER NOT NULL DEFAULT 0,
      push_enabled     INTEGER NOT NULL DEFAULT 0,
      push_mode        TEXT    NOT NULL DEFAULT 'all',
      push_group_ids   TEXT    NOT NULL DEFAULT '[]',
      push_capcodes    TEXT    NOT NULL DEFAULT '[]',
      push_keywords    TEXT    NOT NULL DEFAULT '[]',
      alert_enabled    INTEGER NOT NULL DEFAULT 0,
      alert_mode       TEXT    NOT NULL DEFAULT 'all',
      alert_group_ids  TEXT    NOT NULL DEFAULT '[]',
      alert_capcodes   TEXT    NOT NULL DEFAULT '[]',
      alert_keywords   TEXT    NOT NULL DEFAULT '[]'
    )
  `);

  const prefCols = db.prepare('PRAGMA table_info(user_notif_prefs)').all().map(c => c.name);
  if (!prefCols.includes('alias_color_from_group')) {
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN alias_color_from_group INTEGER NOT NULL DEFAULT 0');
    logger.info('Migration: added alias_color_from_group to user_notif_prefs');
  }
  if (!prefCols.includes('push_enabled')) {
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN push_enabled   INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN push_mode      TEXT    NOT NULL DEFAULT \'all\'');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN push_group_ids TEXT    NOT NULL DEFAULT \'[]\'');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN push_capcodes  TEXT    NOT NULL DEFAULT \'[]\'');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN push_keywords  TEXT    NOT NULL DEFAULT \'[]\'');
    logger.info('Migration: added push columns to user_notif_prefs');
  }
  if (!prefCols.includes('alert_enabled')) {
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN alert_enabled   INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN alert_mode      TEXT    NOT NULL DEFAULT \'all\'');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN alert_group_ids TEXT    NOT NULL DEFAULT \'[]\'');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN alert_capcodes  TEXT    NOT NULL DEFAULT \'[]\'');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN alert_keywords  TEXT    NOT NULL DEFAULT \'[]\'');
    logger.info('Migration: added alert columns to user_notif_prefs');
  }

  const msgColumns = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
  if (!msgColumns.includes('lat')) {
    db.exec('ALTER TABLE messages ADD COLUMN lat REAL');
    db.exec('ALTER TABLE messages ADD COLUMN lng REAL');
    logger.info('Migration: added lat/lng to messages');
  }
  if (!msgColumns.includes('client_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN client_id TEXT');
    logger.info('Migration: added client_id to messages');
  }

  // sdr_clients gets its full column set (display_name, etc.) here too — otherwise it's only
  // migrated in on first remote-client contact, and queries joining on it (getHistory,
  // searchMessages) would throw "no such column: display_name" on servers with no remote clients.
  require('./clientTracker').ensureTables();

  if (!tables.includes('keyword_alerts')) {
    db.exec(`CREATE TABLE IF NOT EXISTS keyword_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pattern TEXT NOT NULL,
      is_regex INTEGER NOT NULL DEFAULT 0, sound TEXT NOT NULL DEFAULT 'alert',
      enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
    )`);
    logger.info('Migration: created keyword_alerts table');
  }

  if (!tables.includes('audit_log')) {
    db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      username TEXT NOT NULL, action TEXT NOT NULL, detail TEXT
    )`);
    logger.info('Migration: created audit_log table');
  }

  if (!tables.includes('webhooks')) {
    db.exec(`CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, secret TEXT
    )`);
    logger.info('Migration: created webhooks table');
  }

  // User live locations (opt-in, only current position stored)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_locations (
      user_id    INTEGER PRIMARY KEY,
      username   TEXT    NOT NULL,
      lat        REAL    NOT NULL,
      lng        REAL    NOT NULL,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Push subscriptions (PWA background notifications)
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      endpoint   TEXT    UNIQUE NOT NULL,
      p256dh     TEXT    NOT NULL,
      auth       TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
  `);

  // FCM tokens (native Android app background notifications — see services/fcmPush.js.
  // Separate from push_subscriptions because FCM tokens have no p256dh/auth keypair;
  // delivery still shares the same user_notif_prefs.push_* filtering as web push.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      token      TEXT    UNIQUE NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fcm_user ON fcm_tokens(user_id);
  `);

  // Strip leading zeros from numeric alias capcodes so they match decoder output.
  // POCSAG addresses are never zero-padded; FLEX capcodes can be, but are normalized
  // at ingestion time in sdr.js so stored message capcodes are unpadded too.
  const stripped = db.prepare(`
    UPDATE aliases
    SET capcode = CAST(CAST(capcode AS INTEGER) AS TEXT)
    WHERE capcode LIKE '0%'
      AND capcode != '0'
      AND capcode NOT GLOB '*[^0-9]*'
  `).run();
  if (stripped.changes > 0) logger.info(`Migration: stripped leading zeros from ${stripped.changes} alias capcode(s)`);
}

function getDb() {
  if (!db) throw new Error('Database not initialised');
  return db;
}

function getLocalDongleLabelMap() {
  const dongles = getSetting('dongle_configs', null);
  const map = new Map();
  if (!Array.isArray(dongles)) return map;
  for (const dongle of dongles) {
    const label = String(dongle?.label || '').trim();
    if (!label) continue;
    const sourceId = buildDongleSourceId(dongle);
    const legacySourceId = `dongle-${String(dongle?.device ?? '').trim()}`;
    if (sourceId !== 'dongle-') map.set(sourceId, label);
    if (legacySourceId !== 'dongle-') map.set(legacySourceId, label);
  }
  return map;
}

function getLocalDongleLabel(sourceId) {
  return getLocalDongleLabelMap().get(sourceId) || null;
}

function enrichSourceLabels(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  for (const row of list) {
    if (!row || row.client_name) continue;
    const label = getLocalDongleLabel(row.client_id);
    if (label) row.client_name = label;
  }
  return rows;
}

// ── Messages ──────────────────────────────────────────────────────────────────
function insertMessage(msg) {
  const info = getDb().prepare(`
    INSERT INTO messages (timestamp, capcode, alias, protocol, baud, funcbits, message, raw, lat, lng, client_id)
    VALUES (@timestamp, @capcode, @alias, @protocol, @baud, @funcbits, @message, @raw, @lat, @lng, @client_id)
  `).run({ ...msg, lat: msg.lat ?? null, lng: msg.lng ?? null, client_id: msg.client_id ?? null });
  return info.lastInsertRowid;
}

// Shared alias/group resolution — a capcode can now match an org-specific alias row
// AND a global (org_id IS NULL) one; the org-specific row always wins, falling back
// to the global default. The group/parent-group join is also visibility-checked: an
// alias's group_id is just an FK with no org constraint of its own, so without this a
// group belonging to a *different* org (or one that's since been reassigned away) would
// still show its name/color here even though that org can't otherwise see it at all.
// Embed with ${ALIAS_GROUP_JOIN_SQL} directly after the last `messages m` join in a
// query's FROM clause (it references `m.capcode`), and put ${ALIAS_GROUP_SELECT_SQL} in
// the SELECT list. Adds exactly three `?` placeholders — all the same viewing org's id,
// repeated — at the position where the join fragment appears in the SQL text.
const ALIAS_GROUP_JOIN_SQL = `
  LEFT JOIN aliases a  ON a.capcode = m.capcode AND a.org_id = ?
  LEFT JOIN aliases ag ON ag.capcode = m.capcode AND ag.org_id IS NULL
  LEFT JOIN groups  g  ON g.id = COALESCE(a.group_id, ag.group_id) AND (g.org_id = ? OR g.org_id IS NULL)
  LEFT JOIN groups  pg ON pg.id = g.parent_id AND (pg.org_id = ? OR pg.org_id IS NULL)
`;
const ALIAS_GROUP_SELECT_SQL = `
  COALESCE(a.name, ag.name)             as alias_name,
  COALESCE(a.color, ag.color)           as alias_color,
  COALESCE(a.row_color, ag.row_color)   as alias_row_color,
  COALESCE(a.row_sound, ag.row_sound)   as alias_row_sound,
  g.id as group_id, g.name as group_name, g.color as group_color, g.row_color as group_row_color, g.row_sound as group_row_sound,
  pg.name as parent_group_name, pg.color as parent_group_color, pg.row_color as parent_group_row_color, pg.row_sound as parent_group_row_sound
`;

function getHistory(orgId, limit = 200) {
  const rows = getDb().prepare(`
    SELECT m.*, ${ALIAS_GROUP_SELECT_SQL},
           c.display_name as client_name, c.color as client_color,
           (SELECT COUNT(*) FROM message_notes n WHERE n.message_id = m.id AND n.is_private = 0) as note_count
    FROM messages m
    ${ALIAS_GROUP_JOIN_SQL}
    LEFT JOIN sdr_clients c ON c.id = m.client_id
    ORDER BY m.id DESC LIMIT ?
  `).all(orgId, orgId, orgId, limit);
  return enrichSourceLabels(rows);
}

function searchMessages(orgId, query, limit = 100) {
  const safe  = query.replace(/['"*]/g, '').trim();
  const terms = safe.split(/\s+/).filter(Boolean);
  const ftsQuery = terms.map(t => `${t}*`).join(' ');
  const rows = getDb().prepare(`
    SELECT m.*, ${ALIAS_GROUP_SELECT_SQL},
           c.display_name as client_name, c.color as client_color,
           (SELECT COUNT(*) FROM message_notes n WHERE n.message_id = m.id AND n.is_private = 0) as note_count
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    ${ALIAS_GROUP_JOIN_SQL}
    LEFT JOIN sdr_clients c ON c.id = m.client_id
    WHERE messages_fts MATCH ?
    ORDER BY m.id DESC LIMIT ?
  `).all(orgId, orgId, orgId, ftsQuery, limit);
  return enrichSourceLabels(rows);
}

function getMessageStats(orgId) {
  const d = getDb();
  const hourly = d.prepare(`
    SELECT strftime('%Y-%m-%dT%H:00:00Z', timestamp) as hour, COUNT(*) as n
    FROM messages WHERE timestamp >= datetime('now', '-24 hours')
    GROUP BY hour ORDER BY hour ASC
  `).all();
  const daily = d.prepare(`
    SELECT date(timestamp, 'localtime') as day, COUNT(*) as n
    FROM messages WHERE timestamp >= datetime('now', '-30 days')
    GROUP BY day ORDER BY day ASC
  `).all();
  const topCodes = d.prepare(`
    SELECT m.capcode, COUNT(*) as n, COALESCE(a.name, ag.name) as name
    FROM messages m
    LEFT JOIN aliases a  ON a.capcode = m.capcode AND a.org_id = ?
    LEFT JOIN aliases ag ON ag.capcode = m.capcode AND ag.org_id IS NULL
    GROUP BY m.capcode ORDER BY n DESC LIMIT 10
  `).all(orgId);
  const byProtocol = d.prepare(`
    SELECT protocol, COUNT(*) as n FROM messages
    GROUP BY protocol ORDER BY n DESC
  `).all();
  return { hourly, daily, topCodes, byProtocol };
}

// ── Groups ────────────────────────────────────────────────────────────────────
// orgId's own groups plus every global (org_id IS NULL) default group.
function getGroups(orgId) {
  const groups  = getDb().prepare('SELECT * FROM groups WHERE org_id = ? OR org_id IS NULL ORDER BY parent_id NULLS FIRST, name').all(orgId);
  // Suppress the global row for a capcode when this org already has its own override for
  // it — otherwise a capcode with both a global default and an org-specific alias would
  // show up twice (once under each row) instead of the org's override winning.
  const aliases = getDb().prepare(`
    SELECT a.capcode, a.name, a.color, a.group_id
    FROM aliases a
    WHERE a.group_id IS NOT NULL
      AND (a.org_id = ? OR a.org_id IS NULL)
      AND NOT (a.org_id IS NULL AND EXISTS (SELECT 1 FROM aliases ov WHERE ov.capcode = a.capcode AND ov.org_id = ?))
  `).all(orgId, orgId);
  const aliasMap = {};
  for (const a of aliases) {
    if (!aliasMap[a.group_id]) aliasMap[a.group_id] = [];
    aliasMap[a.group_id].push(a);
  }
  return groups.map(g => ({ ...g, aliases: aliasMap[g.id] || [] }));
}
// orgId null (platform admin only) creates a global/shared-default group.
function createGroup(orgId, name, color, parent_id, row_color, row_sound) {
  return getDb().prepare('INSERT INTO groups (org_id, name, color, parent_id, row_color, row_sound) VALUES (?, ?, ?, ?, ?, ?)')
    .run(orgId ?? null, name, color || '#4ade80', parent_id || null, row_color || null, row_sound || null).lastInsertRowid;
}
// isPlatformAdmin bypasses the org-ownership check (can edit global rows or any org's rows);
// otherwise the update only applies if the row actually belongs to orgId. Returns affected-row
// count so the route layer can 403/404 when a non-owner tries to touch a row that isn't theirs.
// newScopeOrgId (platform admin only) reassigns org_id — pass undefined to leave scope untouched
// (the common case; only the route layer opts into this when the caller explicitly changed it).
function updateGroup(id, orgId, isPlatformAdmin, name, color, parent_id, row_color, row_sound, newScopeOrgId) {
  const changeScope = isPlatformAdmin && newScopeOrgId !== undefined;
  const sql = changeScope
    ? 'UPDATE groups SET name=?, color=?, parent_id=?, row_color=?, row_sound=?, org_id=? WHERE id=?'
    : isPlatformAdmin
      ? 'UPDATE groups SET name=?, color=?, parent_id=?, row_color=?, row_sound=? WHERE id=?'
      : 'UPDATE groups SET name=?, color=?, parent_id=?, row_color=?, row_sound=? WHERE id=? AND org_id=?';
  const params = changeScope
    ? [name, color || '#4ade80', parent_id || null, row_color || null, row_sound || null, newScopeOrgId, id]
    : isPlatformAdmin
      ? [name, color || '#4ade80', parent_id || null, row_color || null, row_sound || null, id]
      : [name, color || '#4ade80', parent_id || null, row_color || null, row_sound || null, id, orgId];
  return getDb().prepare(sql).run(...params).changes;
}
function deleteGroup(id, orgId, isPlatformAdmin) {
  getDb().prepare('UPDATE aliases SET group_id=NULL WHERE group_id=?').run(id);
  getDb().prepare('UPDATE groups SET parent_id=NULL WHERE parent_id=?').run(id);
  const sql    = isPlatformAdmin ? 'DELETE FROM groups WHERE id=?' : 'DELETE FROM groups WHERE id=? AND org_id=?';
  const params = isPlatformAdmin ? [id] : [id, orgId];
  return getDb().prepare(sql).run(...params).changes;
}
// Deletes only orgId's own groups (or, when orgId is null, only global groups) — never
// another org's. Orphans (rather than cascades) aliases/subgroups that pointed at them.
function deleteAllGroups(orgId) {
  const db = getDb();
  const scopeSql    = orgId == null ? 'org_id IS NULL' : 'org_id = ?';
  const scopeParams = orgId == null ? [] : [orgId];
  const ids = db.prepare(`SELECT id FROM groups WHERE ${scopeSql}`).all(...scopeParams).map(r => r.id);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE aliases SET group_id=NULL WHERE group_id IN (${placeholders})`).run(...ids);
    db.prepare(`UPDATE groups SET parent_id=NULL WHERE parent_id IN (${placeholders})`).run(...ids);
  }
  return db.prepare(`DELETE FROM groups WHERE ${scopeSql}`).run(...scopeParams).changes;
}
// CSV import: matches existing groups by name within the caller's own scope (never a global
// group when importing into an org, even if the names collide) to update in place, otherwise
// inserts. Two passes because parent_name may reference a group defined later in the same file.
function bulkUpsertGroups(orgId, rows) {
  const db = getDb();
  const scopeSql    = orgId == null ? 'org_id IS NULL' : 'org_id = ?';
  const scopeParams = orgId == null ? [] : [orgId];
  const nameToId = {};
  for (const g of db.prepare(`SELECT id, name FROM groups WHERE ${scopeSql}`).all(...scopeParams)) nameToId[g.name] = g.id;

  const insert       = db.prepare('INSERT INTO groups (org_id, name, color, row_color, row_sound) VALUES (?, ?, ?, ?, ?)');
  const insertWithId = db.prepare('INSERT INTO groups (id, org_id, name, color, row_color, row_sound) VALUES (?, ?, ?, ?, ?, ?)');
  const update       = db.prepare('UPDATE groups SET color=?, row_color=?, row_sound=? WHERE id=?');
  const setParent    = db.prepare('UPDATE groups SET parent_id=? WHERE id=?');
  const idTaken       = db.prepare('SELECT 1 FROM groups WHERE id=?');

  db.transaction(rows => {
    for (const r of rows) {
      const existingId = nameToId[r.name];
      if (existingId) {
        update.run(r.color || '#4ade80', r.row_color || null, r.row_sound || null, existingId);
        continue;
      }
      // Honor an explicit id from the CSV's own id column when it's free, so a groups
      // export/import round-trip keeps the same ids a paired aliases CSV's group_id
      // column was matched against — otherwise ids are auto-assigned as before.
      if (r.id && !idTaken.get(r.id)) {
        insertWithId.run(r.id, orgId ?? null, r.name, r.color || '#4ade80', r.row_color || null, r.row_sound || null);
        nameToId[r.name] = r.id;
      } else {
        nameToId[r.name] = insert.run(orgId ?? null, r.name, r.color || '#4ade80', r.row_color || null, r.row_sound || null).lastInsertRowid;
      }
    }
    for (const r of rows) {
      if (!r.parent_name) continue;
      const parentId = nameToId[r.parent_name];
      const childId  = nameToId[r.name];
      if (parentId && childId && parentId !== childId) setParent.run(parentId, childId);
    }
  })(rows);
}
// Shared by every notification/feed-filter match site: true if the message's group is
// directly selected, OR its parent group is selected (so picking a parent/region covers
// every group nested under it — including ones added after the filter was saved).
// Only one level of nesting is ever created via the admin UI, so a single parent_id lookup
// is enough; this reads the DB per call rather than caching, matching how those filters
// already re-read their settings per message.
function groupMatchesSelection(groupId, selectedIds) {
  if (groupId == null || !selectedIds?.length) return false;
  const gid = Number(groupId);
  if (selectedIds.includes(gid)) return true;
  const row = getDb().prepare('SELECT parent_id FROM groups WHERE id=?').get(gid);
  return !!(row?.parent_id != null && selectedIds.includes(Number(row.parent_id)));
}

// ── Aliases ───────────────────────────────────────────────────────────────────
// orgId's own aliases plus every global (org_id IS NULL) default alias — but not both
// for the same capcode: an org-specific row always suppresses the global one it overrides,
// same precedence as the live-feed resolution in ALIAS_GROUP_JOIN_SQL.
function getAliases(orgId) {
  return getDb().prepare(`
    SELECT a.*, g.name as group_name, g.color as group_color
    FROM aliases a
    LEFT JOIN groups g ON g.id = a.group_id AND (g.org_id = ? OR g.org_id IS NULL)
    WHERE (a.org_id = ? OR a.org_id IS NULL)
      AND NOT (a.org_id IS NULL AND EXISTS (SELECT 1 FROM aliases ov WHERE ov.capcode = a.capcode AND ov.org_id = ?))
    ORDER BY a.capcode
  `).all(orgId, orgId, orgId);
}
// Capcodes are plain integers from the decoder (no leading zeros). Strip leading zeros
// from user-supplied values so aliases always match decoded messages.
const normCapcode = c => /^\d+$/.test(c) ? String(parseInt(c, 10)) : c;

// Best-effort alias name lookup for a capcode, ignoring org scoping — used only as
// a soft geocoding hint (department home-place anchor, see utils/aliasPlace.js),
// never for display/identity. Prefers the global/shared-default alias, falling
// back to any org-specific one when no global row exists.
function getAliasNameForCapcode(capcode) {
  const row = getDb().prepare(
    'SELECT name FROM aliases WHERE capcode = ? ORDER BY (org_id IS NULL) DESC LIMIT 1'
  ).get(normCapcode(capcode));
  return row?.name || null;
}

// orgId null (platform admin only — enforced by isPlatformAdmin check) writes a global/shared
// default alias; otherwise writes/overrides within that org. Two separate upsert statements
// because each targets a different partial unique index (SQLite's ON CONFLICT arbiter must
// match one specific index).
function upsertAlias(orgId, isPlatformAdmin, capcode, name, color, notes, group_id, row_color, row_sound) {
  const cap = normCapcode(capcode);
  if (orgId == null) {
    if (!isPlatformAdmin) throw new Error('Only the platform admin can edit global/shared-default aliases');
    getDb().prepare(`
      INSERT INTO aliases (org_id, capcode, name, color, notes, group_id, row_color, row_sound) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(capcode) WHERE org_id IS NULL DO UPDATE SET name=excluded.name, color=excluded.color, notes=excluded.notes,
        group_id=excluded.group_id, row_color=excluded.row_color, row_sound=excluded.row_sound
    `).run(cap, name, color || '#4ade80', notes || null, group_id || null, row_color || null, row_sound || null);
  } else {
    getDb().prepare(`
      INSERT INTO aliases (org_id, capcode, name, color, notes, group_id, row_color, row_sound) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, capcode) WHERE org_id IS NOT NULL DO UPDATE SET name=excluded.name, color=excluded.color, notes=excluded.notes,
        group_id=excluded.group_id, row_color=excluded.row_color, row_sound=excluded.row_sound
    `).run(orgId, cap, name, color || '#4ade80', notes || null, group_id || null, row_color || null, row_sound || null);
  }
}
function deleteAlias(orgId, isPlatformAdmin, capcode) {
  const cap = normCapcode(capcode);
  if (orgId == null) {
    if (!isPlatformAdmin) throw new Error('Only the platform admin can delete global/shared-default aliases');
    return getDb().prepare('DELETE FROM aliases WHERE capcode=? AND org_id IS NULL').run(cap).changes;
  }
  return getDb().prepare('DELETE FROM aliases WHERE capcode=? AND org_id=?').run(cap, orgId).changes;
}
function bulkUpsertAliases(orgId, rows) {
  const stmt = orgId == null
    ? getDb().prepare(`INSERT INTO aliases (org_id, capcode, name, color, notes, group_id, row_color, row_sound) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(capcode) WHERE org_id IS NULL DO UPDATE SET name=excluded.name, color=excluded.color, notes=excluded.notes, group_id=excluded.group_id, row_color=excluded.row_color, row_sound=excluded.row_sound`)
    : getDb().prepare(`INSERT INTO aliases (org_id, capcode, name, color, notes, group_id, row_color, row_sound) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(org_id, capcode) WHERE org_id IS NOT NULL DO UPDATE SET name=excluded.name, color=excluded.color, notes=excluded.notes, group_id=excluded.group_id, row_color=excluded.row_color, row_sound=excluded.row_sound`);
  getDb().transaction(rows => {
    for (const r of rows) {
      const cap = normCapcode(r.capcode);
      if (orgId == null) stmt.run(cap, r.name, r.color || '#4ade80', r.notes || null, r.group_id || null, r.row_color || null, r.row_sound || null);
      else stmt.run(orgId, cap, r.name, r.color || '#4ade80', r.notes || null, r.group_id || null, r.row_color || null, r.row_sound || null);
    }
  })(rows);
}

// ── Settings ──────────────────────────────────────────────────────────────────
function getSetting(key, defaultVal = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return defaultVal;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setSetting(key, value) {
  getDb().prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));
}

// ── Organizations ─────────────────────────────────────────────────────────────
function createOrganization(name, createdBy) {
  return getDb().prepare('INSERT INTO organizations (name, created_by) VALUES (?, ?)').run(name, createdBy || null).lastInsertRowid;
}
function getOrganizations() {
  return getDb().prepare(`
    SELECT o.*, (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) as user_count
    FROM organizations o ORDER BY o.id
  `).all();
}
function getOrganization(id) { return getDb().prepare('SELECT * FROM organizations WHERE id=?').get(id); }
function renameOrganization(id, name) { return getDb().prepare('UPDATE organizations SET name=? WHERE id=?').run(name, id).changes; }
// Only deletes if the org has no users left — callers should check first and surface a
// clear error, but this is the last line of defense against orphaning someone's account
// (users.org_id is ON DELETE SET NULL, so a forced delete wouldn't destroy the user, but
// it would silently kick them out of their workspace, which is worse than just refusing).
function deleteOrganization(id) {
  const userCount = getDb().prepare('SELECT COUNT(*) as n FROM users WHERE org_id=?').get(id).n;
  if (userCount > 0) throw new Error(`Cannot delete: ${userCount} user(s) still belong to this organization`);
  return getDb().prepare('DELETE FROM organizations WHERE id=?').run(id).changes;
}

// ── Invites ───────────────────────────────────────────────────────────────────
function createInvite({ orgId, role, createdBy, expiresAt, maxUses }) {
  const code = crypto.randomBytes(9).toString('base64url');
  getDb().prepare(`
    INSERT INTO invites (code, org_id, role, created_by, expires_at, max_uses)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(code, orgId, role || 'viewer', createdBy || null, expiresAt || null, maxUses || 0);
  return code;
}
function getInviteByCode(code) { return getDb().prepare('SELECT * FROM invites WHERE code=?').get(code); }
function listInvites(orgId) { return getDb().prepare('SELECT * FROM invites WHERE org_id=? ORDER BY id DESC').all(orgId); }
function revokeInvite(id, orgId) { return getDb().prepare('UPDATE invites SET revoked=1 WHERE id=? AND org_id=?').run(id, orgId).changes; }

// Atomic check-and-consume so two people racing the last use of a max_uses-limited
// invite can't both succeed.
function consumeInvite(code, userId) {
  const d = getDb();
  return d.transaction(() => {
    const invite = d.prepare('SELECT * FROM invites WHERE code=?').get(code);
    if (!invite) throw new Error('Invalid invite code');
    if (invite.revoked) throw new Error('This invite has been revoked');
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) throw new Error('This invite has expired');
    if (invite.max_uses > 0 && invite.use_count >= invite.max_uses) throw new Error('This invite has reached its usage limit');
    d.prepare('UPDATE invites SET use_count = use_count + 1 WHERE id=?').run(invite.id);
    d.prepare('INSERT INTO invite_uses (invite_id, user_id) VALUES (?, ?)').run(invite.id, userId);
    return invite;
  })();
}

// ── Users ─────────────────────────────────────────────────────────────────────
// orgId null (platform admin) → every user, with org name attached; otherwise scoped to that org.
function getUsers(orgId) {
  if (orgId == null) {
    return getDb().prepare(`
      SELECT u.id,u.username,u.email,u.role,u.org_id,u.is_platform_admin,u.created_at,u.last_login, o.name as org_name
      FROM users u LEFT JOIN organizations o ON o.id = u.org_id ORDER BY u.id
    `).all();
  }
  return getDb().prepare(`
    SELECT id,username,email,role,org_id,is_platform_admin,created_at,last_login FROM users WHERE org_id=? ORDER BY id
  `).all(orgId);
}
function getUserById(id) { return getDb().prepare('SELECT * FROM users WHERE id=?').get(id); }
function getUserByUsername(username)   { return getDb().prepare('SELECT * FROM users WHERE username=?').get(username); }
function createUser(username, hash, role, orgId, isPlatformAdmin = false) {
  return getDb().prepare('INSERT INTO users (username,password,role,org_id,is_platform_admin) VALUES (?,?,?,?,?)')
    .run(username, hash, role, orgId ?? null, isPlatformAdmin ? 1 : 0).lastInsertRowid;
}
function updateUserPassword(id, hash)  { getDb().prepare('UPDATE users SET password=? WHERE id=?').run(hash, id); }
function updateUserEmail(id, email) { getDb().prepare('UPDATE users SET email=? WHERE id=?').run(email || null, id); }
function setUserOrg(userId, orgId) { getDb().prepare('UPDATE users SET org_id=? WHERE id=?').run(orgId, userId); }
function setUserPlatformAdmin(userId, isPlatformAdmin) { getDb().prepare('UPDATE users SET is_platform_admin=? WHERE id=?').run(isPlatformAdmin ? 1 : 0, userId); }

// Per-user notification preferences
function getUserNotifPrefs(userId) {
  const row = getDb().prepare('SELECT * FROM user_notif_prefs WHERE user_id=?').get(userId);
  if (!row) return {
    enabled: false, mode: 'all', group_ids: [], capcodes: [], keywords: [],
    alias_color_from_group: false,
    push_enabled: false, push_mode: 'all', push_group_ids: [], push_capcodes: [], push_keywords: [],
    alert_enabled: false, alert_mode: 'all', alert_group_ids: [], alert_capcodes: [], alert_keywords: [],
  };
  return {
    enabled:         !!row.enabled,
    mode:            row.mode,
    group_ids:       JSON.parse(row.group_ids       || '[]'),
    capcodes:        JSON.parse(row.capcodes        || '[]').map(normCapcode),
    keywords:        JSON.parse(row.keywords        || '[]'),
    alias_color_from_group: !!row.alias_color_from_group,
    push_enabled:    !!row.push_enabled,
    push_mode:       row.push_mode || 'all',
    push_group_ids:  JSON.parse(row.push_group_ids  || '[]'),
    push_capcodes:   JSON.parse(row.push_capcodes   || '[]').map(normCapcode),
    push_keywords:   JSON.parse(row.push_keywords   || '[]'),
    alert_enabled:   !!row.alert_enabled,
    alert_mode:      row.alert_mode || 'all',
    alert_group_ids: JSON.parse(row.alert_group_ids || '[]'),
    alert_capcodes:  JSON.parse(row.alert_capcodes  || '[]').map(normCapcode),
    alert_keywords:  JSON.parse(row.alert_keywords  || '[]'),
  };
}

function setUserNotifPrefs(userId, prefs) {
  getDb().prepare(`
    INSERT INTO user_notif_prefs
      (user_id, enabled, mode, group_ids, capcodes, keywords, alias_color_from_group,
       push_enabled, push_mode, push_group_ids, push_capcodes, push_keywords,
       alert_enabled, alert_mode, alert_group_ids, alert_capcodes, alert_keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      enabled=excluded.enabled, mode=excluded.mode,
      group_ids=excluded.group_ids, capcodes=excluded.capcodes, keywords=excluded.keywords,
      alias_color_from_group=excluded.alias_color_from_group,
      push_enabled=excluded.push_enabled, push_mode=excluded.push_mode,
      push_group_ids=excluded.push_group_ids, push_capcodes=excluded.push_capcodes,
      push_keywords=excluded.push_keywords,
      alert_enabled=excluded.alert_enabled, alert_mode=excluded.alert_mode,
      alert_group_ids=excluded.alert_group_ids, alert_capcodes=excluded.alert_capcodes,
      alert_keywords=excluded.alert_keywords
  `).run(userId,
    prefs.enabled ? 1 : 0, prefs.mode || 'all',
    JSON.stringify(prefs.group_ids       || []),
    JSON.stringify((prefs.capcodes       || []).map(normCapcode)),
    JSON.stringify(prefs.keywords        || []),
    prefs.alias_color_from_group ? 1 : 0,
    prefs.push_enabled ? 1 : 0, prefs.push_mode || 'all',
    JSON.stringify(prefs.push_group_ids  || []),
    JSON.stringify((prefs.push_capcodes  || []).map(normCapcode)),
    JSON.stringify(prefs.push_keywords   || []),
    prefs.alert_enabled ? 1 : 0, prefs.alert_mode || 'all',
    JSON.stringify(prefs.alert_group_ids || []),
    JSON.stringify((prefs.alert_capcodes || []).map(normCapcode)),
    JSON.stringify(prefs.alert_keywords  || []),
  );
}

function getAllUsersWithPrefs(orgId) {
  const users = orgId == null
    ? getDb().prepare('SELECT id, username, email FROM users ORDER BY id').all()
    : getDb().prepare('SELECT id, username, email FROM users WHERE org_id=? ORDER BY id').all(orgId);
  return users.map(u => ({ ...u, prefs: getUserNotifPrefs(u.id) }));
}
function updateUserRole(id, role)      { getDb().prepare('UPDATE users SET role=? WHERE id=?').run(role, id); }
function deleteUser(id)                { getDb().prepare('DELETE FROM users WHERE id=?').run(id); }
function touchUserLogin(id)            { getDb().prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(id); }
function countUsers()                  { return getDb().prepare('SELECT COUNT(*) as n FROM users').get().n; }
function getLastSeenId(userId)         { return getDb().prepare('SELECT last_seen_id FROM users WHERE id=?').get(userId)?.last_seen_id ?? 0; }
function setLastSeenId(userId, msgId)  { getDb().prepare('UPDATE users SET last_seen_id=? WHERE id=?').run(msgId, userId); }

// ── Highlight rules ───────────────────────────────────────────────────────────
function getHighlightRules(orgId) { return getDb().prepare('SELECT * FROM highlight_rules WHERE org_id=? ORDER BY sort_order ASC, id ASC').all(orgId); }
function upsertHighlightRule(orgId, rule) {
  if (rule.id) {
    const changes = getDb().prepare('UPDATE highlight_rules SET name=?,pattern=?,is_regex=?,color=?,bg=?,enabled=?,sort_order=? WHERE id=? AND org_id=?')
      .run(rule.name, rule.pattern, rule.is_regex?1:0, rule.color, rule.bg||'', rule.enabled?1:0, rule.sort_order||0, rule.id, orgId).changes;
    return { id: rule.id, changes };
  }
  const id = getDb().prepare('INSERT INTO highlight_rules (org_id,name,pattern,is_regex,color,bg,enabled,sort_order) VALUES (?,?,?,?,?,?,?,?)')
    .run(orgId, rule.name, rule.pattern, rule.is_regex?1:0, rule.color, rule.bg||'', rule.enabled?1:0, rule.sort_order||0).lastInsertRowid;
  return { id, changes: 1 };
}
function deleteHighlightRule(id, orgId) { return getDb().prepare('DELETE FROM highlight_rules WHERE id=? AND org_id=?').run(id, orgId).changes; }

// ── Keyword alerts ────────────────────────────────────────────────────────────
function getKeywordAlerts(orgId) {
  if (orgId == null) return getDb().prepare('SELECT * FROM keyword_alerts ORDER BY sort_order ASC, id ASC').all();
  return getDb().prepare('SELECT * FROM keyword_alerts WHERE org_id=? ORDER BY sort_order ASC, id ASC').all(orgId);
}
function upsertKeywordAlert(orgId, alert) {
  if (alert.id) {
    const changes = getDb().prepare('UPDATE keyword_alerts SET name=?,pattern=?,is_regex=?,sound=?,enabled=?,sort_order=? WHERE id=? AND org_id=?')
      .run(alert.name, alert.pattern, alert.is_regex?1:0, alert.sound||'alert', alert.enabled?1:0, alert.sort_order||0, alert.id, orgId).changes;
    return { id: alert.id, changes };
  }
  const id = getDb().prepare('INSERT INTO keyword_alerts (org_id,name,pattern,is_regex,sound,enabled,sort_order) VALUES (?,?,?,?,?,?,?)')
    .run(orgId, alert.name, alert.pattern, alert.is_regex?1:0, alert.sound||'alert', alert.enabled?1:0, alert.sort_order||0).lastInsertRowid;
  return { id, changes: 1 };
}
function deleteKeywordAlert(id, orgId) { return getDb().prepare('DELETE FROM keyword_alerts WHERE id=? AND org_id=?').run(id, orgId).changes; }

// ── Tracked aircraft ────────────────────────────────────────────────────────────
// getTrackedAircraft(orgId) is the org-visible set (global + own org) served to the
// frontend; getAllTrackedAircraft() (no filter) is for the OpenSky poller, which needs
// every org's registrations to build one combined worldwide query.
function getTrackedAircraft(orgId) {
  return getDb().prepare('SELECT * FROM tracked_aircraft WHERE org_id IS NULL OR org_id=? ORDER BY id ASC').all(orgId);
}
function getAllTrackedAircraft() {
  return getDb().prepare('SELECT * FROM tracked_aircraft ORDER BY id ASC').all();
}
function getTrackedAircraftById(id) { return getDb().prepare('SELECT * FROM tracked_aircraft WHERE id=?').get(id); }
function insertTrackedAircraft(orgId, userId, username, { registration, icao24 = null, aircraft_type = null, manufacturer = null }) {
  const id = getDb().prepare(`INSERT INTO tracked_aircraft (org_id, registration, icao24, aircraft_type, manufacturer, added_by_user_id, added_by_username)
    VALUES (?,?,?,?,?,?,?)`).run(orgId, registration, icao24, aircraft_type, manufacturer, userId, username).lastInsertRowid;
  return getTrackedAircraftById(id);
}
function updateTrackedAircraftIcao24(id, { icao24, aircraft_type = null, manufacturer = null }) {
  return getDb().prepare('UPDATE tracked_aircraft SET icao24=?, aircraft_type=?, manufacturer=? WHERE id=?')
    .run(icao24, aircraft_type, manufacturer, id).changes;
}
function updateTrackedAircraftEnabled(id, enabled) {
  return getDb().prepare('UPDATE tracked_aircraft SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id).changes;
}
// orgId=NULL promotes the row to a global/shared default, visible to every org (same
// convention as aliases/groups/the seeded Fire Boss planes) — platform-admin only, see api.js.
function setTrackedAircraftOrgId(id, orgId) {
  return getDb().prepare('UPDATE tracked_aircraft SET org_id=? WHERE id=?').run(orgId, id).changes;
}
function deleteTrackedAircraftById(id) { return getDb().prepare('DELETE FROM tracked_aircraft WHERE id=?').run(id).changes; }

// ── Voice channels (instance-wide catalog, platform-admin managed — see voice_channel_hidden
// above for the per-org opt-out layer) — separate from SDR/dongle POCSAG config ────────
// sort_order sorts first (currently unused/always 0 — no UI sets it yet, kept for a future
// manual-reorder feature) so a natural name sort is the effective order today: description
// COLLATE NOCASE handles "CH01" < "CH05" < "CH15" correctly since the numbers are zero-padded.
function getAllVoiceChannels() {
  return getDb().prepare('SELECT * FROM voice_channels ORDER BY sort_order ASC, description COLLATE NOCASE ASC, id ASC').all();
}
// What a given org's users should actually see — the full catalog minus whatever that org
// has opted out of.
function getVoiceChannels(orgId) {
  return getDb().prepare(`
    SELECT vc.* FROM voice_channels vc
    WHERE NOT EXISTS (SELECT 1 FROM voice_channel_hidden h WHERE h.channel_id = vc.id AND h.org_id = ?)
    ORDER BY vc.sort_order ASC, vc.description COLLATE NOCASE ASC, vc.id ASC
  `).all(orgId);
}
function upsertVoiceChannel(ch) {
  if (ch.id) {
    const changes = getDb().prepare('UPDATE voice_channels SET description=?,freq=?,mode=?,squelch=?,tau=?,sort_order=? WHERE id=?')
      .run(ch.description, ch.freq, ch.mode || 'nfm', ch.squelch || '', ch.tau || '', ch.sort_order || 0, ch.id).changes;
    return { id: ch.id, changes };
  }
  const id = getDb().prepare('INSERT INTO voice_channels (description,freq,mode,squelch,tau,sort_order) VALUES (?,?,?,?,?,?)')
    .run(ch.description, ch.freq, ch.mode || 'nfm', ch.squelch || '', ch.tau || '', ch.sort_order || 0).lastInsertRowid;
  return { id, changes: 1 };
}
function deleteVoiceChannel(id) { return getDb().prepare('DELETE FROM voice_channels WHERE id=?').run(id).changes; }
// Which channel ids a given org has opted out of.
function getVoiceChannelHidden(orgId) {
  return getDb().prepare('SELECT channel_id FROM voice_channel_hidden WHERE org_id=?').all(orgId).map(r => r.channel_id);
}
function setVoiceChannelHidden(orgId, channelId, hidden) {
  if (hidden) getDb().prepare('INSERT OR IGNORE INTO voice_channel_hidden (channel_id, org_id) VALUES (?,?)').run(channelId, orgId);
  else getDb().prepare('DELETE FROM voice_channel_hidden WHERE channel_id=? AND org_id=?').run(channelId, orgId);
}
// Unscoped lookup for internal SDR pipeline use — dongle_configs (instance-wide, not org-scoped)
// stores raw channel ids, so generating a dongle's rtl_airband config needs the row regardless
// of which org owns it.
function getVoiceChannelById(id) { return getDb().prepare('SELECT * FROM voice_channels WHERE id=?').get(id); }

// ── Discord relays (org-scoped) ─────────────────────────────────────────────────
// Attaches `channel_ids` (all voice_channels feeding a relay, in the app's standard
// channel order) to each row via one batched join rather than a query per relay.
function attachRelayChannelIds(rows) {
  if (rows.length === 0) return rows;
  const db = getDb();
  const placeholders = rows.map(() => '?').join(',');
  const links = db.prepare(`
    SELECT drc.relay_id, drc.voice_channel_id
    FROM discord_relay_channels drc
    JOIN voice_channels vc ON vc.id = drc.voice_channel_id
    WHERE drc.relay_id IN (${placeholders})
    ORDER BY vc.sort_order ASC, vc.id ASC
  `).all(...rows.map(r => r.id));
  const byRelay = new Map();
  for (const { relay_id, voice_channel_id } of links) {
    if (!byRelay.has(relay_id)) byRelay.set(relay_id, []);
    byRelay.get(relay_id).push(voice_channel_id);
  }
  for (const r of rows) r.channel_ids = byRelay.get(r.id) || (r.voice_channel_id != null ? [r.voice_channel_id] : []);
  return rows;
}
function getDiscordRelays(orgId) {
  const rows = orgId == null
    ? getDb().prepare('SELECT * FROM discord_relays ORDER BY id ASC').all()
    : getDb().prepare('SELECT * FROM discord_relays WHERE org_id=? ORDER BY id ASC').all(orgId);
  return attachRelayChannelIds(rows);
}
// r.channel_ids is the source of truth going forward; r.voice_channel_id is still accepted
// as a single-channel fallback for any older caller. The legacy voice_channel_id column
// mirrors channel_ids[0] purely to satisfy its own NOT NULL FK — reads should use channel_ids.
function upsertDiscordRelay(orgId, r) {
  const enabled = r.enabled ? 1 : 0;
  const channelIds = Array.isArray(r.channel_ids) && r.channel_ids.length
    ? [...new Set(r.channel_ids.map(Number))]
    : (r.voice_channel_id != null ? [Number(r.voice_channel_id)] : []);
  if (channelIds.length === 0) throw new Error('At least one voice channel is required');
  const primaryChannelId = channelIds[0];

  const db = getDb();
  const run = db.transaction(() => {
    let id = r.id;
    if (id) {
      const changes = db.prepare(`
        UPDATE discord_relays SET description=?,voice_channel_id=?,bot_token=?,guild_id=?,discord_channel_id=?,enabled=?
        WHERE id=? AND org_id=?
      `).run(r.description || '', primaryChannelId, r.bot_token, r.guild_id, r.discord_channel_id, enabled, id, orgId).changes;
      if (changes === 0) return { id, changes: 0 };
    } else {
      id = db.prepare(`
        INSERT INTO discord_relays (org_id,description,voice_channel_id,bot_token,guild_id,discord_channel_id,enabled)
        VALUES (?,?,?,?,?,?,?)
      `).run(orgId, r.description || '', primaryChannelId, r.bot_token, r.guild_id, r.discord_channel_id, enabled).lastInsertRowid;
    }
    db.prepare('DELETE FROM discord_relay_channels WHERE relay_id=?').run(id);
    const insertLink = db.prepare('INSERT OR IGNORE INTO discord_relay_channels (relay_id, voice_channel_id) VALUES (?,?)');
    for (const chId of channelIds) insertLink.run(id, chId);
    return { id, changes: 1 };
  });
  return run();
}
function deleteDiscordRelay(id, orgId) { return getDb().prepare('DELETE FROM discord_relays WHERE id=? AND org_id=?').run(id, orgId).changes; }
// Unscoped — discordRelay.js manages connections instance-wide, regardless of which org owns each row.
function getAllDiscordRelays() { return attachRelayChannelIds(getDb().prepare('SELECT * FROM discord_relays').all()); }

// ── Webhooks ──────────────────────────────────────────────────────────────────
function getWebhooks(orgId) { return getDb().prepare('SELECT * FROM webhooks WHERE org_id=? ORDER BY id').all(orgId); }
function upsertWebhook(orgId, w) {
  if (w.id) {
    const changes = getDb().prepare('UPDATE webhooks SET name=?,url=?,enabled=?,secret=? WHERE id=? AND org_id=?')
      .run(w.name, w.url, w.enabled?1:0, w.secret||null, w.id, orgId).changes;
    return { id: w.id, changes };
  }
  const id = getDb().prepare('INSERT INTO webhooks (org_id,name,url,enabled,secret) VALUES (?,?,?,?,?)')
    .run(orgId, w.name, w.url, w.enabled?1:0, w.secret||null).lastInsertRowid;
  return { id, changes: 1 };
}
function deleteWebhook(id, orgId) { return getDb().prepare('DELETE FROM webhooks WHERE id=? AND org_id=?').run(id, orgId).changes; }

// ── Audit log ─────────────────────────────────────────────────────────────────
// orgId null = platform-level action; otherwise attributed to that org.
function addAuditLog(username, action, detail, orgId = null) {
  try {
    const db = getDb();
    db.prepare('INSERT INTO audit_log (username, action, detail, org_id) VALUES (?, ?, ?, ?)').run(username, action, detail || null, orgId);
    // Keep last 1000 entries — delete older ones
    db.prepare('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1000)').run();
  } catch (e) { /* non-critical */ }
}
function getAuditLog(limit = 200, orgId = null) {
  if (orgId == null) return getDb().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  return getDb().prepare('SELECT * FROM audit_log WHERE org_id=? ORDER BY id DESC LIMIT ?').all(orgId, limit);
}

// ── Message notes ─────────────────────────────────────────────────────────────
function getMessageNotes(messageId, userId) {
  // Return shared notes + own private notes
  return getDb().prepare(`
    SELECT * FROM message_notes
    WHERE message_id = ?
      AND (is_private = 0 OR user_id = ?)
    ORDER BY id ASC
  `).all(messageId, userId ?? -1);
}

function addMessageNote(messageId, userId, username, note, isPrivate) {
  return getDb().prepare(`
    INSERT INTO message_notes (message_id, user_id, username, note, is_private)
    VALUES (?, ?, ?, ?, ?)
  `).run(messageId, userId, username, note.trim(), isPrivate ? 1 : 0).lastInsertRowid;
}

function deleteMessage(id) {
  const db = getDb();
  db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id);
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
}

function deleteMessageNote(noteId, userId, userRole) {
  // Users can only delete their own notes; admins can delete any
  if (userRole === 'admin') {
    getDb().prepare('DELETE FROM message_notes WHERE id=?').run(noteId);
  } else {
    getDb().prepare('DELETE FROM message_notes WHERE id=? AND user_id=?').run(noteId, userId);
  }
}

function getNoteCounts(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = getDb().prepare(`
    SELECT message_id, COUNT(*) as n
    FROM message_notes
    WHERE message_id IN (${placeholders}) AND is_private = 0
    GROUP BY message_id
  `).all(...messageIds);
  const map = {};
  for (const r of rows) map[r.message_id] = r.n;
  return map;
}
function getStats() {
  const d = getDb();
  return {
    total:    d.prepare('SELECT COUNT(*) as n FROM messages').get().n,
    today:    d.prepare("SELECT COUNT(*) as n FROM messages WHERE date(timestamp,'localtime')=date('now','localtime')").get().n,
    lastHour: d.prepare("SELECT COUNT(*) as n FROM messages WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now','-1 hour'))").get().n,
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────────
function saveDbSession(token, userId, username, role, expires, orgId, isPlatformAdmin) {
  getDb().prepare('INSERT OR REPLACE INTO sessions (token,user_id,username,role,expires,org_id,is_platform_admin) VALUES (?,?,?,?,?,?,?)')
    .run(token, userId, username, role, expires, orgId ?? null, isPlatformAdmin ? 1 : 0);
}
function deleteDbSession(token) {
  getDb().prepare('DELETE FROM sessions WHERE token=?').run(token);
}
function loadActiveSessions() {
  return getDb().prepare('SELECT * FROM sessions WHERE expires > ?').all(Date.now());
}
function upsertUserLocation(userId, username, lat, lng) {
  getDb().prepare(`
    INSERT INTO user_locations (user_id, username, lat, lng, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, lat=excluded.lat, lng=excluded.lng, updated_at=excluded.updated_at
  `).run(userId, username, lat, lng);
}

// orgId null = every user's location (platform admin); otherwise only that org's members —
// live position is per-user personal data, joined through users.org_id since user_locations
// itself isn't (and doesn't need to be) org-scoped as a table.
function getUserLocations(maxAgeMinutes = 5, orgId = null) {
  if (orgId == null) {
    return getDb().prepare(`
      SELECT user_id, username, lat, lng, updated_at
      FROM user_locations
      WHERE updated_at >= datetime('now', ? || ' minutes')
      ORDER BY updated_at DESC
    `).all(`-${maxAgeMinutes}`);
  }
  return getDb().prepare(`
    SELECT ul.user_id, ul.username, ul.lat, ul.lng, ul.updated_at
    FROM user_locations ul
    JOIN users u ON u.id = ul.user_id
    WHERE ul.updated_at >= datetime('now', ? || ' minutes') AND u.org_id = ?
    ORDER BY ul.updated_at DESC
  `).all(`-${maxAgeMinutes}`, orgId);
}

function deleteUserLocation(userId) {
  getDb().prepare('DELETE FROM user_locations WHERE user_id=?').run(userId);
}

function pruneExpiredSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
}

module.exports = {
  initDb, getDb,
  ALIAS_GROUP_JOIN_SQL, ALIAS_GROUP_SELECT_SQL,
  insertMessage, getHistory, searchMessages, getMessageStats, deleteMessage,
  getGroups, createGroup, updateGroup, deleteGroup, deleteAllGroups, bulkUpsertGroups,
  getAliases, upsertAlias, deleteAlias, bulkUpsertAliases, getAliasNameForCapcode,
  getSetting, setSetting,
  createOrganization, getOrganizations, getOrganization, renameOrganization, deleteOrganization,
  createInvite, getInviteByCode, listInvites, revokeInvite, consumeInvite,
  getUsers, getUserById, getUserByUsername, createUser, updateUserPassword, updateUserRole, updateUserEmail,
  deleteUser, touchUserLogin, countUsers, setUserOrg, setUserPlatformAdmin,
  getLastSeenId, setLastSeenId,
  getUserNotifPrefs, setUserNotifPrefs, getAllUsersWithPrefs, normCapcode,
  getHighlightRules, upsertHighlightRule, deleteHighlightRule,
  getKeywordAlerts, upsertKeywordAlert, deleteKeywordAlert,
  getTrackedAircraft, getAllTrackedAircraft, getTrackedAircraftById, insertTrackedAircraft,
  updateTrackedAircraftIcao24, updateTrackedAircraftEnabled, setTrackedAircraftOrgId, deleteTrackedAircraftById,
  getVoiceChannels, getAllVoiceChannels, upsertVoiceChannel, deleteVoiceChannel, getVoiceChannelById,
  getVoiceChannelHidden, setVoiceChannelHidden,
  getDiscordRelays, upsertDiscordRelay, deleteDiscordRelay, getAllDiscordRelays,
  getWebhooks, upsertWebhook, deleteWebhook,
  addAuditLog, getAuditLog,
  getStats,
  getMessageNotes, addMessageNote, deleteMessageNote, getNoteCounts,
  saveDbSession, deleteDbSession, loadActiveSessions, pruneExpiredSessions,
  upsertUserLocation, getUserLocations, deleteUserLocation, enrichSourceLabels, getLocalDongleLabel,
};

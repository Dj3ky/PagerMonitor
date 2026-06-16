const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');
const logger = require('../utils/logger');

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
      lng       REAL
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

  if (!tables.includes('groups')) {
    db.exec(`CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#4ade80', parent_id INTEGER REFERENCES groups(id) ON DELETE SET NULL
    )`);
    logger.info('Migration: created groups table');
  }

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

  const groupColumns = db.prepare("PRAGMA table_info(groups)").all().map(c => c.name);
  if (!groupColumns.includes('row_color')) {
    db.exec("ALTER TABLE groups ADD COLUMN row_color TEXT");
    db.exec("ALTER TABLE groups ADD COLUMN row_sound TEXT");
    logger.info('Migration: added row_color/row_sound to groups');
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
      push_enabled     INTEGER NOT NULL DEFAULT 0,
      push_mode        TEXT    NOT NULL DEFAULT 'all',
      push_group_ids   TEXT    NOT NULL DEFAULT '[]',
      push_capcodes    TEXT    NOT NULL DEFAULT '[]',
      push_keywords    TEXT    NOT NULL DEFAULT '[]'
    )
  `);

  const prefCols = db.prepare('PRAGMA table_info(user_notif_prefs)').all().map(c => c.name);
  if (!prefCols.includes('push_enabled')) {
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN push_enabled   INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN push_mode      TEXT    NOT NULL DEFAULT \'all\'');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN push_group_ids TEXT    NOT NULL DEFAULT \'[]\'');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN push_capcodes  TEXT    NOT NULL DEFAULT \'[]\'');
    db.exec('ALTER TABLE user_notif_prefs ADD COLUMN push_keywords  TEXT    NOT NULL DEFAULT \'[]\'');
    logger.info('Migration: added push columns to user_notif_prefs');
  }

  const msgColumns = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
  if (!msgColumns.includes('lat')) {
    db.exec('ALTER TABLE messages ADD COLUMN lat REAL');
    db.exec('ALTER TABLE messages ADD COLUMN lng REAL');
    logger.info('Migration: added lat/lng to messages');
  }

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

  // Strip leading zeros from numeric alias capcodes so they match decoder output.
  // Decoders (multimon-ng) emit addresses as plain integers with no leading zeros.
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

// ── Messages ──────────────────────────────────────────────────────────────────
function insertMessage(msg) {
  const info = getDb().prepare(`
    INSERT INTO messages (timestamp, capcode, alias, protocol, baud, funcbits, message, raw, lat, lng)
    VALUES (@timestamp, @capcode, @alias, @protocol, @baud, @funcbits, @message, @raw, @lat, @lng)
  `).run({ ...msg, lat: msg.lat ?? null, lng: msg.lng ?? null });
  return info.lastInsertRowid;
}

function getHistory(limit = 200) {
  return getDb().prepare(`
    SELECT m.*, a.name as alias_name, a.color as alias_color, a.row_color as alias_row_color, a.row_sound as alias_row_sound,
           g.id as group_id, g.name as group_name, g.color as group_color, g.row_color as group_row_color, g.row_sound as group_row_sound,
           pg.name as parent_group_name, pg.color as parent_group_color, pg.row_color as parent_group_row_color, pg.row_sound as parent_group_row_sound,
           (SELECT COUNT(*) FROM message_notes n WHERE n.message_id = m.id AND n.is_private = 0) as note_count
    FROM messages m
    LEFT JOIN aliases a  ON a.capcode = m.capcode
    LEFT JOIN groups  g  ON g.id = a.group_id
    LEFT JOIN groups  pg ON pg.id = g.parent_id
    ORDER BY m.id DESC LIMIT ?
  `).all(limit);
}

function searchMessages(query, limit = 100) {
  const safe  = query.replace(/['"*]/g, '').trim();
  const terms = safe.split(/\s+/).filter(Boolean);
  const ftsQuery = terms.map(t => `${t}*`).join(' ');
  return getDb().prepare(`
    SELECT m.*, a.name as alias_name, a.color as alias_color, a.row_color as alias_row_color, a.row_sound as alias_row_sound,
           g.id as group_id, g.name as group_name, g.color as group_color, g.row_color as group_row_color, g.row_sound as group_row_sound,
           pg.name as parent_group_name, pg.color as parent_group_color, pg.row_color as parent_group_row_color, pg.row_sound as parent_group_row_sound,
           (SELECT COUNT(*) FROM message_notes n WHERE n.message_id = m.id AND n.is_private = 0) as note_count
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    LEFT JOIN aliases a  ON a.capcode = m.capcode
    LEFT JOIN groups  g  ON g.id = a.group_id
    LEFT JOIN groups  pg ON pg.id = g.parent_id
    WHERE messages_fts MATCH ?
    ORDER BY m.id DESC LIMIT ?
  `).all(ftsQuery, limit);
}

function getMessageStats() {
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
    SELECT m.capcode, COUNT(*) as n, a.name
    FROM messages m LEFT JOIN aliases a ON a.capcode = m.capcode
    GROUP BY m.capcode ORDER BY n DESC LIMIT 10
  `).all();
  const byProtocol = d.prepare(`
    SELECT protocol, COUNT(*) as n FROM messages
    GROUP BY protocol ORDER BY n DESC
  `).all();
  return { hourly, daily, topCodes, byProtocol };
}

// ── Groups ────────────────────────────────────────────────────────────────────
function getGroups() {
  const groups  = getDb().prepare('SELECT * FROM groups ORDER BY parent_id NULLS FIRST, name').all();
  const aliases = getDb().prepare('SELECT capcode, name, color, group_id FROM aliases WHERE group_id IS NOT NULL').all();
  const aliasMap = {};
  for (const a of aliases) {
    if (!aliasMap[a.group_id]) aliasMap[a.group_id] = [];
    aliasMap[a.group_id].push(a);
  }
  return groups.map(g => ({ ...g, aliases: aliasMap[g.id] || [] }));
}
function createGroup(name, color, parent_id, row_color, row_sound) {
  return getDb().prepare('INSERT INTO groups (name, color, parent_id, row_color, row_sound) VALUES (?, ?, ?, ?, ?)').run(name, color || '#4ade80', parent_id || null, row_color || null, row_sound || null).lastInsertRowid;
}
function updateGroup(id, name, color, parent_id, row_color, row_sound) {
  getDb().prepare('UPDATE groups SET name=?, color=?, parent_id=?, row_color=?, row_sound=? WHERE id=?').run(name, color || '#4ade80', parent_id || null, row_color || null, row_sound || null, id);
}
function deleteGroup(id) {
  getDb().prepare('UPDATE aliases SET group_id=NULL WHERE group_id=?').run(id);
  getDb().prepare('UPDATE groups SET parent_id=NULL WHERE parent_id=?').run(id);
  getDb().prepare('DELETE FROM groups WHERE id=?').run(id);
}

// ── Aliases ───────────────────────────────────────────────────────────────────
function getAliases() {
  return getDb().prepare(`
    SELECT a.*, g.name as group_name, g.color as group_color
    FROM aliases a LEFT JOIN groups g ON g.id = a.group_id ORDER BY a.capcode
  `).all();
}
// Capcodes are plain integers from the decoder (no leading zeros). Strip leading zeros
// from user-supplied values so aliases always match decoded messages.
const normCapcode = c => /^\d+$/.test(c) ? String(parseInt(c, 10)) : c;

function upsertAlias(capcode, name, color, notes, group_id, row_color, row_sound) {
  getDb().prepare(`
    INSERT INTO aliases (capcode, name, color, notes, group_id, row_color, row_sound) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(capcode) DO UPDATE SET name=excluded.name, color=excluded.color, notes=excluded.notes,
      group_id=excluded.group_id, row_color=excluded.row_color, row_sound=excluded.row_sound
  `).run(normCapcode(capcode), name, color || '#4ade80', notes || null, group_id || null, row_color || null, row_sound || null);
}
function deleteAlias(capcode) { getDb().prepare('DELETE FROM aliases WHERE capcode=?').run(normCapcode(capcode)); }
function bulkUpsertAliases(rows) {
  const stmt = getDb().prepare(`INSERT INTO aliases (capcode, name, color, notes, group_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(capcode) DO UPDATE SET name=excluded.name, color=excluded.color, notes=excluded.notes, group_id=excluded.group_id`);
  getDb().transaction(rows => { for (const r of rows) stmt.run(normCapcode(r.capcode), r.name, r.color || '#4ade80', r.notes || null, r.group_id || null); })(rows);
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

// ── Users ─────────────────────────────────────────────────────────────────────
function getUsers() { return getDb().prepare('SELECT id,username,email,role,created_at,last_login FROM users ORDER BY id').all(); }
function getUserByUsername(username)   { return getDb().prepare('SELECT * FROM users WHERE username=?').get(username); }
function createUser(username, hash, role) { return getDb().prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)').run(username, hash, role).lastInsertRowid; }
function updateUserPassword(id, hash)  { getDb().prepare('UPDATE users SET password=? WHERE id=?').run(hash, id); }
function updateUserEmail(id, email) { getDb().prepare('UPDATE users SET email=? WHERE id=?').run(email || null, id); }

// Per-user notification preferences
function getUserNotifPrefs(userId) {
  const row = getDb().prepare('SELECT * FROM user_notif_prefs WHERE user_id=?').get(userId);
  if (!row) return {
    enabled: false, mode: 'all', group_ids: [], capcodes: [], keywords: [],
    push_enabled: false, push_mode: 'all', push_group_ids: [], push_capcodes: [], push_keywords: [],
  };
  return {
    enabled:        !!row.enabled,
    mode:           row.mode,
    group_ids:      JSON.parse(row.group_ids      || '[]'),
    capcodes:       JSON.parse(row.capcodes       || '[]'),
    keywords:       JSON.parse(row.keywords       || '[]'),
    push_enabled:   !!row.push_enabled,
    push_mode:      row.push_mode || 'all',
    push_group_ids: JSON.parse(row.push_group_ids || '[]'),
    push_capcodes:  JSON.parse(row.push_capcodes  || '[]'),
    push_keywords:  JSON.parse(row.push_keywords  || '[]'),
  };
}

function setUserNotifPrefs(userId, prefs) {
  getDb().prepare(`
    INSERT INTO user_notif_prefs
      (user_id, enabled, mode, group_ids, capcodes, keywords,
       push_enabled, push_mode, push_group_ids, push_capcodes, push_keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      enabled=excluded.enabled, mode=excluded.mode,
      group_ids=excluded.group_ids, capcodes=excluded.capcodes, keywords=excluded.keywords,
      push_enabled=excluded.push_enabled, push_mode=excluded.push_mode,
      push_group_ids=excluded.push_group_ids, push_capcodes=excluded.push_capcodes,
      push_keywords=excluded.push_keywords
  `).run(userId,
    prefs.enabled ? 1 : 0, prefs.mode || 'all',
    JSON.stringify(prefs.group_ids      || []),
    JSON.stringify(prefs.capcodes       || []),
    JSON.stringify(prefs.keywords       || []),
    prefs.push_enabled ? 1 : 0, prefs.push_mode || 'all',
    JSON.stringify(prefs.push_group_ids || []),
    JSON.stringify(prefs.push_capcodes  || []),
    JSON.stringify(prefs.push_keywords  || []),
  );
}

function getAllUsersWithPrefs() {
  const users = getDb().prepare('SELECT id, username, email FROM users ORDER BY id').all();
  return users.map(u => ({ ...u, prefs: getUserNotifPrefs(u.id) }));
}
function updateUserRole(id, role)      { getDb().prepare('UPDATE users SET role=? WHERE id=?').run(role, id); }
function deleteUser(id)                { getDb().prepare('DELETE FROM users WHERE id=?').run(id); }
function touchUserLogin(id)            { getDb().prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(id); }
function countUsers()                  { return getDb().prepare('SELECT COUNT(*) as n FROM users').get().n; }
function getLastSeenId(userId)         { return getDb().prepare('SELECT last_seen_id FROM users WHERE id=?').get(userId)?.last_seen_id ?? 0; }
function setLastSeenId(userId, msgId)  { getDb().prepare('UPDATE users SET last_seen_id=? WHERE id=?').run(msgId, userId); }

// ── Highlight rules ───────────────────────────────────────────────────────────
function getHighlightRules() { return getDb().prepare('SELECT * FROM highlight_rules ORDER BY sort_order ASC, id ASC').all(); }
function upsertHighlightRule(rule) {
  if (rule.id) {
    getDb().prepare('UPDATE highlight_rules SET name=?,pattern=?,is_regex=?,color=?,bg=?,enabled=?,sort_order=? WHERE id=?')
      .run(rule.name, rule.pattern, rule.is_regex?1:0, rule.color, rule.bg||'', rule.enabled?1:0, rule.sort_order||0, rule.id);
    return rule.id;
  }
  return getDb().prepare('INSERT INTO highlight_rules (name,pattern,is_regex,color,bg,enabled,sort_order) VALUES (?,?,?,?,?,?,?)')
    .run(rule.name, rule.pattern, rule.is_regex?1:0, rule.color, rule.bg||'', rule.enabled?1:0, rule.sort_order||0).lastInsertRowid;
}
function deleteHighlightRule(id) { getDb().prepare('DELETE FROM highlight_rules WHERE id=?').run(id); }

// ── Keyword alerts ────────────────────────────────────────────────────────────
function getKeywordAlerts() { return getDb().prepare('SELECT * FROM keyword_alerts ORDER BY sort_order ASC, id ASC').all(); }
function upsertKeywordAlert(alert) {
  if (alert.id) {
    getDb().prepare('UPDATE keyword_alerts SET name=?,pattern=?,is_regex=?,sound=?,enabled=?,sort_order=? WHERE id=?')
      .run(alert.name, alert.pattern, alert.is_regex?1:0, alert.sound||'alert', alert.enabled?1:0, alert.sort_order||0, alert.id);
    return alert.id;
  }
  return getDb().prepare('INSERT INTO keyword_alerts (name,pattern,is_regex,sound,enabled,sort_order) VALUES (?,?,?,?,?,?)')
    .run(alert.name, alert.pattern, alert.is_regex?1:0, alert.sound||'alert', alert.enabled?1:0, alert.sort_order||0).lastInsertRowid;
}
function deleteKeywordAlert(id) { getDb().prepare('DELETE FROM keyword_alerts WHERE id=?').run(id); }

// ── Webhooks ──────────────────────────────────────────────────────────────────
function getWebhooks() { return getDb().prepare('SELECT * FROM webhooks ORDER BY id').all(); }
function upsertWebhook(w) {
  if (w.id) {
    getDb().prepare('UPDATE webhooks SET name=?,url=?,enabled=?,secret=? WHERE id=?').run(w.name, w.url, w.enabled?1:0, w.secret||null, w.id);
    return w.id;
  }
  return getDb().prepare('INSERT INTO webhooks (name,url,enabled,secret) VALUES (?,?,?,?)').run(w.name, w.url, w.enabled?1:0, w.secret||null).lastInsertRowid;
}
function deleteWebhook(id) { getDb().prepare('DELETE FROM webhooks WHERE id=?').run(id); }

// ── Audit log ─────────────────────────────────────────────────────────────────
function addAuditLog(username, action, detail) {
  try {
    const db = getDb();
    db.prepare('INSERT INTO audit_log (username, action, detail) VALUES (?, ?, ?)').run(username, action, detail || null);
    // Keep last 1000 entries — delete older ones
    db.prepare('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1000)').run();
  } catch (e) { /* non-critical */ }
}
function getAuditLog(limit = 200) {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
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
function saveDbSession(token, userId, username, role, expires) {
  getDb().prepare('INSERT OR REPLACE INTO sessions (token,user_id,username,role,expires) VALUES (?,?,?,?,?)').run(token, userId, username, role, expires);
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

function getUserLocations(maxAgeMinutes = 5) {
  return getDb().prepare(`
    SELECT user_id, username, lat, lng, updated_at
    FROM user_locations
    WHERE updated_at >= datetime('now', ? || ' minutes')
    ORDER BY updated_at DESC
  `).all(`-${maxAgeMinutes}`);
}

function deleteUserLocation(userId) {
  getDb().prepare('DELETE FROM user_locations WHERE user_id=?').run(userId);
}

function pruneExpiredSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
}

module.exports = {
  initDb, getDb,
  insertMessage, getHistory, searchMessages, getMessageStats, deleteMessage,
  getGroups, createGroup, updateGroup, deleteGroup,
  getAliases, upsertAlias, deleteAlias, bulkUpsertAliases,
  getSetting, setSetting,
  getUsers, getUserByUsername, createUser, updateUserPassword, updateUserRole, updateUserEmail, deleteUser, touchUserLogin, countUsers,
  getLastSeenId, setLastSeenId,
  getUserNotifPrefs, setUserNotifPrefs, getAllUsersWithPrefs,
  getHighlightRules, upsertHighlightRule, deleteHighlightRule,
  getKeywordAlerts, upsertKeywordAlert, deleteKeywordAlert,
  getWebhooks, upsertWebhook, deleteWebhook,
  addAuditLog, getAuditLog,
  getStats,
  getMessageNotes, addMessageNote, deleteMessageNote, getNoteCounts,
  saveDbSession, deleteDbSession, loadActiveSessions, pruneExpiredSessions,
  upsertUserLocation, getUserLocations, deleteUserLocation,
};

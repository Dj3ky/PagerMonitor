'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const logger   = require('../utils/logger');
const { getDb, getSetting } = require('./database');

const DB_PATH      = process.env.DB_PATH      || './data/pagermonitor.db';
const ARCHIVE_PATH = process.env.ARCHIVE_PATH || path.join(path.dirname(path.resolve(DB_PATH)), 'archive.db');

let archiveDb = null;

// ── Init archive DB ───────────────────────────────────────────────────────────
function getArchiveDb() {
  if (archiveDb) return archiveDb;
  const dir = path.dirname(ARCHIVE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  archiveDb = new Database(ARCHIVE_PATH);
  archiveDb.pragma('journal_mode = WAL');
  archiveDb.pragma('synchronous = NORMAL');

  archiveDb.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY,
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
      archived_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_arch_timestamp ON messages(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_arch_capcode   ON messages(capcode);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message, capcode, alias,
      content='messages', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS arch_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, message, capcode, alias)
      VALUES (new.id, new.message, new.capcode, new.alias);
    END;
  `);

  logger.info(`Archive DB at ${ARCHIVE_PATH}`);
  return archiveDb;
}

// ── Archive messages older than N days ────────────────────────────────────────
function archiveOldMessages(days) {
  const main = getDb();
  const arch = getArchiveDb();

  // Find messages to archive
  const toArchive = main.prepare(`
    SELECT * FROM messages
    WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-' || ? || ' days'))
  `).all(days);

  if (toArchive.length === 0) return 0;

  const insertArch = arch.prepare(`
    INSERT OR IGNORE INTO messages
      (id, timestamp, capcode, alias, protocol, baud, funcbits, message, raw, lat, lng)
    VALUES
      (@id, @timestamp, @capcode, @alias, @protocol, @baud, @funcbits, @message, @raw, @lat, @lng)
  `);

  const deleteFts = main.prepare('DELETE FROM messages_fts WHERE rowid = ?');
  const deleteMsg = main.prepare('DELETE FROM messages WHERE id = ?');

  const archiveTx = arch.transaction((rows) => {
    for (const row of rows) insertArch.run(row);
  });

  const deleteTx = main.transaction((ids) => {
    for (const id of ids) { deleteFts.run(id); deleteMsg.run(id); }
  });

  archiveTx(toArchive);
  deleteTx(toArchive.map(r => r.id));

  try { main.exec('VACUUM'); } catch (_) {}

  logger.info(`Archived ${toArchive.length} messages older than ${days} days`);
  return toArchive.length;
}

// ── Search archive ────────────────────────────────────────────────────────────
function searchArchive(query, limit = 100) {
  const safe = query.replace(/['"*]/g, '');
  return getArchiveDb().prepare(`
    SELECT m.* FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    WHERE messages_fts MATCH ?
    ORDER BY m.id DESC LIMIT ?
  `).all(`"${safe}"`, limit);
}

function getArchiveHistory(limit = 200) {
  return getArchiveDb().prepare(
    'SELECT * FROM messages ORDER BY id DESC LIMIT ?'
  ).all(limit);
}

function getArchiveStats() {
  const d = getArchiveDb();
  return {
    total:   d.prepare('SELECT COUNT(*) as n FROM messages').get().n,
    oldest:  d.prepare('SELECT MIN(timestamp) as t FROM messages').get()?.t || null,
    newest:  d.prepare('SELECT MAX(timestamp) as t FROM messages').get()?.t || null,
    path:    ARCHIVE_PATH,
  };
}

// ── Scheduled archiver ────────────────────────────────────────────────────────
let archiveTimer = null;

function startArchiveScheduler() {
  clearInterval(archiveTimer);
  // Run once at startup (after 30s to let server settle), then every 6 hours
  setTimeout(() => runScheduledArchive(), 30_000);
  archiveTimer = setInterval(() => runScheduledArchive(), 6 * 3600 * 1000);
  logger.info('Archive scheduler started (runs every 6 hours)');
}

function runScheduledArchive() {
  try {
    const cfg = getSetting('archive_config', { enabled: false, afterDays: 30 });
    if (!cfg.enabled) return;
    const count = archiveOldMessages(cfg.afterDays);
    if (count > 0) logger.info(`Scheduled archive: moved ${count} messages`);
  } catch (e) {
    logger.warn(`Archive scheduler error: ${e.message}`);
  }
}

function stopArchiveScheduler() { clearInterval(archiveTimer); }

module.exports = {
  getArchiveDb, archiveOldMessages, searchArchive,
  getArchiveHistory, getArchiveStats,
  startArchiveScheduler, stopArchiveScheduler,
};

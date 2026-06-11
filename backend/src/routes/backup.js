'use strict';

/**
 * Backup / Restore routes
 *
 * GET  /admin/backup/download        — streams a .tar backup of all DBs + settings
 * POST /admin/backup/restore         — accepts multipart upload of a .tar backup
 * GET  /admin/backup/status          — info about current DBs (size, last modified)
 */

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { spawn } = require('child_process');
const pipelineAsync = promisify(pipeline);

const { requireAdmin }  = require('../services/auth');
const { getDb, getSetting, addAuditLog } = require('../services/database');
const logger = require('../utils/logger');

const DB_PATH      = process.env.DB_PATH      || './data/pagermonitor.db';
const ARCHIVE_PATH = process.env.ARCHIVE_PATH ||
  path.join(path.dirname(path.resolve(DB_PATH)), 'archive.db');

function localTs() {
  const tz = (getSetting('site_settings', {}).timezone) || 'Europe/Ljubljana';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}-${p.minute}-${p.second}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function dbStats(filePath) {
  if (!fs.existsSync(filePath)) return { exists:false, size:0, sizeHuman:'0 B', modified:null, path:filePath };

  // Include WAL file size if it exists (uncommitted writes live there)
  let size = fs.statSync(filePath).size;
  const walPath = filePath + '-wal';
  if (fs.existsSync(walPath)) size += fs.statSync(walPath).size;

  // Use the most recent mtime between db and wal files
  let mtime = fs.statSync(filePath).mtime;
  if (fs.existsSync(walPath)) {
    const walMtime = fs.statSync(walPath).mtime;
    if (walMtime > mtime) mtime = walMtime;
  }

  return {
    exists:    true,
    size,
    sizeHuman: fmtSize(size),
    modified:  mtime.toISOString(),
    path:      filePath,
  };
}

// ── GET /admin/backup/status ───────────────────────────────────────────────────
router.get('/status', requireAdmin, (_req, res) => {
  // Checkpoint WAL so the main file is up to date before reading stats
  try { getDb().pragma('wal_checkpoint(PASSIVE)'); } catch (_) {}

  const mainPath = path.resolve(DB_PATH);
  const archPath = path.resolve(ARCHIVE_PATH);
  res.json({
    main:    dbStats(mainPath),
    archive: dbStats(archPath),
  });
});

// ── GET /admin/backup/download?db=main|archive|all ────────────────────────────
// Downloads a safe SQLite backup copy. Uses better-sqlite3 .backup() for
// consistency — safe to run while the DB is in use.
router.get('/download', requireAdmin, async (req, res) => {
  const which = req.query.db || 'all';
  const tmpDir = os.tmpdir();
  const ts = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(req.query.ts) ? req.query.ts : localTs();

  try {
    if (which === 'main' || which === 'all') {
      const tmpMain = path.join(tmpDir, `pagermonitor-${ts}.db`);
      await getDb().backup(tmpMain);

      if (which === 'main') {
        res.setHeader('Content-Disposition', `attachment; filename="pagermonitor-${ts}.db"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        const stream = fs.createReadStream(tmpMain);
        stream.on('end', () => fs.unlink(tmpMain, () => {}));
        stream.pipe(res);
        addAuditLog(req.session.username, 'backup.download', 'main DB');
        return;
      }

      // For 'all' — also backup archive if it exists
      const archPath = path.resolve(ARCHIVE_PATH);
      let tmpArch = null;
      if (fs.existsSync(archPath)) {
        const { getArchiveDb } = require('../services/archive');
        tmpArch = path.join(tmpDir, `archive-${ts}.db`);
        await getArchiveDb().backup(tmpArch);
      }

      // Build a simple tar-like bundle using node built-ins
      // We'll create a JSON manifest + base64 encoded DBs in one JSON file
      const bundle = {
        version:   '2.0',
        created:   new Date().toISOString(),
        main:      fs.readFileSync(tmpMain).toString('base64'),
        archive:   tmpArch ? fs.readFileSync(tmpArch).toString('base64') : null,
      };

      // Cleanup temp files
      fs.unlink(tmpMain, () => {});
      if (tmpArch) fs.unlink(tmpArch, () => {});

      const json = JSON.stringify(bundle);
      res.setHeader('Content-Disposition', `attachment; filename="pagermonitor-backup-${ts}.pmbackup"`);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', Buffer.byteLength(json));
      res.send(json);
      addAuditLog(req.session.username, 'backup.download', 'full backup (main + archive)');
    } else if (which === 'archive') {
      const archPath = path.resolve(ARCHIVE_PATH);
      if (!fs.existsSync(archPath)) return res.status(404).json({ error: 'No archive database exists yet' });
      const { getArchiveDb } = require('../services/archive');
      const tmpArch = path.join(tmpDir, `archive-${ts}.db`);
      await getArchiveDb().backup(tmpArch);
      res.setHeader('Content-Disposition', `attachment; filename="archive-${ts}.db"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      const stream = fs.createReadStream(tmpArch);
      stream.on('end', () => fs.unlink(tmpArch, () => {}));
      stream.pipe(res);
      addAuditLog(req.session.username, 'backup.download', 'archive DB');
    }
  } catch (e) {
    logger.error(`Backup download failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /admin/backup/restore ─────────────────────────────────────────────────
// Accepts a .pmbackup JSON file (from the download above), restores both DBs.
// Server must be restarted after restore for changes to take effect.
router.post('/restore', requireAdmin, async (req, res) => {
  try {
    const bundle = req.body;
    if (!bundle || !bundle.version || !bundle.main) return res.status(400).json({ error: 'Invalid backup file — missing required fields' });

    const mainPath = path.resolve(DB_PATH);
    const archPath = path.resolve(ARCHIVE_PATH);
    const ts = localTs();

    // Checkpoint WAL so all pending writes are flushed into the main DB file
    try { getDb().pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}

    // Remove stale WAL and SHM files — if they're left on disk SQLite will
    // try to apply them to the newly-restored DB on next open, causing SQLITE_CORRUPT
    for (const suffix of ['-wal', '-shm']) {
      const walFile = mainPath + suffix;
      if (fs.existsSync(walFile)) { try { fs.unlinkSync(walFile); } catch (_) {} }
      const archWal = archPath + suffix;
      if (fs.existsSync(archWal)) { try { fs.unlinkSync(archWal); } catch (_) {} }
    }

    // Backup current files before overwriting
    if (fs.existsSync(mainPath)) {
      fs.copyFileSync(mainPath, `${mainPath}.pre-restore-${ts}`);
    }

    // Decode and verify the main DB before replacing the live file
    const mainBuf = Buffer.from(bundle.main, 'base64');
    const tmpMain = `${mainPath}.restore-tmp`;
    fs.writeFileSync(tmpMain, mainBuf);
    try {
      const BetterSqlite3 = require('better-sqlite3');
      const testDb = new BetterSqlite3(tmpMain, { readonly: true });
      let integrityOk = false;
      try {
        const rows = testDb.pragma('integrity_check');
        integrityOk = rows.length > 0 && rows[0].integrity_check === 'ok';
      } finally {
        testDb.close();
      }
      if (!integrityOk) throw new Error('Restored database failed integrity check — backup file may be corrupt');
    } catch (verifyErr) {
      fs.unlink(tmpMain, () => {});
      // Remove the pre-restore copy we just made so we don't leave clutter
      try { fs.unlinkSync(`${mainPath}.pre-restore-${ts}`); } catch (_) {}
      throw verifyErr;
    }
    fs.renameSync(tmpMain, mainPath);
    logger.info(`Restore: wrote main DB (${mainBuf.length} bytes, integrity OK)`);

    // Decode and verify archive DB if present
    if (bundle.archive) {
      const archBuf = Buffer.from(bundle.archive, 'base64');
      const tmpArch = `${archPath}.restore-tmp`;
      fs.writeFileSync(tmpArch, archBuf);
      try {
        const BetterSqlite3 = require('better-sqlite3');
        const testDb = new BetterSqlite3(tmpArch, { readonly: true });
        let integrityOk = false;
        try {
          const rows = testDb.pragma('integrity_check');
          integrityOk = rows.length > 0 && rows[0].integrity_check === 'ok';
        } finally {
          testDb.close();
        }
        if (!integrityOk) throw new Error('Restored archive database failed integrity check');
      } catch (verifyErr) {
        fs.unlink(tmpArch, () => {});
        throw verifyErr;
      }
      fs.renameSync(tmpArch, archPath);
      logger.info(`Restore: wrote archive DB (${archBuf.length} bytes, integrity OK)`);
    }

    addAuditLog(req.session.username, 'backup.restore', `from backup created ${bundle.created}`);
    logger.warn(`Backup restored by ${req.session.username} — server restart required`);

    res.json({
      ok: true,
      message: 'Restore complete. Please restart the server for changes to take full effect.',
      restored: { main: true, archive: !!bundle.archive },
      created: bundle.created,
    });
  } catch (e) {
    logger.error(`Restore failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /admin/backup/restart ─────────────────────────────────────────────────
// Restarts the server the same way the update panel does:
//   1. systemctl restart (detached) — works when running as a systemd service
//   2. SIGTERM fallback after 2s   — works under Docker (restart: unless-stopped) / PM2
router.post('/restart', requireAdmin, (req, res) => {
  addAuditLog(req.session.username, 'server.restart', 'manual restart via admin panel');
  logger.warn(`Server restart requested by ${req.session.username}`);
  res.json({ ok: true, message: 'Restarting server…' });
  res.on('finish', () => {
    // Primary: ask systemd to restart the service (proven to work — same as update panel)
    const r = spawn('sudo', ['systemctl', 'restart', 'pagermonitor'],
      { detached: true, stdio: 'ignore' });
    r.unref();
    // Fallback: if not running under systemd (Docker, PM2, etc.) exit after 2s
    // so the process manager brings us back up
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 2000);
  });
});

module.exports = router;

require('dotenv').config();
const express = require('express');
const http    = require('http');
const cors    = require('cors');
const path    = require('path');

const { initDb }            = require('./services/database');
const { initWebSocket, closeWebSocket } = require('./services/websocket');
const { startSdrPipeline, stopSdrPipeline } = require('./services/sdr');
const { startDeadAirCheck }     = require('./services/deadair');
const { startArchiveScheduler } = require('./services/archive');
const { loadSdrConfigIntoEnv } = require('./services/config');
const { ensureDefaultAdmin, initSessions } = require('./services/auth');
const { initWebPush } = require('./services/webpush');
const logger                = require('./utils/logger');

const apiRouter   = require('./routes/api');
const adminRouter = require('./routes/admin');
const authRouter  = require('./routes/auth');
const backupRouter = require('./routes/backup');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MODE = process.env.MODE || 'single';

async function main() {
  logger.info(`PagerMonitor v2 starting in ${MODE} mode`);

  // Init database (creates tables including users, settings, highlight_rules)
  initDb();

  // Restore sessions persisted before last restart — users stay logged in
  initSessions();

  // Load persisted SDR config from DB into process.env (overrides .env defaults)
  loadSdrConfigIntoEnv();

  // Initialise VAPID keys for browser push notifications
  initWebPush();

  // Load static alias file

  // Ensure at least one admin user exists
  await ensureDefaultAdmin();

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '500mb' }));
  app.use(express.raw({ type: 'application/octet-stream', limit: '500mb' }));

  // Auth routes (public — login, setup check)
  app.use('/auth', authRouter);

  // Public site settings (shown on login page + drives public mode, no auth required)
  app.get('/api/site-settings', (_req, res) => {
    const { getSetting } = require('./services/database');
    try {
      const s = getSetting('site_settings', { siteName: 'PagerMonitor', siteDescription: 'Real-time pager decoder', newBadgeSeconds: 10, publicMode: false });
      res.json(s);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Public mode middleware — must run BEFORE apiRouter so req.publicAccess is set
  // before requireAuth is evaluated inside route handlers
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET') return next(); // only GET is public
    const { getSetting } = require('./services/database');
    try {
      const s = getSetting('site_settings', { publicMode: false });
      if (s.publicMode) {
        req.publicAccess = true;
      }
    } catch (_) {}
    next();
  });

  // REST API
  app.use('/api', apiRouter);

  // Client ingestion (remote RPi clients forwarding SDR data)
  const clientRouter = require('./routes/client');
  app.use('/client', clientRouter);

  // Admin routes (protected — requireAdmin inside)
  app.use('/admin', adminRouter);
  app.use('/admin/backup', backupRouter);

  // Health check
  app.get('/health', (_req, res) => {
    try {
      const { getStats } = require('./services/database');
      const { getStatus } = require('./services/sdr');
      const stats  = getStats();
      const sdr    = getStatus();
      const mem    = process.memoryUsage();
      const uptime = process.uptime();

      res.json({
        ok:      true,
        status:  'healthy',
        version: require('../package.json').version,
        uptime: {
          seconds: Math.floor(uptime),
          human:   uptimeHuman(uptime),
        },
        database: {
          ok:       true,
          messages: stats.total,
          today:    stats.today,
        },
        sdr: {
          running:     sdr.running ?? false,
          lastMessage: sdr.lastMessage || null,
        },
        memory: {
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          rssMB:      Math.round(mem.rss      / 1024 / 1024),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, status: 'unhealthy', error: e.message });
    }
  });

  function uptimeHuman(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s}s`;
  }

  // Serve frontend in single mode
  if (MODE === 'single') {
    const frontendDist = path.resolve(__dirname, '../../frontend/dist');
    const fs = require('fs');
    if (fs.existsSync(frontendDist)) {
      app.use(express.static(frontendDist));
      app.get('*', (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
      logger.info(`Serving frontend from ${frontendDist}`);
    }
  }

  const server = http.createServer(app);
  initWebSocket(server);

  server.listen(PORT, HOST, () => logger.info(`Backend listening on ${HOST}:${PORT}`));

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${PORT} is already in use. Kill the other process first:`);
      logger.error(`  sudo kill $(sudo lsof -t -i :${PORT})`);
    } else {
      logger.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });

  if (process.env.DISABLE_SDR !== 'true') {
    startSdrPipeline();
  } else {
    logger.warn('SDR pipeline disabled (DISABLE_SDR=true)');
  }

  startDeadAirCheck();
  startArchiveScheduler();

  const shutdown = sig => {
    logger.info(`${sig} received`);
    stopSdrPipeline();
    closeWebSocket();
    server.close(() => process.exit(0));
    setTimeout(() => { logger.warn('Forced exit after 5s'); process.exit(0); }, 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

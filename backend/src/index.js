require('dotenv').config();
const express = require('express');
const http    = require('http');
const cors    = require('cors');
const path    = require('path');

const { initDb }            = require('./services/database');
const { initWebSocket, closeWebSocket } = require('./services/websocket');
const { initAudioSourceWs } = require('./services/audioRelay');
const discordRelay = require('./services/discordRelay');
const { startSdrPipeline, stopSdrPipeline } = require('./services/sdr');
const { startDeadAirCheck }     = require('./services/deadair');
const { startArchiveScheduler } = require('./services/archive');
const arsoWeather               = require('./services/arsoWeather');
const smokWater                 = require('./services/smokWater');
const arsoQuakes                = require('./services/arsoQuakes');
const openskyAircraft           = require('./services/openskyAircraft');
const napTraffic                = require('./services/napTraffic');
const interventions              = require('./services/interventions');
const vecjiObseg                 = require('./services/vecjiObseg');
const { loadSdrConfigIntoEnv } = require('./services/config');
const { ensureDefaultAdmin } = require('./services/auth');
const { initWebPush } = require('./services/webpush');
const { initFcm } = require('./services/fcmPush');
const logger                = require('./utils/logger');

const apiRouter   = require('./routes/api');
const adminRouter = require('./routes/admin');
const authRouter  = require('./routes/auth');
const backupRouter = require('./routes/backup');
const { RESTORE_PATH } = backupRouter;

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MODE = process.env.MODE || 'single';

async function main() {
  logger.info(`PagerMonitor v2 starting in ${MODE} mode`);

  // Init database (creates tables including users, settings, highlight_rules)
  initDb();

  // Load persisted SDR config from DB into process.env (overrides .env defaults)
  loadSdrConfigIntoEnv();

  // Initialise VAPID keys for browser push notifications
  initWebPush();

  // Initialise Firebase Cloud Messaging for the native Android app (no-op if unconfigured)
  initFcm();

  // Load static alias file

  // Ensure at least one admin user exists
  await ensureDefaultAdmin();

  const app = express();
  // Which proxies may set X-Forwarded-For, i.e. how req.ip finds the real client — the
  // login rate limits key on it. Default: proxies on the same host or a private network
  // (nginx in front, Docker bridge); a directly exposed server ignores the header, so it
  // can't be spoofed from the internet. Override with TRUST_PROXY (true/false, a hop
  // count, or Express's address/subnet list syntax).
  const trustProxy = process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal';
  app.set('trust proxy', trustProxy === 'true' ? true : trustProxy === 'false' ? false
    : /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10) : trustProxy);
  // Cross-origin access only for the configured origins — the web UI itself is same-origin
  // and needs none. Default covers the native app's WebView (Capacitor: https://localhost
  // on Android, capacitor://localhost on iOS). Auth is a bearer header, never cookies, so
  // credentials stay off.
  const corsOrigins = (process.env.CORS_ORIGINS || 'https://localhost,capacitor://localhost')
    .split(',').map(o => o.trim()).filter(Boolean);
  app.use(cors({ origin: corsOrigins }));
  // Pin the browser default explicitly: cross-origin requests (map tiles, Google Maps links)
  // only ever see our origin, never a full URL — which can carry a ?reset= token.
  app.use((_req, res, next) => { res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); next(); });
  // 1 MB for every JSON body — this runs before any auth check, so a large limit here would
  // let anyone exhaust memory. The only big upload, backup restore, is skipped here and
  // parsed by its own route after the platform-admin check (see routes/backup.js).
  const jsonBody = express.json({ limit: '1mb' });
  app.use((req, res, next) => (req.path === RESTORE_PATH ? next() : jsonBody(req, res, next)));
  app.use((err, _req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    next(err);
  });

  // Auth routes (public — login, setup check)
  app.use('/auth', authRouter);

  // Public site settings (shown on login page + drives public mode, no auth required)
  app.get('/api/site-settings', (_req, res) => {
    const { getSetting } = require('./services/database');
    try {
      const s = getSetting('site_settings', { siteName: 'PagerMonitor', siteDescription: 'Real-time pager decoder', newBadgeSeconds: 10, publicMode: false, enableTraffic: false, enableAircraft: false, enableArsoWeather: false, enableInterventions: false });
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
  initAudioSourceWs(server);
  discordRelay.init();

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
  arsoWeather.start();
  smokWater.start();
  arsoQuakes.start();
  openskyAircraft.start();
  napTraffic.start();
  interventions.start();
  vecjiObseg.start();

  const shutdown = sig => {
    logger.info(`${sig} received`);
    stopSdrPipeline();
    arsoWeather.stop();
    smokWater.stop();
    arsoQuakes.stop();
    openskyAircraft.stop();
    napTraffic.stop();
    interventions.stop();
    vecjiObseg.stop();
    closeWebSocket();
    server.close(() => process.exit(0));
    setTimeout(() => { logger.warn('Forced exit after 5s'); process.exit(0); }, 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

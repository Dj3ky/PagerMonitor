const { WebSocketServer, WebSocket } = require('ws');
const { parse } = require('url');
const logger = require('../utils/logger');

let wss;
let clientCount = 0;

// Lazy references to avoid circular require at module load time
function getSdrStatus() {
  try { return require('./sdr').getStatus(); } catch (_) { return null; }
}
function resolveConnectionOrg(token) {
  const { validateSession, getPublicOrgId } = require('./auth');
  const { getSetting } = require('./database');
  if (token) {
    const s = validateSession(token);
    if (s) return { orgId: s.orgId, isPlatformAdmin: !!s.isPlatformAdmin };
  }
  // No (valid) token — allow only if the instance is in public mode, mirroring the
  // req.publicAccess GET-only exception in services/auth.js's requireAuth.
  const publicMode = !!getSetting('site_settings', {}).publicMode;
  if (publicMode) return { orgId: getPublicOrgId(), isPlatformAdmin: false };
  return null;
}

function initWebSocket(server) {
  // noServer + manual upgrade routing (not { server, path }) — two WebSocketServer
  // instances both attached via { server, path } each fire their own internal upgrade
  // handler for *every* upgrade request regardless of path, and the one that doesn't
  // match aborts the raw socket — which can stomp on the other server's own request
  // even when its path does match. Routing upgrades ourselves avoids that entirely.
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (parse(req.url).pathname !== '/ws') return; // not ours — leave it for another handler
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    // Browsers can't set custom headers on a WebSocket handshake, so the bearer token
    // travels as a query param instead: wss://host/ws?token=<token>.
    const { query } = parse(req.url, true);
    const conn = resolveConnectionOrg(query.token);
    if (!conn) {
      try { ws.close(4001, 'Not authenticated'); } catch (_) {}
      return;
    }
    ws.orgId = conn.orgId;
    ws.isPlatformAdmin = conn.isPlatformAdmin;

    clientCount++;
    const ip = req.socket.remoteAddress;
    logger.debug(`WS client connected: ${ip} org=${ws.orgId} (total: ${clientCount})`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => {
      clientCount--;
      logger.debug(`WS client disconnected (total: ${clientCount})`);
      require('./audioRelay').handleBrowserDisconnect(ws);
    });

    ws.on('error', (err) => logger.warn(`WS client error: ${err.message}`));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // browsers never send us audio, only receive it
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }
      const audioRelay = require('./audioRelay');
      if (msg.type === 'listen_start') audioRelay.handleBrowserListen(ws, msg.channelId);
      else if (msg.type === 'listen_stop') audioRelay.handleBrowserUnlisten(ws, msg.channelId);
    });

    // Send welcome + current SDR status so the UI is correct immediately
    safeSend(ws, { type: 'connected', ts: new Date().toISOString() });
    const status = getSdrStatus();
    if (status) safeSend(ws, { type: 'sdr_status', status });
  });

  // Heartbeat to detect dead connections
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));
  logger.info('WebSocket server initialised on /ws');
}

// Instance-wide signals with no per-org content (sdr status, log lines, server shutdown,
// map-locations-cleared, location updates on an existing message) — every connection gets these.
function broadcast(payload) {
  if (!wss) return;
  const data = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) safeSend(ws, null, data);
  });
}

// Message content is org-specific (each org resolves aliases/groups and applies its own
// feed filter differently over the same shared ingest event — see services/fanout.js) —
// only that org's connections receive it.
function broadcastToOrg(orgId, payload) {
  if (!wss) return;
  const data = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws.orgId === orgId) safeSend(ws, null, data);
  });
}

function safeSend(ws, obj, raw) {
  try { ws.send(raw ?? JSON.stringify(obj)); } catch (_) {}
}

function getClientCount() { return clientCount; }

function closeWebSocket() {
  if (!wss) return;
  const msg = JSON.stringify({ type: 'server_shutdown' });
  wss.clients.forEach(ws => {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch (_) {}
    ws.terminate();
  });
  wss.close();
}

module.exports = { initWebSocket, broadcast, broadcastToOrg, getClientCount, closeWebSocket };

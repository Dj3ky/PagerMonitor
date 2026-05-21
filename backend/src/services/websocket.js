const { WebSocketServer, WebSocket } = require('ws');
const logger = require('../utils/logger');

let wss;
let clientCount = 0;

// Lazy reference to sdr service to avoid circular require at module load time
function getSdrStatus() {
  try { return require('./sdr').getStatus(); } catch (_) { return null; }
}

function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    clientCount++;
    const ip = req.socket.remoteAddress;
    logger.debug(`WS client connected: ${ip} (total: ${clientCount})`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => {
      clientCount--;
      logger.debug(`WS client disconnected (total: ${clientCount})`);
    });

    ws.on('error', (err) => logger.warn(`WS client error: ${err.message}`));

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

function broadcast(payload) {
  if (!wss) return;
  const data = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) safeSend(ws, null, data);
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

module.exports = { initWebSocket, broadcast, getClientCount, closeWebSocket };

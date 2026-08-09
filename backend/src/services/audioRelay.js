'use strict';

// Low-latency voice-channel audio relay — replaces the old Icecast/MP3 path.
//
// Local dongles (same box as the backend) call pushLocalFrame() directly for every
// UDP packet rtl_airband produces — cheap in-process fan-out, no signaling needed.
//
// Remote RPi clients connect outbound to this server's /ws/audio-source endpoint (same
// direction as their existing HTTP POSTs — never accepts inbound connections on the Pi)
// and only transmit a channel's audio while at least one browser is actually listening,
// to avoid burning WAN bandwidth on channels nobody's tuned into. rtl_airband itself keeps
// demodulating continuously on the Pi regardless (same as it always has) — only whether
// that already-flowing local audio gets forwarded onward to us is gated.
//
// Wire format for binary frames (both Pi→server and server→browser): a 4-byte little-
// endian channel id, followed by raw 32-bit float mono PCM samples at 16kHz (rtl_airband's
// native udp_stream format — no resampling needed anywhere in this path; the browser's
// AudioBuffer handles rate conversion to the output device natively).

const { WebSocketServer, WebSocket } = require('ws');
const { parse } = require('url');
const logger = require('../utils/logger');

const FRAME_HEADER_BYTES = 4;

let sourceWss = null;
const clientSockets   = new Map(); // clientId -> ws (Pi audio-source connections)
const listeners        = new Map(); // channelId -> Set<browserWs>
const forwardingActive = new Map(); // channelId -> boolean (have we told the remote client to stream?)

function resolveChannelOwner(channelId) {
  const { getDongleConfigs } = require('./config');
  const { getAllClientConfigs } = require('./clientTracker');
  const id = Number(channelId);

  const matches = (dongle) => dongle?.mode === 'airband' && Array.isArray(dongle.voiceChannelIds)
    && dongle.voiceChannelIds.map(Number).includes(id);

  const local = getDongleConfigs();
  if (Array.isArray(local) && local.some(matches)) return { type: 'local' };

  for (const { clientId, config } of getAllClientConfigs()) {
    const dongles = Array.isArray(config?.dongles) ? config.dongles : [config];
    if (dongles.some(matches)) return { type: 'remote', clientId };
  }
  return null;
}

function encodeFrame(channelId, payload) {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32LE(Number(channelId), 0);
  return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
  if (buf.length < FRAME_HEADER_BYTES) return null;
  return { channelId: buf.readUInt32LE(0), payload: buf.subarray(FRAME_HEADER_BYTES) };
}

// ── Fan-out to browsers currently listening to a channel ──────────────────────────────
function fanOutFrame(channelId, payload) {
  const set = listeners.get(Number(channelId));
  if (!set || set.size === 0) return;
  const frame = encodeFrame(channelId, payload);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(frame, { binary: true }); } catch (_) {} }
  }
}

// Called by sdr.js for every UDP packet from a locally-attached dongle's voice channel.
// No signaling needed — rtl_airband is already producing this locally regardless.
function pushLocalFrame(channelId, payload) {
  fanOutFrame(channelId, payload);
}

function sendControl(clientId, msg) {
  const ws = clientSockets.get(clientId);
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(msg)); } catch (_) {} }
}

function setRemoteForwarding(channelId, wantOn) {
  const owner = resolveChannelOwner(channelId);
  if (!owner || owner.type !== 'remote') return; // local channels need no signaling
  const cur = forwardingActive.get(channelId) || false;
  if (cur === wantOn) return;
  forwardingActive.set(channelId, wantOn);
  sendControl(owner.clientId, { type: wantOn ? 'start' : 'stop', channelId: Number(channelId) });
}

// ── Browser-side listen/unlisten (called from websocket.js's /ws handler) ─────────────
function handleBrowserListen(ws, channelId) {
  const id = Number(channelId);
  if (!Number.isFinite(id)) return;
  let set = listeners.get(id);
  if (!set) { set = new Set(); listeners.set(id, set); }
  const wasEmpty = set.size === 0;
  set.add(ws);
  (ws._listeningChannels || (ws._listeningChannels = new Set())).add(id);
  if (wasEmpty) setRemoteForwarding(id, true);
}

function handleBrowserUnlisten(ws, channelId) {
  const id = Number(channelId);
  const set = listeners.get(id);
  if (set) {
    set.delete(ws);
    if (set.size === 0) { listeners.delete(id); setRemoteForwarding(id, false); }
  }
  ws._listeningChannels?.delete(id);
}

function handleBrowserDisconnect(ws) {
  if (!ws._listeningChannels) return;
  for (const id of ws._listeningChannels) handleBrowserUnlisten(ws, id);
}

// ── RPi audio-source connections ───────────────────────────────────────────────────────
function initAudioSourceWs(server) {
  // noServer + manual upgrade routing — see the identical comment in websocket.js for why
  // { server, path } can't safely coexist with another WebSocketServer on the same server.
  sourceWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (parse(req.url).pathname !== '/ws/audio-source') return; // not ours
    sourceWss.handleUpgrade(req, socket, head, (ws) => sourceWss.emit('connection', ws, req));
  });

  sourceWss.on('connection', (ws, req) => {
    const { getSetting } = require('./database');
    const clientKey = getSetting('client_key', null);
    const providedKey = req.headers['x-client-key'] || '';
    const clientId     = req.headers['x-client-id'] || '';
    if (!clientKey || providedKey !== clientKey || !clientId) {
      try { ws.close(4001, 'Unauthorized'); } catch (_) {}
      return;
    }

    // Only one audio-source connection per client — replace any stale one.
    const existing = clientSockets.get(clientId);
    if (existing && existing !== ws) { try { existing.terminate(); } catch (_) {} }
    clientSockets.set(clientId, ws);
    logger.info(`Audio-source client connected: ${clientId}`);
    reconcileClientChannels(clientId);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return; // no control messages expected from the client on this socket
      const frame = decodeFrame(data);
      if (frame) fanOutFrame(frame.channelId, frame.payload);
    });

    ws.on('close', () => {
      if (clientSockets.get(clientId) === ws) clientSockets.delete(clientId);
      logger.info(`Audio-source client disconnected: ${clientId}`);
      // Any channel that was actively forwarding for this client needs re-arming on
      // reconnect — clear our "already told it to start" bookkeeping so the next
      // listener (or the same one still connected) re-triggers a fresh start signal.
      for (const [channelId, active] of forwardingActive) {
        if (active) {
          const owner = resolveChannelOwner(channelId);
          if (owner?.type === 'remote' && owner.clientId === clientId) forwardingActive.set(channelId, false);
        }
      }
    });
    ws.on('error', (err) => logger.warn(`Audio-source client error (${clientId}): ${err.message}`));
  });

  const heartbeat = setInterval(() => {
    sourceWss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);
  sourceWss.on('close', () => clearInterval(heartbeat));

  logger.info('Audio-source WebSocket server initialised on /ws/audio-source');
}

// Re-arm forwarding for any channel a reconnecting client should be actively streaming —
// call this once a client's audio-source socket is (re)established and at least one
// browser is already listening (e.g. server restarted mid-session).
function reconcileClientChannels(clientId) {
  for (const [channelId, set] of listeners) {
    if (set.size === 0) continue;
    const owner = resolveChannelOwner(channelId);
    if (owner?.type === 'remote' && owner.clientId === clientId) setRemoteForwarding(channelId, true);
  }
}

function isAudioConnected(clientId) {
  const ws = clientSockets.get(clientId);
  return !!(ws && ws.readyState === WebSocket.OPEN);
}

module.exports = {
  initAudioSourceWs,
  isAudioConnected,
  pushLocalFrame,
  handleBrowserListen,
  handleBrowserUnlisten,
  handleBrowserDisconnect,
  reconcileClientChannels,
};

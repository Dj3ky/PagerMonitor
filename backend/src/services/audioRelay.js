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
const clientSockets       = new Map(); // clientId -> ws (Pi audio-source connections)
const listeners            = new Map(); // channelId -> Set<browserWs>
const internalSubscribers  = new Map(); // channelId -> Set<callback(payload)> — e.g. discordRelay.js
const forwardingActive     = new Map(); // channelId -> boolean (have we told the remote client to stream?)
const logWatchers          = new Map(); // clientId -> Set<browserWs> — admins viewing that client's live logs
const logStreamActive      = new Map(); // clientId -> boolean (have we told the client to stream its logs?)
const channelActivity      = new Map(); // channelId -> boolean (currently-known "is someone talking" state)
const channelActivityHang  = new Map(); // channelId -> timer (debounce before flipping active -> inactive)

// Browsers + internal (non-WS) subscribers both count toward "does this channel need
// forwarding" — a channel stays armed as long as *either* wants it.
function totalSubscriberCount(channelId) {
  const id = Number(channelId);
  return (listeners.get(id)?.size || 0) + (internalSubscribers.get(id)?.size || 0);
}

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

// ── Fan-out to browsers + internal subscribers currently listening to a channel ───────
function fanOutFrame(channelId, payload) {
  const id = Number(channelId);
  const wsSet = listeners.get(id);
  if (wsSet && wsSet.size > 0) {
    const frame = encodeFrame(id, payload);
    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send(frame, { binary: true }); } catch (_) {} }
    }
  }
  const cbSet = internalSubscribers.get(id);
  if (cbSet && cbSet.size > 0) {
    for (const cb of cbSet) { try { cb(payload); } catch (_) {} }
  }
}

// Called by sdr.js for every UDP packet from a locally-attached dongle's voice channel.
// No signaling needed — rtl_airband is already producing this locally regardless.
function pushLocalFrame(channelId, payload) {
  fanOutFrame(channelId, payload);
}

// ── "Is someone talking" activity — separate from actually listening ──────────────────
// Broadcast to every browser (not just this channel's listeners), so the app can show a
// live indicator on channels nobody's currently tuned into, without streaming their full
// audio. HANG_MS keeps a channel "active" briefly after the last loud sample so normal
// gaps between words/syllables don't make the indicator flicker on and off.
const ACTIVITY_RMS_THRESHOLD = 0.02; // starting point — rtl_airband's float32 samples are ~[-1,1]; tune if too sensitive/insensitive
const ACTIVITY_HANG_MS = 800;

function computeRms(buf) {
  const n = buf.length >> 2;
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) { const v = buf.readFloatLE(i * 4); sumSq += v * v; }
  return Math.sqrt(sumSq / n);
}

function setChannelActive(channelId, active) {
  const id = Number(channelId);
  if ((channelActivity.get(id) || false) === active) return;
  channelActivity.set(id, active);
  const { broadcast } = require('./websocket');
  broadcast({ type: 'channel_activity', channelId: id, active });
}

// isLoud: whether *this particular sample* was above threshold — the hang-time debounce
// lives here so both local (per-buffer) and remote (already-debounced client-side) callers
// go through the same "flip on immediately, flip off after a quiet period" behavior.
function reportChannelActivity(channelId, isLoud) {
  const id = Number(channelId);
  if (isLoud) {
    clearTimeout(channelActivityHang.get(id));
    channelActivityHang.delete(id);
    setChannelActive(id, true);
  } else if (channelActivity.get(id) && !channelActivityHang.has(id)) {
    const t = setTimeout(() => { channelActivityHang.delete(id); setChannelActive(id, false); }, ACTIVITY_HANG_MS);
    channelActivityHang.set(id, t);
  }
}

// Called by sdr.js alongside pushLocalFrame, for every voice channel buffer regardless of
// listeners — cheap enough to run unconditionally (a handful of float reads per packet).
function reportLocalActivitySample(channelId, payload) {
  reportChannelActivity(channelId, computeRms(payload) > ACTIVITY_RMS_THRESHOLD);
}

// { channelId: true } for every channel currently known to be active — lets a freshly
// loaded page show correct state immediately instead of waiting for the next change.
function getActiveChannels() {
  const out = {};
  for (const [channelId, active] of channelActivity) if (active) out[channelId] = true;
  return out;
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

// ── Remote live-log viewing — reuses this same connection so no new port/protocol is
// needed: admins watch a specific client's own log() output in near-real-time without
// SSH, over the exact same outbound-only connection already used for audio. ────────────
function setLogStreaming(clientId, wantOn) {
  const cur = logStreamActive.get(clientId) || false;
  if (cur === wantOn) return;
  logStreamActive.set(clientId, wantOn);
  sendControl(clientId, { type: 'log_stream', on: wantOn });
}

function handleBrowserWatchClientLogs(ws, clientId) {
  if (!clientId) return;
  let set = logWatchers.get(clientId);
  if (!set) { set = new Set(); logWatchers.set(clientId, set); }
  const wasEmpty = set.size === 0;
  set.add(ws);
  (ws._watchingClientLogs || (ws._watchingClientLogs = new Set())).add(clientId);
  if (wasEmpty) setLogStreaming(clientId, true);
}

function handleBrowserUnwatchClientLogs(ws, clientId) {
  const set = logWatchers.get(clientId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) { logWatchers.delete(clientId); setLogStreaming(clientId, false); }
  }
  ws._watchingClientLogs?.delete(clientId);
}

function relayClientLog(clientId, level, msg, ts) {
  const set = logWatchers.get(clientId);
  if (!set || set.size === 0) return;
  const data = JSON.stringify({ type: 'client_log', clientId, level, msg, ts });
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(data); } catch (_) {} }
  }
}

// ── Browser-side listen/unlisten (called from websocket.js's /ws handler) ─────────────
function handleBrowserListen(ws, channelId) {
  const id = Number(channelId);
  if (!Number.isFinite(id)) return;
  const wasActive = totalSubscriberCount(id) > 0;
  let set = listeners.get(id);
  if (!set) { set = new Set(); listeners.set(id, set); }
  set.add(ws);
  (ws._listeningChannels || (ws._listeningChannels = new Set())).add(id);
  if (!wasActive) setRemoteForwarding(id, true);
}

function handleBrowserUnlisten(ws, channelId) {
  const id = Number(channelId);
  const set = listeners.get(id);
  if (set) {
    set.delete(ws);
    if (set.size === 0) listeners.delete(id);
  }
  ws._listeningChannels?.delete(id);
  if (totalSubscriberCount(id) === 0) setRemoteForwarding(id, false);
}

function handleBrowserDisconnect(ws) {
  if (ws._listeningChannels) for (const id of ws._listeningChannels) handleBrowserUnlisten(ws, id);
  if (ws._watchingClientLogs) for (const id of [...ws._watchingClientLogs]) handleBrowserUnwatchClientLogs(ws, id);
}

// ── Internal (non-WS) subscribers, e.g. discordRelay.js ────────────────────────────────
// callback receives the raw payload Buffer (no channel-id header — the caller already
// knows which channel it asked for). Returns an unsubscribe function.
function subscribeChannel(channelId, callback) {
  const id = Number(channelId);
  const wasActive = totalSubscriberCount(id) > 0;
  let set = internalSubscribers.get(id);
  if (!set) { set = new Set(); internalSubscribers.set(id, set); }
  set.add(callback);
  if (!wasActive) setRemoteForwarding(id, true);

  return () => {
    const s = internalSubscribers.get(id);
    if (s) { s.delete(callback); if (s.size === 0) internalSubscribers.delete(id); }
    if (totalSubscriberCount(id) === 0) setRemoteForwarding(id, false);
  };
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
    // Re-arm log streaming too if an admin is still watching this client's logs from
    // before it disconnected (mirrors reconcileClientChannels' reasoning below).
    if ((logWatchers.get(clientId)?.size || 0) > 0) setLogStreaming(clientId, true);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = decodeFrame(data);
        if (frame) fanOutFrame(frame.channelId, frame.payload);
        return;
      }
      // Only real, expected text message from a client right now: its own log lines,
      // while an admin has log streaming turned on for it (see setLogStreaming above).
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }
      if (msg.type === 'log') relayClientLog(clientId, msg.level, msg.msg, msg.ts);
      // Remote clients already debounce this themselves (see client/src/index.js) before
      // sending, so this is a plain on/off flip, not another round of hang-time logic.
      else if (msg.type === 'activity') setChannelActive(msg.channelId, !!msg.active);
    });

    ws.on('close', () => {
      if (clientSockets.get(clientId) === ws) clientSockets.delete(clientId);
      logger.info(`Audio-source client disconnected: ${clientId}`);
      logStreamActive.set(clientId, false); // re-arm on reconnect rather than assume it's still streaming
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
// browser/internal subscriber is already listening (e.g. server restarted mid-session).
function reconcileClientChannels(clientId) {
  const ids = new Set([...listeners.keys(), ...internalSubscribers.keys()]);
  for (const channelId of ids) {
    if (totalSubscriberCount(channelId) === 0) continue;
    const owner = resolveChannelOwner(channelId);
    if (owner?.type === 'remote' && owner.clientId === clientId) setRemoteForwarding(channelId, true);
  }
}

function isAudioConnected(clientId) {
  const ws = clientSockets.get(clientId);
  return !!(ws && ws.readyState === WebSocket.OPEN);
}

// { channelId: { count, usernames } } for every channel with at least one active listener.
// Anonymous/public-mode listeners have no username — labelled "guest" for display.
function getListenerCounts() {
  const out = {};
  for (const [channelId, set] of listeners) {
    if (set.size === 0) continue;
    out[channelId] = { count: set.size, usernames: [...set].map(ws => ws.username || 'guest') };
  }
  return out;
}

module.exports = {
  initAudioSourceWs,
  isAudioConnected,
  getListenerCounts,
  getActiveChannels,
  pushLocalFrame,
  reportLocalActivitySample,
  handleBrowserListen,
  handleBrowserUnlisten,
  handleBrowserDisconnect,
  handleBrowserWatchClientLogs,
  handleBrowserUnwatchClientLogs,
  subscribeChannel,
  reconcileClientChannels,
};

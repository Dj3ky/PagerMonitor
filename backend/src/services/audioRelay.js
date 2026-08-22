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
const allLogWatchers       = new Set(); // browserWs set — admins viewing the merged "all clients" log page
const clientLogBuffers     = new Map(); // clientId -> ring buffer of { ts, level, msg } — survives no watcher being open
const MAX_CLIENT_LOG_LINES = 300; // mirrors sdr.js's local-mode MAX_LOG_LINES
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
  if (Array.isArray(local)) {
    const dongle = local.find(matches);
    if (dongle) return { type: 'local', dongleLabel: dongle.label || null };
  }

  for (const { clientId, config } of getAllClientConfigs()) {
    const dongles = Array.isArray(config?.dongles) ? config.dongles : [config];
    const dongle = dongles.find(matches);
    if (dongle) return { type: 'remote', clientId, dongleLabel: dongle.label || null };
  }
  return null;
}

// A voice channel assigned to more than one dongle only ever gets forwarded from one of
// them (see resolveChannelOwner, which just picks the first match it finds) — every other
// dongle assigned the same channel decodes it for nothing, with no error surfaced anywhere.
// Used by the admin routes to block a save that would create this before it happens, rather
// than silently going quiet on one source. `self` identifies which source is being saved
// (so it's excluded from the "elsewhere" scan) — { type: 'local' } or { type: 'remote', clientId }.
function findVoiceChannelConflicts(candidateDongles, self) {
  const { getDongleConfigs } = require('./config');
  const { getAllClientConfigs } = require('./clientTracker');
  const isAirband = d => d?.mode === 'airband' && Array.isArray(d.voiceChannelIds);

  // channelId -> [{ type, clientId? }, ...] already using it, outside of what's being saved
  const existing = new Map();
  const addExisting = (id, owner) => {
    if (!existing.has(id)) existing.set(id, []);
    existing.get(id).push(owner);
  };

  if (self?.type !== 'local') {
    for (const d of (getDongleConfigs() || [])) {
      if (!isAirband(d)) continue;
      for (const id of d.voiceChannelIds.map(Number)) addExisting(id, { type: 'local' });
    }
  }
  for (const { clientId, config } of getAllClientConfigs()) {
    if (self?.type === 'remote' && self.clientId === clientId) continue;
    const dongles = Array.isArray(config?.dongles) ? config.dongles : [config];
    for (const d of dongles) {
      if (!isAirband(d)) continue;
      for (const id of d.voiceChannelIds.map(Number)) addExisting(id, { type: 'remote', clientId });
    }
  }

  // Count how many times each channel appears within the save itself too — two dongles on
  // the same box/client claiming the same channel is just as broken (UDP port collision for
  // local dongles) as a collision with some other source entirely.
  const countInCandidate = new Map();
  for (const d of (candidateDongles || [])) {
    if (!isAirband(d)) continue;
    for (const id of d.voiceChannelIds.map(Number)) {
      countInCandidate.set(id, (countInCandidate.get(id) || 0) + 1);
    }
  }

  const conflicts = [];
  for (const [id, count] of countInCandidate) {
    const owners = existing.get(id) || [];
    if (count > 1 || owners.length > 0) conflicts.push({ channelId: id, duplicatedHere: count > 1, owners });
  }
  return conflicts;
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

// Recent audio kept per channel regardless of listeners (mirrors client/src/index.js's own
// pre-roll for the remote-forwarding-not-yet-on case) — covers local dongles, which always
// flow frames here, and any remote channel that's already forwarding for an existing
// listener. Flushed to a browser the instant it joins so it doesn't lose the first word or
// two while activity detection + the listen_start round-trip catch up.
const PREROLL_MS = 500;
const preRollBuffers = new Map(); // channelId -> [{ t, payload }]

function recordPreRoll(channelId, payload) {
  const id = Number(channelId);
  let buf = preRollBuffers.get(id);
  if (!buf) { buf = []; preRollBuffers.set(id, buf); }
  const now = Date.now();
  buf.push({ t: now, payload });
  while (buf.length && now - buf[0].t > PREROLL_MS) buf.shift();
}

function flushPreRoll(channelId, ws) {
  const buf = preRollBuffers.get(Number(channelId));
  if (!buf || buf.length === 0) return;
  // recordPreRoll only trims on a new push — a channel that's gone quiet stops getting
  // trimmed at all, so re-check staleness here too rather than trusting whatever's still
  // sitting in the array from whenever it was last fed.
  const cutoff = Date.now() - PREROLL_MS;
  for (const { t, payload } of buf) {
    if (t < cutoff) continue;
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(encodeFrame(channelId, payload), { binary: true }); } catch (_) {} }
  }
}

// ── Fan-out to browsers + internal subscribers currently listening to a channel ───────
function fanOutFrame(channelId, payload) {
  const id = Number(channelId);
  recordPreRoll(id, payload);
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

// "Last heard" bookkeeping — a channel must stay continuously active (per channelActivity,
// which is already hang-debounced above) for this long before it counts as a real
// transmission, so a brief RF noise blip doesn't update the timestamp shown to admins.
const ACTIVITY_CONFIRM_MS = 2000;
const channelHeardAt      = new Map(); // channelId -> ms epoch of last confirmed transmission
const channelConfirmTimer = new Map(); // channelId -> pending "confirm as heard" timer while active but not yet confirmed

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

  clearTimeout(channelConfirmTimer.get(id));
  channelConfirmTimer.delete(id);
  if (active) {
    channelConfirmTimer.set(id, setTimeout(() => {
      channelConfirmTimer.delete(id);
      channelHeardAt.set(id, Date.now());
    }, ACTIVITY_CONFIRM_MS));
  }
}

/** { channelId: msEpoch } for every channel with at least one confirmed (>= ACTIVITY_CONFIRM_MS) transmission since server start. */
function getHeardTimestamps() {
  return Object.fromEntries(channelHeardAt);
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
// needed: admins watch a client's own log() output in near-real-time without SSH, over
// the exact same outbound-only connection already used for audio. Remote clients stream
// their log() calls unconditionally once connected (see client/src/index.js) — buffered
// here per client regardless of whether anyone's currently watching, so the merged
// "Client Logs" admin page can show history from before it was opened, the same way
// local SDR mode's log buffer works (sdr.js). ─────────────────────────────────────────
function handleBrowserWatchClientLogs(ws, clientId) {
  if (!clientId) return;
  let set = logWatchers.get(clientId);
  if (!set) { set = new Set(); logWatchers.set(clientId, set); }
  set.add(ws);
  (ws._watchingClientLogs || (ws._watchingClientLogs = new Set())).add(clientId);
}

function handleBrowserUnwatchClientLogs(ws, clientId) {
  const set = logWatchers.get(clientId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) logWatchers.delete(clientId);
  }
  ws._watchingClientLogs?.delete(clientId);
}

function handleBrowserWatchAllClientLogs(ws) {
  allLogWatchers.add(ws);
  ws._watchingAllClientLogs = true;
}

function handleBrowserUnwatchAllClientLogs(ws) {
  allLogWatchers.delete(ws);
  ws._watchingAllClientLogs = false;
}

function relayClientLog(clientId, level, msg, ts) {
  let buf = clientLogBuffers.get(clientId);
  if (!buf) { buf = []; clientLogBuffers.set(clientId, buf); }
  buf.push({ ts, level, msg });
  if (buf.length > MAX_CLIENT_LOG_LINES) buf.shift();

  const watchers = logWatchers.get(clientId);
  if ((!watchers || watchers.size === 0) && allLogWatchers.size === 0) return;
  const data = JSON.stringify({ type: 'client_log', clientId, level, msg, ts });
  if (watchers) for (const ws of watchers) { if (ws.readyState === WebSocket.OPEN) { try { ws.send(data); } catch (_) {} } }
  for (const ws of allLogWatchers) { if (ws.readyState === WebSocket.OPEN) { try { ws.send(data); } catch (_) {} } }
}

/** Buffered history for one client, oldest first. */
function getClientLogs(clientId) {
  return [...(clientLogBuffers.get(clientId) || [])];
}

/** Buffered history across every client, tagged with clientId, sorted oldest first. */
function getAllClientLogs() {
  const merged = [];
  for (const [clientId, buf] of clientLogBuffers) {
    for (const entry of buf) merged.push({ clientId, ...entry });
  }
  merged.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return merged;
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
  // Covers local channels (always have recent frames buffered) and any remote channel
  // that was already forwarding for another listener. A remote channel that was cold
  // (wasActive false) has nothing buffered here yet — client/src/index.js flushes its own
  // pre-roll once our 'start' below reaches it instead.
  flushPreRoll(id, ws);
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
  if (ws._watchingAllClientLogs) handleBrowserUnwatchAllClientLogs(ws);
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

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = decodeFrame(data);
        if (frame) fanOutFrame(frame.channelId, frame.payload);
        return;
      }
      // Only real, expected text message from a client right now: its own log lines,
      // which it streams unconditionally once connected (see client/src/index.js).
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
  getHeardTimestamps,
  resolveChannelOwner,
  pushLocalFrame,
  reportLocalActivitySample,
  handleBrowserListen,
  handleBrowserUnlisten,
  handleBrowserDisconnect,
  handleBrowserWatchClientLogs,
  handleBrowserUnwatchClientLogs,
  handleBrowserWatchAllClientLogs,
  handleBrowserUnwatchAllClientLogs,
  getClientLogs,
  getAllClientLogs,
  subscribeChannel,
  reconcileClientChannels,
  findVoiceChannelConflicts,
};

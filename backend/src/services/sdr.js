const { spawn }  = require('child_process');
const { PassThrough } = require('stream');
const iconv      = require('iconv-lite');
const { insertMessage, getKeywordAlerts, getSetting } = require('./database');
const { broadcast }          = require('./websocket');
const { resolveAlias }       = require('../utils/aliases');
const { sendNotifications }  = require('./notifications');
const { sendWebhooks }       = require('./webhooks');
const { recordMessage }      = require('./deadair');
const { sendUserEmailNotifications } = require('./emailNotifier');
const { sendPushPerUser }    = require('./webpush');
const { parseLocation, geocodeAddress } = require('../utils/parseLocation');
const { loadSdrConfigIntoEnv, getDedupConfig, getDongleConfigs } = require('./config');
const logger = require('../utils/logger');

// ── Regexes ───────────────────────────────────────────────────────────────────
const EOT_RE    = /<EOT>|<NUL>|<STX>|<ETX>|\x04/gi;
const POCSAG_RE = /^(POCSAG\d+):\s*Address:\s*(\d+)\s+Function:\s*(\d)\s+(?:Alpha|Numeric|Skyper):\s*(.*)/i;
const FLEX_RE   = /^FLEX:\s*(\d+)\s*\[(\d)\]\s+(\w+)\s+(.*)/i;

// ── Build CLI args from process.env ───────────────────────────────────────────
function buildRtlFmArgs() {
  const e = process.env;
  const args = [];
  (e.RTL_FM_FREQ || '152.240M').split(':').forEach(f => args.push('-f', f.trim()));
  args.push('-M', e.RTL_FM_MODULATION || 'fm');
  args.push('-s', e.RTL_FM_SAMPLE_RATE || '22050');
  args.push('-g', e.RTL_FM_GAIN || '40');
  args.push('-d', e.RTL_FM_DEVICE_INDEX || '0');
  if (e.RTL_FM_PPM && e.RTL_FM_PPM !== '0')         args.push('-p', e.RTL_FM_PPM);
  if (e.RTL_FM_SQUELCH && e.RTL_FM_SQUELCH !== '0') args.push('-l', e.RTL_FM_SQUELCH);
  if (e.RTL_FM_RESAMPLE_RATE)                        args.push('-r', e.RTL_FM_RESAMPLE_RATE);
  if (e.RTL_FM_LOWPASS) e.RTL_FM_LOWPASS.split(',').forEach(f => args.push('-E', f.trim()));
  if (e.RTL_FM_TUNER_BANDWIDTH)                      args.push('-T', e.RTL_FM_TUNER_BANDWIDTH);
  if (e.RTL_FM_DIRECT_SAMPLING)                      args.push('-D', e.RTL_FM_DIRECT_SAMPLING);
  if (e.RTL_FM_OFFSET_TUNING === '1')                args.push('-O');
  args.push('-');
  return args;
}

function buildMmonArgs() {
  const e = process.env;
  const args = [];
  (e.MULTIMON_PROTOCOLS || 'POCSAG512 POCSAG1200 POCSAG2400').split(/\s+/).forEach(p => args.push('-a', p));
  args.push('-t', e.MULTIMON_INPUT_FORMAT || 'raw');
  if (e.MULTIMON_VERBOSITY)               args.push('-v', e.MULTIMON_VERBOSITY);
  if (e.MULTIMON_QUIET === '1')           args.push('-q');
  if (e.MULTIMON_POCSAG_SPECIAL === '1') args.push('-s');
  if (e.MULTIMON_POCSAG_CHARSET)          args.push('-C', e.MULTIMON_POCSAG_CHARSET); // -C POCSAG charset e.g. ISO-8859-2
  args.push('-');
  return args;
}

// ── Dedup ─────────────────────────────────────────────────────────────────────
const dedupCache = new Map();
function isDuplicate(capcode, message) {
  const cfg = getDedupConfig();
  if (!cfg.enabled || !message) return false;
  const key  = `${capcode}|${message}`;
  const last = dedupCache.get(key);
  const now  = Date.now();
  if (last && (now - last) < cfg.windowSeconds * 1000) return true;
  dedupCache.set(key, now);
  if (dedupCache.size > 2000) {
    const cutoff = now - 300_000;
    for (const [k, v] of dedupCache) if (v < cutoff) dedupCache.delete(k);
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Process handles ───────────────────────────────────────────────────────────
// SINGLE dongle mode (legacy — when no dongle_configs stored)
let rtlProc      = null;
let mmonProc     = null;

// MULTI dongle mode — array of { rtl, mmon } per dongle
let donglePipelines = [];  // { rtlProc, mmonProc, cfg, label }

function isMultiDongle() {
  const d = getDongleConfigs();
  return Array.isArray(d) && d.length > 1;
}

function buildRtlFmArgsForDongle(dongle) {
  const e    = process.env;
  const args = [];
  const freq = dongle.freq || e.RTL_FM_FREQ || '152.240M';
  freq.split(':').forEach(f => args.push('-f', f.trim()));
  args.push('-M', dongle.modulation  || e.RTL_FM_MODULATION  || 'fm');
  args.push('-s', dongle.sampleRate  || e.RTL_FM_SAMPLE_RATE || '22050');
  args.push('-g', dongle.gain        || e.RTL_FM_GAIN        || '40');
  args.push('-d', String(dongle.device ?? 0));
  const ppm = dongle.ppm || e.RTL_FM_PPM;
  if (ppm && ppm !== '0') args.push('-p', ppm);
  const sql = dongle.squelch || e.RTL_FM_SQUELCH;
  if (sql && sql !== '0') args.push('-l', sql);
  if (e.RTL_FM_RESAMPLE_RATE)   args.push('-r', e.RTL_FM_RESAMPLE_RATE);
  args.push('-');
  return args;
}

function buildMmonArgsForDongle(dongle) {
  const e    = process.env;
  const args = [];
  const protocols = dongle.protocols || e.MULTIMON_PROTOCOLS || 'POCSAG1200';
  protocols.split(/\s+/).forEach(p => args.push('-a', p));
  args.push('-t', e.MULTIMON_INPUT_FORMAT || 'raw');
  if (e.MULTIMON_VERBOSITY)               args.push('-v', e.MULTIMON_VERBOSITY);
  if ((e.MULTIMON_QUIET || '1') === '1')  args.push('-q');
  if (e.MULTIMON_POCSAG_SPECIAL === '1')  args.push('-s');
  const charset = dongle.charset || e.MULTIMON_POCSAG_CHARSET;
  if (charset) args.push('-C', charset);
  args.push('-');
  return args;
}

// ── State ─────────────────────────────────────────────────────────────────────
let stopping         = false;   // true while we are intentionally tearing down
let restartTimer     = null;
let consecutiveFails = 0;
let isFirstStart     = true;
let generation       = 0;
let singleDongleWatchdog = null;
let logBuffer        = [];
const MAX_LOG_LINES  = 300;

const sdrStatus = {
  running: false, startedAt: null, restarts: 0,
  lastMessage: null, error: null, rtlArgs: [], mmonArgs: [],
  freq: '', protocols: [],
};

function getStatus() { return { ...sdrStatus }; }
function getLogs()   { return [...logBuffer]; }

function addLog(source, line) {
  const entry = { ts: new Date().toISOString(), source, line };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  broadcast({ type: 'log', ...entry });
}

// ── Kill only OUR child processes ─────────────────────────────────────────────
function killOwnProcesses() {
  clearInterval(singleDongleWatchdog); singleDongleWatchdog = null;
  try { if (rtlProc) rtlProc.stdout?.unpipe(); } catch (_) {}
  try { if (mmonProc) mmonProc.kill('SIGTERM'); } catch (_) {}
  try { if (rtlProc)  rtlProc.kill('SIGTERM'); } catch (_) {}
  rtlProc  = null;
  mmonProc = null;
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function startSdrPipeline() {
  if (stopping) return;

  killOwnProcesses();
  stopMultiDonglePipelines();
  const myGen = ++generation;

  if (isFirstStart) {
    logger.info('First start — waiting 3s for USB to settle…');
    await sleep(3000);
    isFirstStart = false;
  }

  loadSdrConfigIntoEnv();

  // ── Multi-dongle mode ─────────────────────────────────────────────────────
  const dongles = getDongleConfigs();
  if (Array.isArray(dongles) && dongles.length > 1) {
    logger.info(`Starting ${dongles.length} SDR dongles in parallel`);
    donglePipelines       = dongles.map((d, i) => spawnDonglePipeline(d, `[dongle-${d.device ?? i}]`, myGen));
    sdrStatus.running     = false;
    sdrStatus.startedAt   = new Date().toISOString();
    sdrStatus.error       = null;
    sdrStatus.freq        = dongles.map(d => d.freq).join(', ');
    sdrStatus.protocols   = dongles.map(d => d.protocols || process.env.MULTIMON_PROTOCOLS || '');
    sdrStatus.dongleCount = dongles.length;
    sdrStatus.dongleStatuses = donglePipelines.map(p => ({
      device: p.cfg.device, freq: p.cfg.freq, protocols: p.cfg.protocols, label: p.label,
      running: false, error: null, lastMessage: null,
    }));
    broadcast({ type: 'sdr_status', status: getStatus() });
    consecutiveFails = 0;
    return;
  }

  // Single dongle — clear multi-dongle state so the status bar switches back to the single-dot view
  sdrStatus.dongleCount    = 1;
  sdrStatus.dongleStatuses = null;

  // ── Single dongle mode (original) ─────────────────────────────────────────
  const rtlArgs  = buildRtlFmArgs();
  const mmonArgs = buildMmonArgs();
  logger.info(`rtl_fm ${rtlArgs.join(' ')}`);
  logger.info(`multimon-ng ${mmonArgs.join(' ')}`);

  try {
    rtlProc  = spawn('rtl_fm',      rtlArgs,  { stdio: ['ignore', 'pipe', 'pipe'] });
    mmonProc = spawn('multimon-ng', mmonArgs, { stdio: ['pipe',   'pipe', 'pipe'] });

    logger.info(`Spawned rtl_fm PID=${rtlProc.pid}  multimon-ng PID=${mmonProc.pid}`);

    const rtlTap = new PassThrough();
    let lastRtlMs = Date.now();
    rtlTap.on('data', () => {
      lastRtlMs = Date.now();
      if (!sdrStatus.running && myGen === generation) {
        sdrStatus.running = true;
        broadcast({ type: 'sdr_status', status: getStatus() });
      }
    });
    rtlTap.on('error', () => {});
    rtlProc.stdout.pipe(rtlTap);
    rtlTap.pipe(mmonProc.stdin);
    rtlProc.stdout.on('error', () => {});
    mmonProc.stdin.on('error',  () => {});
    singleDongleWatchdog = setInterval(() => {
      if (myGen !== generation) { clearInterval(singleDongleWatchdog); singleDongleWatchdog = null; return; }
      if (Date.now() - lastRtlMs > 20000) {
        clearInterval(singleDongleWatchdog); singleDongleWatchdog = null;
        addLog('system', 'rtl_fm watchdog: no audio data for 20s — restarting');
        sdrStatus.running = false;
        sdrStatus.error   = 'rtl_fm stalled';
        broadcast({ type: 'sdr_status', status: getStatus() });
        if (!stopping) scheduleRestart();
      }
    }, 10000);

    rtlProc.stderr.on('data', d => {
      d.toString().split('\n').forEach(l => { l = l.trim(); if (l) { logger.debug(`rtl_fm: ${l}`); addLog('rtl_fm', l); } });
    });
    mmonProc.stderr.on('data', d => {
      d.toString().split('\n').forEach(l => { l = l.trim(); if (l) { logger.debug(`mmon: ${l}`); addLog('mmon', l); } });
    });

    // Smart charset decode for Š Č Ž:
    // Try UTF-8 first. If it produces replacement chars (U+FFFD), the data is
    // Latin-1/ISO-8859-2 so we re-decode with iconv. Handles both multimon-ng builds.
    let lineBuffer = '';
    mmonProc.stdout.on('data', chunk => {
      let text = chunk.toString('utf8');
      if (text.includes('\uFFFD')) {
        text = iconv.decode(chunk, 'ISO-8859-2');
      }
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer  = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (t) { addLog('decode', t); handleLine(t); }
      }
    });

    rtlProc.on('error', err => {
      if (myGen !== generation) return;
      addLog('rtl_fm', `ERROR: ${err.message}`);
      sdrStatus.error = err.message;
      if (!stopping) scheduleRestart();
    });
    mmonProc.on('error', err => {
      if (myGen !== generation) return;
      addLog('mmon', `ERROR: ${err.message}`);
      sdrStatus.error = err.message;
      if (!stopping) scheduleRestart();
    });

    // exit handler — only restart if WE didn't cause the exit
    rtlProc.on('exit', (code, signal) => {
      if (myGen !== generation) return;
      addLog('rtl_fm', `exited (code=${code} signal=${signal})`);
      sdrStatus.running = false;
      if (!stopping) scheduleRestart();
    });
    mmonProc.on('exit', (code, signal) => {
      if (myGen !== generation) return;
      addLog('mmon', `exited (code=${code} signal=${signal})`);
      sdrStatus.running = false;
      if (!stopping) scheduleRestart();
    });

    sdrStatus.startedAt = new Date().toISOString();
    sdrStatus.error     = null;
    sdrStatus.rtlArgs   = rtlArgs;
    sdrStatus.mmonArgs  = mmonArgs;
    sdrStatus.freq      = process.env.RTL_FM_FREQ || '';
    sdrStatus.protocols = (process.env.MULTIMON_PROTOCOLS || '').split(/\s+/);
    consecutiveFails    = 0;
    logger.info('SDR pipeline spawned — waiting for audio data');

  } catch (err) {
    logger.error(`Failed to spawn: ${err.message}`);
    sdrStatus.error   = err.message;
    sdrStatus.running = false;
    addLog('system', `FATAL: ${err.message}`);
    if (!stopping) scheduleRestart();
  }
}

// ── Stop (intentional) ────────────────────────────────────────────────────────
function stopSdrPipeline() {
  stopping = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  killOwnProcesses();
  stopMultiDonglePipelines();
  sdrStatus.running = false;
  broadcast({ type: 'sdr_status', status: getStatus() });
  logger.info('SDR pipeline stopped');
  stopping = false;
}

// ── Restart (manual, from admin panel) ───────────────────────────────────────
async function restartSdrPipeline() {
  logger.info('Manual restart…');
  stopping = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  killOwnProcesses();
  sdrStatus.running = false;
  await sleep(1500);
  stopping = false;
  startSdrPipeline();
}

// ── Auto-restart after unexpected exit ────────────────────────────────────────
function scheduleRestart() {
  if (restartTimer || stopping) return;
  consecutiveFails++;
  // Exponential back-off: 5s, 10s, 20s, 40s … max 60s
  const delay = Math.min(5000 * Math.pow(2, consecutiveFails - 1), 60_000);
  sdrStatus.restarts++;
  broadcast({ type: 'sdr_status', status: getStatus() });
  logger.info(`Auto-restart in ${Math.round(delay / 1000)}s (attempt ${consecutiveFails})`);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    await startSdrPipeline();
  }, delay);
}

// ── Line parser ───────────────────────────────────────────────────────────────
function cleanMessage(raw) { return raw.replace(EOT_RE, '').trim(); }

// Thin wrapper so multi-dongle spawner can call the same handler
function parseLine(line) {
  // Returns parsed object or null — same logic as handleLine but without side effects
  const pm = POCSAG_RE.exec(line);
  if (pm) {
    const [, proto, capcode, funcStr, msgRaw] = pm;
    const protocol = proto.toUpperCase();
    return { protocol, baud: parseInt((protocol.match(/\d+/) || ['0'])[0], 10),
      capcode: capcode.trim(), funcbits: parseInt(funcStr, 10), message: cleanMessage(msgRaw), raw: line };
  }
  const fm = FLEX_RE.exec(line);
  if (fm) {
    const [, capcode, funcStr, , msgRaw] = fm;
    return { protocol: 'FLEX', baud: null, capcode: capcode.trim(),
      funcbits: parseInt(funcStr, 10), message: cleanMessage(msgRaw), raw: line };
  }
  return null;
}

// Alias so the multi-dongle spawner code compiles
const handleDecodedMessage = (msg) => handleLine(msg.raw || '');

function handleLine(line) {
  let parsed = null;

  const pm = POCSAG_RE.exec(line);
  if (pm) {
    const [, proto, capcode, funcStr, msgRaw] = pm;
    const protocol = proto.toUpperCase();
    const baud     = parseInt((protocol.match(/\d+/) || ['0'])[0], 10);
    parsed = { protocol, baud, capcode: capcode.trim(), funcbits: parseInt(funcStr, 10), message: cleanMessage(msgRaw) };
  }

  const fm = FLEX_RE.exec(line);
  if (fm && !parsed) {
    const [, capcode, funcStr, , msgRaw] = fm;
    parsed = { protocol: 'FLEX', baud: null, capcode: capcode.trim(), funcbits: parseInt(funcStr, 10), message: cleanMessage(msgRaw) };
  }

  if (!parsed) return;

  if (isDuplicate(parsed.capcode, parsed.message)) {
    addLog('system', `[dedup] ${parsed.capcode} "${parsed.message.substring(0, 40)}"`);
    return;
  }

  const aliasName  = resolveAlias(parsed.capcode);

  let aliasColor = null, aliasRowColor = null, aliasRowSound = null;
  let groupId = null, groupName = null, groupColor = null, groupRowColor = null, groupRowSound = null;
  let parentGroupName = null, parentGroupColor = null, parentGroupRowColor = null, parentGroupRowSound = null;
  try {
    const { getDb } = require('./database');
    const row = getDb().prepare(`
      SELECT a.name, a.color, a.row_color as arc, a.row_sound as ars,
             g.id as gid, g.name as gname, g.color as gcolor, g.row_color as grc, g.row_sound as grs,
             pg.name as pgname, pg.color as pgcolor, pg.row_color as pgrc, pg.row_sound as pgrs
      FROM aliases a
      LEFT JOIN groups g  ON g.id = a.group_id
      LEFT JOIN groups pg ON pg.id = g.parent_id
      WHERE a.capcode = ?
    `).get(parsed.capcode);
    if (row) {
      aliasColor = row.color; aliasRowColor = row.arc; aliasRowSound = row.ars;
      groupId = row.gid; groupName = row.gname; groupColor = row.gcolor; groupRowColor = row.grc; groupRowSound = row.grs;
      parentGroupName = row.pgname; parentGroupColor = row.pgcolor; parentGroupRowColor = row.pgrc; parentGroupRowSound = row.pgrs;
    }
  } catch (_) {}

  const timestamp = new Date().toISOString();
  const geocodeCountry = (getSetting('site_settings', {}).geocodeCountry || 'si');
  const location = parseLocation(parsed.message, geocodeCountry);
  const { lat, lng } = location;
  const msg = {
    timestamp, raw: line, ...parsed,
    lat, lng,
    alias:                    aliasName,
    alias_name:               aliasName,
    alias_color:              aliasColor,
    alias_row_color:          aliasRowColor,
    alias_row_sound:          aliasRowSound,
    group_id:                 groupId,
    group_name:               groupName,
    group_color:              groupColor,
    group_row_color:          groupRowColor,
    group_row_sound:          groupRowSound,
    parent_group_name:        parentGroupName,
    parent_group_color:       parentGroupColor,
    parent_group_row_color:   parentGroupRowColor,
    parent_group_row_sound:   parentGroupRowSound,
  };
  const id        = insertMessage(msg);
  const payload = { type: 'message', id, ...msg };

  broadcast(payload);
  recordMessage();
  sdrStatus.lastMessage = timestamp;

  // Check keyword alerts
  try {
    const alerts  = getKeywordAlerts().filter(a => a.enabled);
    const matched = alerts.filter(a => {
      try {
        const re = a.is_regex
          ? new RegExp(a.pattern, 'i')
          : new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        return re.test(msg.message || '') || re.test(msg.capcode || '');
      } catch { return false; }
    });
    if (matched.length) broadcast({ ...payload, type: 'keyword_alert', matchedAlerts: matched });
  } catch (_) {}

  // Geocode address first if no explicit coords, so notifications include a map link
  ;(async () => {
    let notifyPayload = payload;
    if (!lat) {
      const result = await geocodeAddress(location.candidates || [], geocodeCountry, parsed.message).catch(() => null);
      if (result) {
        try { require('./database').getDb().prepare('UPDATE messages SET lat=?, lng=? WHERE id=?').run(result.lat, result.lng, id); } catch (_) {}
        broadcast({ type: 'message_location', id, lat: result.lat, lng: result.lng });
        notifyPayload = { ...payload, lat: result.lat, lng: result.lng };
      }
    }
    sendNotifications(notifyPayload).catch(e => logger.warn(`Notification: ${e.message}`));
    sendWebhooks(notifyPayload).catch(() => {});
    sendUserEmailNotifications(notifyPayload).catch(() => {});
    sendPushPerUser(notifyPayload).catch(() => {});
  })();

  logger.info(`[${msg.protocol}] ${msg.capcode} (${aliasName || 'unknown'}): ${msg.message.substring(0, 80)}`);
}

// ── Multi-dongle pipeline spawner ─────────────────────────────────────────────
function spawnDonglePipeline(dongle, label, myGen) {
  const rtlArgs  = buildRtlFmArgsForDongle(dongle);
  const mmonArgs = buildMmonArgsForDongle(dongle);
  logger.info(`${label} Starting: device=${dongle.device} freq=${dongle.freq || process.env.RTL_FM_FREQ}`);

  const state = { running: false, error: null, restarts: 0, lastMessage: null };

  const rtl  = spawn('rtl_fm',      rtlArgs,  { stdio: ['ignore', 'pipe', 'pipe'] });
  const mmon = spawn('multimon-ng', mmonArgs, { stdio: ['pipe',   'pipe', 'pipe'] });
  const tap = new PassThrough();
  let lastRtlMs = Date.now();
  tap.on('data', () => {
    lastRtlMs = Date.now();
    if (!state.running && myGen === generation) {
      state.running = true;
      broadcastDongleStatus();
    }
  });
  tap.on('error', () => {});
  rtl.stdout.pipe(tap);
  tap.pipe(mmon.stdin);
  rtl.stdout.on('error', () => {});
  mmon.stdin.on('error',  () => {});
  const watchdog = setInterval(() => {
    if (myGen !== generation) { clearInterval(watchdog); return; }
    if (Date.now() - lastRtlMs > 20000) {
      clearInterval(watchdog);
      logger.warn(`${label} watchdog: no audio data for 20s — restarting`);
      if (!stopping) onFail('watchdog', 'rtl_fm stalled');
    }
  }, 10000);

  rtl.stderr.on('data',  d => d.toString().split('\n').forEach(l => { if (l.trim()) addLog('rtl_fm',  `${label} ${l.trim()}`); }));
  mmon.stderr.on('data', d => d.toString().split('\n').forEach(l => { if (l.trim()) addLog('mmon',    `${label} ${l.trim()}`); }));

  let buf = '';
  mmon.stdout.on('data', chunk => {
    let text = chunk.toString('utf8');
    if (text.includes('\uFFFD')) text = iconv.decode(chunk, 'ISO-8859-2');
    buf += text;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim(); if (!t) continue;
      const msg = parseLine(t); if (!msg) continue;
      state.lastMessage = new Date().toISOString();
      logger.info(`${label} [${msg.protocol}] ${msg.capcode}: ${msg.message.substring(0,60)}`);
      handleDecodedMessage(msg);
    }
  });

  const otherPipelinesAlive = () => donglePipelines.some(p => p.state !== state && p.rtlProc && p.rtlProc.exitCode === null);

  let perDongleTimer = null;
  const schedulePerDongleRestart = () => {
    if (perDongleTimer || stopping || myGen !== generation) return;
    // 5s fixed retry — acts as a poll for "is the dongle now connected?"
    perDongleTimer = setTimeout(() => {
      perDongleTimer = null;
      if (stopping || myGen !== generation) return;
      const idx = donglePipelines.findIndex(p => p.state === state);
      if (idx === -1) return;
      logger.info(`${label} Retrying dongle…`);
      donglePipelines[idx] = spawnDonglePipeline(dongle, label, myGen);
      broadcastDongleStatus();
    }, 5000);
  };

  const onFail = (src, err) => {
    state.running = false;
    state.error   = err;
    broadcastDongleStatus();
    if (otherPipelinesAlive()) schedulePerDongleRestart();
    else scheduleRestart();
  };

  const onExit = (src) => (c, s) => {
    if (myGen !== generation) return;
    logger.info(`${label} ${src} exited (${c}/${s})`);
    if (!stopping) onFail(src, `${src} exited (${c}/${s})`);
  };
  rtl.on('exit',  onExit('rtl_fm'));
  mmon.on('exit', onExit('multimon-ng'));
  rtl.on('error',  e => { if (myGen !== generation) return; logger.error(`${label} rtl_fm: ${e.message}`);  if (!stopping) onFail('rtl_fm',  e.message); });
  mmon.on('error', e => { if (myGen !== generation) return; logger.error(`${label} mmon: ${e.message}`);     if (!stopping) onFail('mmon',    e.message); });

  return { rtlProc: rtl, mmonProc: mmon, cfg: dongle, label, state, watchdog };
}

function broadcastDongleStatus() {
  const dongles = donglePipelines.map(p => ({
    device:      p.cfg.device,
    freq:        p.cfg.freq,
    label:       p.label,
    running:     p.state.running,
    error:       p.state.error,
    lastMessage: p.state.lastMessage,
  }));
  const allOk = dongles.every(d => d.running);
  sdrStatus.dongleStatuses = dongles;
  sdrStatus.running = allOk || dongles.some(d => d.running); // overall: running if any is up
  broadcast({ type: 'sdr_status', status: getStatus() });
}

function stopMultiDonglePipelines() {
  for (const p of donglePipelines) {
    try { clearInterval(p.watchdog); } catch (_) {}
    try { if (p.rtlProc) p.rtlProc.stdout?.unpipe(); } catch (_) {}
    try { p.mmonProc?.kill('SIGTERM'); } catch (_) {}
    try { p.rtlProc?.kill('SIGTERM'); } catch (_) {}
  }
  donglePipelines = [];
}

module.exports = { startSdrPipeline, stopSdrPipeline, restartSdrPipeline, getStatus, getLogs };

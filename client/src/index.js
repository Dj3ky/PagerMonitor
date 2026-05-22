'use strict';

const { spawn }       = require('child_process');
const { PassThrough } = require('stream');
const iconv           = require('iconv-lite');
const http      = require('http');
const https     = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER_URL = (process.env.SERVER_URL || 'http://192.168.1.100:3000').replace(/\/$/, '');
const CLIENT_KEY = process.env.CLIENT_KEY  || '';
const CLIENT_ID  = process.env.CLIENT_ID   || 'rpi-1';

/**
 * Multi-dongle support via DONGLES env var (JSON array).
 * Each entry overrides the global defaults for that dongle.
 *
 * Example .env for 2 dongles:
 *   DONGLES=[{"device":0,"freq":"173.250M","gain":"40"},{"device":1,"freq":"152.240M","gain":"35","protocols":"POCSAG512 FLEX"}]
 *
 * If DONGLES is not set, falls back to single-dongle mode using the legacy env vars.
 */
function buildDongleConfigs() {
  const global = {
    freq:       process.env.RTL_FM_FREQ                || '173.250M',
    gain:       process.env.RTL_FM_GAIN                || '40',
    ppm:        process.env.RTL_FM_PPM                 || '0',
    squelch:    process.env.RTL_FM_SQUELCH             || '0',
    modulation: process.env.RTL_FM_MODULATION          || 'fm',
    sampleRate: process.env.RTL_FM_SAMPLE_RATE         || '22050',
    protocols:  process.env.MULTIMON_PROTOCOLS         || 'POCSAG1200',
    quiet:      process.env.MULTIMON_QUIET             || '1',
    charset:    process.env.MULTIMON_POCSAG_CHARSET    || '',
  };

  if (process.env.DONGLES) {
    try {
      const arr = JSON.parse(process.env.DONGLES);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map((d, i) => ({
          ...global,
          device: String(i),   // default device index = position in array
          ...d,                 // override with per-dongle settings
          device: String(d.device ?? i),
        }));
      }
    } catch (e) {
      log('warn', `Failed to parse DONGLES env: ${e.message} — falling back to single dongle`);
    }
  }

  // Single dongle fallback
  return [{ ...global, device: process.env.RTL_FM_DEVICE_INDEX || '0' }];
}

// ── Logging ───────────────────────────────────────────────────────────────────
function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
}

// ── CLI arg builders ──────────────────────────────────────────────────────────
function buildRtlArgs(cfg) {
  const args = [];
  cfg.freq.split(':').forEach(f => args.push('-f', f.trim()));
  args.push('-M', cfg.modulation);
  args.push('-s', cfg.sampleRate);
  args.push('-g', cfg.gain);
  args.push('-d', cfg.device);
  if (cfg.ppm     && cfg.ppm     !== '0') args.push('-p', cfg.ppm);
  if (cfg.squelch && cfg.squelch !== '0') args.push('-l', cfg.squelch);
  args.push('-');
  return args;
}

function buildMmonArgs(cfg) {
  const args = [];
  cfg.protocols.split(/\s+/).forEach(p => args.push('-a', p));
  args.push('-t', 'raw');
  if (cfg.quiet   === '1') args.push('-q');
  if (cfg.charset) args.push('-C', cfg.charset);
  args.push('-');
  return args;
}

// ── POCSAG/FLEX parser ────────────────────────────────────────────────────────
const EOT_RE    = /<EOT>|<NUL>|<STX>|<ETX>|\x04/gi;
const POCSAG_RE = /^(POCSAG\d+):\s*Address:\s*(\d+)\s+Function:\s*(\d)\s+(?:Alpha|Numeric|Skyper):\s*(.*)/i;
const FLEX_RE   = /^FLEX:\s*(\d+)\[(\d)\]\s+(\w+)\s+(.*)/i;

function parseLine(line) {
  const pm = POCSAG_RE.exec(line);
  if (pm) {
    const [, proto, capcode, funcStr, msgRaw] = pm;
    const protocol = proto.toUpperCase();
    return {
      protocol, baud: parseInt((protocol.match(/\d+/) || ['0'])[0], 10),
      capcode: capcode.trim(), funcbits: parseInt(funcStr, 10),
      message: msgRaw.replace(EOT_RE, '').trim(), raw: line,
    };
  }
  const fm = FLEX_RE.exec(line);
  if (fm) {
    const [, capcode, funcStr, , msgRaw] = fm;
    return {
      protocol: 'FLEX', baud: null,
      capcode: capcode.trim(), funcbits: parseInt(funcStr, 10),
      message: msgRaw.replace(EOT_RE, '').trim(), raw: line,
    };
  }
  return null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(`${SERVER_URL}${path}`);
    const lib  = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type':  'application/json',
      'X-Client-Key':  CLIENT_KEY,
      'X-Client-Id':   CLIENT_ID,
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method, headers,
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function sendToServer(msg, cfg) {
  httpRequest('POST', '/client/message', {
    ...msg,
    clientId:  CLIENT_ID,
    freq:      cfg.freq,
    protocols: cfg.protocols,
    timestamp: new Date().toISOString(),
  }).then(r => {
    if (r.status !== 200) log('warn', `Server returned ${r.status} for ${msg.capcode}`);
  }).catch(err => log('warn', `Send failed: ${err.message}`));
}

// ── Remote config polling ─────────────────────────────────────────────────────
let globalConfigVersion = null;
let globalOverrideCfg   = null; // remote config overlay (applies to all dongles)

async function pollConfig(pipelines) {
  try {
    const freqs      = pipelines.map(p => p.getCfg().freq).join(':');
    const protocols  = [...new Set(pipelines.map(p => p.getCfg().protocols))].join(' ');
    const sdrRunning = pipelines.every(p => p.isRunning());
    const r = await httpRequest('GET', `/client/config?freq=${encodeURIComponent(freqs)}&protocols=${encodeURIComponent(protocols)}&sdrRunning=${sdrRunning}`);
    if (r.status !== 200 || !r.body?.config) return;
    const { config, version } = r.body;
    if (!config || version === globalConfigVersion) return;

    log('info', `Remote config updated (v${version}) — applying to all dongles`);
    globalOverrideCfg   = config;
    globalConfigVersion = version;

    // Restart all pipelines with merged config
    for (const p of pipelines) p.applyRemoteConfig(config);
  } catch (e) {
    log('debug', `Config poll failed: ${e.message}`);
  }
}

// ── Single dongle pipeline ────────────────────────────────────────────────────
function createPipeline(baseCfg, index) {
  let cfg      = { ...baseCfg };
  let rtlProc  = null;
  let mmonProc = null;
  let stopping = false;
  let restartTimer    = null;
  let consecutiveFails = 0;
  let generation = 0;
  let watchdogTimer   = null;
  let pipelineRunning = false;
  const label = `[dongle-${cfg.device}]`;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function kill() {
    pipelineRunning = false;
    clearInterval(watchdogTimer); watchdogTimer = null;
    try { if (rtlProc) rtlProc.stdout?.unpipe(); } catch (_) {}
    try { if (mmonProc) mmonProc.kill('SIGTERM'); } catch (_) {}
    try { if (rtlProc)  rtlProc.kill('SIGTERM'); } catch (_) {}
    rtlProc = null; mmonProc = null;
  }

  async function start() {
    if (stopping) return;
    kill();
    const myGen = ++generation;

    log('info', `${label} Waiting 3s before starting...`);
    await sleep(3000);
    if (stopping || myGen !== generation) return;

    const rtlArgs  = buildRtlArgs(cfg);
    const mmonArgs = buildMmonArgs(cfg);
    log('info', `${label} rtl_fm -d ${cfg.device} -f ${cfg.freq} → multimon-ng ${cfg.protocols}`);

    try {
      rtlProc  = spawn('rtl_fm',      rtlArgs,  { stdio: ['ignore', 'pipe', 'pipe'] });
      mmonProc = spawn('multimon-ng', mmonArgs, { stdio: ['pipe',   'pipe', 'pipe'] });

      const tap = new PassThrough();
      let lastRtlMs = Date.now();
      tap.on('data', () => {
        lastRtlMs = Date.now();
        if (!pipelineRunning) pipelineRunning = true;
      });
      tap.on('error', () => {});
      rtlProc.stdout.pipe(tap);
      tap.pipe(mmonProc.stdin);
      rtlProc.stdout.on('error', () => {});
      mmonProc.stdin.on('error',  () => {});
      watchdogTimer = setInterval(() => {
        if (stopping || myGen !== generation) { clearInterval(watchdogTimer); watchdogTimer = null; return; }
        if (Date.now() - lastRtlMs > 20000) {
          clearInterval(watchdogTimer); watchdogTimer = null;
          log('warn', `${label} rtl_fm watchdog: no audio data for 20s — restarting`);
          if (!stopping) scheduleRestart();
        }
      }, 10000);

      rtlProc.stderr.on('data', d =>
        d.toString().split('\n').forEach(l => { if (l.trim()) log('debug', `${label} rtl_fm: ${l.trim()}`); })
      );
      mmonProc.stderr.on('data', d =>
        d.toString().split('\n').forEach(l => { if (l.trim()) log('debug', `${label} mmon: ${l.trim()}`); })
      );

      let lineBuffer = '';
      mmonProc.stdout.on('data', chunk => {
        let text = chunk.toString('utf8');
        if (text.includes('\uFFFD')) text = iconv.decode(chunk, 'ISO-8859-2');
        lineBuffer += text;
        const lines = lineBuffer.split('\n');
        lineBuffer  = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          const msg = parseLine(t);
          if (msg) {
            log('info', `${label} [${msg.protocol}] ${msg.capcode}: ${msg.message.substring(0, 60)}`);
            sendToServer(msg, cfg);
          }
        }
      });

      const onExit = (src) => (code, sig) => {
        if (myGen !== generation) return;
        log('info', `${label} ${src} exited (${code}/${sig})`);
        pipelineRunning = false;
        if (!stopping) scheduleRestart();
      };
      rtlProc.on('exit',  onExit('rtl_fm'));
      mmonProc.on('exit', onExit('multimon-ng'));
      rtlProc.on('error',  e => { if (myGen !== generation) return; log('error', `${label} rtl_fm error: ${e.message}`);  pipelineRunning = false; if (!stopping) scheduleRestart(); });
      mmonProc.on('error', e => { if (myGen !== generation) return; log('error', `${label} mmon error: ${e.message}`);     pipelineRunning = false; if (!stopping) scheduleRestart(); });

      consecutiveFails = 0;
      log('info', `${label} Pipeline spawned — waiting for audio data`);
    } catch (e) {
      log('error', `${label} Spawn failed: ${e.message}`);
      if (!stopping) scheduleRestart();
    }
  }

  function scheduleRestart() {
    if (restartTimer || stopping) return;
    consecutiveFails++;
    const delay = Math.min(5000 * Math.pow(2, consecutiveFails - 1), 60_000);
    log('info', `${label} Restart in ${Math.round(delay / 1000)}s (attempt ${consecutiveFails})`);
    restartTimer = setTimeout(() => { restartTimer = null; start(); }, delay);
  }

  function applyRemoteConfig(remote) {
    // Rebuild from baseCfg so cleared remote fields revert to .env defaults
    const newCfg = { ...baseCfg };
    for (const [k, v] of Object.entries(remote)) {
      if (v !== '' && v != null) newCfg[k] = v;
    }
    const changed = Object.keys(newCfg).some(k => newCfg[k] !== cfg[k]);
    if (!changed) return;
    log('info', `${label} Applying remote config — restarting`);
    Object.assign(cfg, newCfg);
    clearTimeout(restartTimer);
    restartTimer = null;
    start();
  }

  function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    kill();
  }

  return { start, stop, applyRemoteConfig, getCfg: () => ({ ...cfg }), isRunning: () => pipelineRunning, label };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const dongleConfigs = buildDongleConfigs();
log('info', `PagerMonitor Client — ID: ${CLIENT_ID}`);
log('info', `Server: ${SERVER_URL}`);
log('info', `Dongles: ${dongleConfigs.length}`);
dongleConfigs.forEach((c, i) => log('info', `  [${i}] device=${c.device} freq=${c.freq} protocols=${c.protocols}`));

// Create and start a pipeline per dongle
const pipelines = dongleConfigs.map((cfg, i) => createPipeline(cfg, i));
pipelines.forEach(p => p.start());

// Config polling — applies to all pipelines
let configTimer = null;
async function startConfigPolling() {
  await pollConfig(pipelines);  // poll once on start after 10s
  configTimer = setInterval(() => pollConfig(pipelines), 60_000);
  log('info', 'Remote config polling started (every 60s)');
}
setTimeout(startConfigPolling, 10_000);

// Graceful shutdown
const shutdown = () => {
  log('info', 'Shutting down...');
  clearInterval(configTimer);
  pipelines.forEach(p => p.stop());
  // Notify server we're offline so it doesn't wait for the threshold to expire
  httpRequest('POST', '/client/offline', {})
    .catch(() => {})
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000); // safety exit if request hangs
};
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

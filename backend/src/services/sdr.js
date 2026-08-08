const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const dgram = require('dgram');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const iconv      = require('iconv-lite');
const { insertMessage, getSetting, normCapcode, getVoiceChannelById } = require('./database');
const { broadcast }          = require('./websocket');
const { broadcastAll, notifyAll } = require('./fanout');
const { recordMessage, registerSource, unregisterSource } = require('./deadair');
const { parseLocation, geocodeAddress } = require('../utils/parseLocation');
const { loadSdrConfigIntoEnv, getDedupConfig, getDongleConfigs, getMessageNormalizations } = require('./config');
const logger = require('../utils/logger');

// ── Regexes ───────────────────────────────────────────────────────────────────
const EOT_RE      = /<EOT>|<NUL>|<STX>|<ETX>|\x04/gi;
const POCSAG_RE   = /^(POCSAG\d+):\s*Address:\s*(\d+)\s+Function:\s*(\d)\s+(?:Alpha|Numeric|Skyper):\s*(.*)/i;
// multimon-ng ≤ 1.x  →  "FLEX: 12345 [3] ALN message"
const FLEX_RE_OLD = /^FLEX:\s*(\d+)\s*\[(\d)\]\s+(\w+)\s+(.*)/i;
// multimon-ng ≥ 2.x  →  "FLEX|date|baud/lvl/pol/phase|cyc.frame|capcode|type|message"
const FLEX_RE_NEW = /^FLEX\|[^|]+\|[^|]+\|[^|]+\|(\d+)\|(\w+)\|(.*)/i;
// Map FLEX message-type letters → funcbits number (same scheme as old [N])
const FLEX_TYPE_FUNC = { TON: 0, NUM: 1, SKY: 2, ALN: 3 };

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
  if (e.MULTIMON_POCSAG_CHARSET)          args.push('-C', e.MULTIMON_POCSAG_CHARSET); // -C POCSAG charset: US, FR, DE, SE, DK, SI
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
  args.push('-M', dongle.modulation     || e.RTL_FM_MODULATION     || 'fm');
  args.push('-s', dongle.sampleRate     || e.RTL_FM_SAMPLE_RATE    || '22050');
  args.push('-g', dongle.gain           || e.RTL_FM_GAIN           || '40');
  args.push('-d', String(dongle.device ?? 0));
  const ppm = dongle.ppm || e.RTL_FM_PPM;
  if (ppm && ppm !== '0') args.push('-p', ppm);
  const sql = dongle.squelch || e.RTL_FM_SQUELCH;
  if (sql && sql !== '0') args.push('-l', sql);
  const resample = dongle.resampleRate || e.RTL_FM_RESAMPLE_RATE;
  if (resample) args.push('-r', resample);
  const lowpass = dongle.lowpass || e.RTL_FM_LOWPASS;
  if (lowpass) args.push('-E', lowpass);
  const tbw = dongle.tunerBandwidth || e.RTL_FM_TUNER_BANDWIDTH;
  if (tbw) args.push('-T', tbw);
  const ds = dongle.directSampling || e.RTL_FM_DIRECT_SAMPLING;
  if (ds && ds !== '0') args.push('-D', ds);
  const ot = dongle.offsetTuning || e.RTL_FM_OFFSET_TUNING;
  if (ot && ot !== '0') args.push('-O', ot);
  args.push('-');
  return args;
}

function buildMmonArgsForDongle(dongle) {
  const e    = process.env;
  const args = [];
  const protocols = dongle.protocols || e.MULTIMON_PROTOCOLS || 'POCSAG1200';
  protocols.split(/\s+/).forEach(p => args.push('-a', p));
  args.push('-t', dongle.inputFormat || e.MULTIMON_INPUT_FORMAT || 'raw');
  const verbosity = dongle.verbosity || e.MULTIMON_VERBOSITY;
  if (verbosity) args.push('-v', verbosity);
  const quiet = dongle.quiet != null ? dongle.quiet : (e.MULTIMON_QUIET || '1');
  if (quiet === '1') args.push('-q');
  const special = dongle.pocsagSpecial || e.MULTIMON_POCSAG_SPECIAL;
  if (special === '1') args.push('-s');
  const charset = dongle.charset || e.MULTIMON_POCSAG_CHARSET;
  if (charset) args.push('-C', charset);
  args.push('-');
  return args;
}

// ── rtl_airband (multi-channel: POCSAG + voice, one dongle) ───────────────────
// Only used by multi-dongle entries with mode:'airband'. Plain rtl_fm dongles (mode:'single',
// the default) are completely untouched by any of this.
function parseFreqHz(freq) {
  const m = /^([\d.]+)\s*([kMG])?$/i.exec(String(freq).trim());
  if (!m) return NaN;
  const mult = { k: 1e3, m: 1e6, g: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

// rtl_airband's udp_stream output always sends mono 32-bit float samples at a fixed rate
// (16000Hz with NFM support, confirmed via the project's wiki — not configurable), but
// multimon-ng's raw stdin input assumes 16-bit signed PCM at 22050Hz (same assumption the
// existing rtl_fm path already relies on via `-s 22050`). Converts + resamples (simple
// streaming linear interpolation — plenty for POCSAG's low baud rate) between UDP packets.
const AIRBAND_UDP_SAMPLE_RATE = 16000;
const MULTIMON_SAMPLE_RATE    = 22050;
function createFloatToInt16Resampler(srcRate, dstRate) {
  const ratio = srcRate / dstRate;
  let carry = new Float32Array(0);
  let phase = 0;
  return function process(floatBuf) {
    const nNew = floatBuf.length >> 2;
    if (nNew === 0) return Buffer.alloc(0);
    const combined = new Float32Array(carry.length + nNew);
    combined.set(carry, 0);
    for (let i = 0; i < nNew; i++) combined[carry.length + i] = floatBuf.readFloatLE(i * 4);

    const out = [];
    let pos = phase;
    while (Math.floor(pos) + 1 < combined.length) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      out.push(combined[i0] + (combined[i0 + 1] - combined[i0]) * frac);
      pos += ratio;
    }
    const consumed = Math.floor(pos);
    carry = combined.slice(consumed);
    phase = pos - consumed;

    const outBuf = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      const v = Math.max(-1, Math.min(1, out[i]));
      outBuf.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    return outBuf;
  };
}

// rtl_airband's "file" output turned out to be disk-archiving only (rotating, MP3-encoded
// filenames — confirmed by real log output, not a raw stream at all), so the POCSAG leg
// uses "udp_stream" instead: raw audio over a loopback UDP socket we bind and read directly.
// Deterministic per-device port, well above the ephemeral range, to avoid collisions.
function udpPortForDongle(device) {
  return 18000 + Number(device ?? 0);
}

// NOTE: RTLSDR-Airband uses libconfig syntax, NOT TOML (confirmed via a real "syntax
// error" on line 1 when this was first written as TOML — libconfig++ is one of its
// actual build dependencies). Exact field names/types are still best-effort; watch
// this dongle's log output after any config-generation change here.
function buildAirbandConfig(dongle, voiceChannels, udpPort) {
  const e = process.env;
  const pocsagHz = parseFreqHz(dongle.freq || e.RTL_FM_FREQ || '173.250M');
  const voiceHz  = voiceChannels.map(c => parseFreqHz(c.freq));
  const allHz    = [pocsagHz, ...voiceHz];

  // A frequency string missing its k/M/G suffix (e.g. "173.4875" instead of "173.4875M")
  // parses as a near-zero Hz value and silently wrecks the center-frequency math below —
  // catch it loudly here instead of producing a nonsense capture window.
  const tooLow = [{ label: 'POCSAG', hz: pocsagHz }, ...voiceChannels.map((c, i) => ({ label: c.description || `voice channel #${i}`, hz: voiceHz[i] }))]
    .filter(x => x.hz < 1_000_000);
  if (tooLow.length) {
    logger.warn(`airband dongle ${dongle.device}: suspiciously low frequency (missing M suffix?) for: ${tooLow.map(x => `${x.label}=${x.hz}Hz`).join(', ')}`);
  }

  const minHz = Math.min(...allHz), maxHz = Math.max(...allHz);
  const span  = maxHz - minHz;
  // Capture bandwidth needs headroom over the raw channel spread — round up to a supported rate.
  const sampleRate = Math.min(2_880_000, Math.max(1_000_000, Math.ceil((span * 1.4) / 48_000) * 48_000 || 2_400_000));
  if (span > sampleRate * 0.9) {
    logger.warn(`airband dongle ${dongle.device}: channel spread (${span}Hz) is close to or exceeds capture bandwidth (${sampleRate}Hz) — some channels may not decode`);
  }
  const centerHz = Math.round((minHz + maxHz) / 2);

  const icecastHost = dongle.icecastHost || e.ICECAST_HOST || 'localhost';
  const icecastPort = dongle.icecastPort || e.ICECAST_PORT || '8000';
  const icecastPass = dongle.icecastPassword || e.ICECAST_SOURCE_PASSWORD || '';
  const gainRaw = String(dongle.gain || e.RTL_FM_GAIN || '40');
  const gainLit = gainRaw.includes('.') ? gainRaw : `${gainRaw}.0`; // libconfig gain is a float field

  const pocsagChannel = `        {
            freq = ${pocsagHz};
            modulation = "nfm";
            outputs:
            (
                { type = "udp_stream"; dest_address = "127.0.0.1"; dest_port = ${udpPort}; continuous = true; }
            );
        }`;

  const voiceBlocks = voiceChannels.map(c => {
    const hz = parseFreqHz(c.freq);
    const squelchLine = c.squelch ? `\n            squelch_threshold = ${c.squelch};` : '';
    const name = String(c.description || '').replace(/"/g, '');
    return `        {
            freq = ${hz};
            modulation = "${c.mode === 'am' ? 'am' : 'nfm'}";${squelchLine}
            outputs:
            (
                { type = "icecast"; server = "${icecastHost}"; port = ${icecastPort}; mountpoint = "ch${c.id}"; username = "source"; password = "${icecastPass}"; name = "${name}"; }
            );
        }`;
  });

  const allChannels = [pocsagChannel, ...voiceBlocks].join(',\n');

  return `general:
{
    fft_size = 2048;
};

devices:
(
    {
        type = "rtlsdr";
        index = ${dongle.device ?? 0};
        gain = ${gainLit};
        correction = ${dongle.ppm || e.RTL_FM_PPM || '0'};
        sample_rate = ${sampleRate};
        centerfreq = ${centerHz};

        channels:
        (
${allChannels}
        );
    }
);
`;
}

// Spawns whichever process feeds POCSAG audio for this dongle, returning a uniform
// { proc, dataStream } shape regardless of mode — proc is what gets tracked/killed,
// dataStream is what gets piped into multimon-ng's stdin.
function spawnAudioSource(dongle, label) {
  if (dongle.mode === 'airband') {
    const udpPort = udpPortForDongle(dongle.device);
    const voiceChannels = (Array.isArray(dongle.voiceChannelIds) ? dongle.voiceChannelIds : [])
      .map(id => getVoiceChannelById(id))
      .filter(Boolean);
    const configText = buildAirbandConfig(dongle, voiceChannels, udpPort);
    const configPath = path.join(os.tmpdir(), `pagermonitor-airband-${dongle.device}.conf`);
    fs.writeFileSync(configPath, configText);
    logger.info(`${label} rtl_airband -c ${configPath} (POCSAG + ${voiceChannels.length} voice channel(s))`);

    // Bind before spawning so we're ready to receive the moment rtl_airband starts sending.
    const dataStream = new PassThrough();
    const resample = createFloatToInt16Resampler(AIRBAND_UDP_SAMPLE_RATE, MULTIMON_SAMPLE_RATE);
    const socket = dgram.createSocket('udp4');
    socket.on('message', msg => dataStream.write(resample(msg)));
    socket.on('error', err => logger.warn(`${label} UDP socket error: ${err.message}`));
    socket.bind(udpPort, '127.0.0.1');

    const proc = spawn('rtl_airband', ['-f', '-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { proc, dataStream, socket, configPath };
  }
  const rtlArgs = buildRtlFmArgsForDongle(dongle);
  const proc = spawn('rtl_fm', rtlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  return { proc, dataStream: proc.stdout, rtlArgs };
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
    sdrStatus.rtlArgs     = null;   // not applicable in multi-dongle mode
    sdrStatus.mmonArgs    = null;
    sdrStatus.freq        = dongles.map(d => d.freq).join(', ');
    sdrStatus.protocols   = dongles.map(d => d.protocols || process.env.MULTIMON_PROTOCOLS || '');
    sdrStatus.dongleCount = dongles.length;
    sdrStatus.dongleStatuses = donglePipelines.map(p => ({
      device: p.cfg.device, freq: p.cfg.freq, protocols: p.cfg.protocols, label: p.label,
      running: false, error: null, lastMessage: null,
      rtlArgs: p.rtlArgs, mmonArgs: p.mmonArgs,
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
    registerSource('sdr');

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
  unregisterSource('sdr');
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
function cleanMessage(raw) {
  let msg = raw.replace(EOT_RE, '').trim();
  for (const { pattern, replace } of getMessageNormalizations()) {
    try { msg = msg.replace(new RegExp(pattern, 'g'), replace); } catch (_) {}
  }
  return msg;
}

// Thin wrapper so multi-dongle spawner can call the same handler
function parseLine(line) {
  // Returns parsed object or null — same logic as handleLine but without side effects
  const pm = POCSAG_RE.exec(line);
  if (pm) {
    const [, proto, capcode, funcStr, msgRaw] = pm;
    const protocol = proto.toUpperCase();
    return { protocol, baud: parseInt((protocol.match(/\d+/) || ['0'])[0], 10),
      capcode: normCapcode(capcode.trim()), funcbits: parseInt(funcStr, 10), message: cleanMessage(msgRaw), raw: line };
  }
  // Try old format first, then new pipe-delimited format
  const fmOld = FLEX_RE_OLD.exec(line);
  if (fmOld) {
    const [, capcode, funcStr, , msgRaw] = fmOld;
    return { protocol: 'FLEX', baud: null, capcode: normCapcode(capcode.trim()),
      funcbits: parseInt(funcStr, 10), message: cleanMessage(msgRaw), raw: line };
  }
  const fmNew = FLEX_RE_NEW.exec(line);
  if (fmNew) {
    const [, capcode, msgType, msgRaw] = fmNew;
    return { protocol: 'FLEX', baud: null, capcode: normCapcode(capcode.trim()),
      funcbits: FLEX_TYPE_FUNC[msgType] ?? 3, message: cleanMessage(msgRaw), raw: line };
  }
  return null;
}

// Alias so the multi-dongle spawner code compiles — sourceId is threaded through
const handleDecodedMessage = (msg, sourceId = 'sdr') => handleLine(msg.raw || '', sourceId);

function handleLine(line, sourceId = 'sdr') {
  let parsed = null;

  const pm = POCSAG_RE.exec(line);
  if (pm) {
    const [, proto, capcode, funcStr, msgRaw] = pm;
    const protocol = proto.toUpperCase();
    const baud     = parseInt((protocol.match(/\d+/) || ['0'])[0], 10);
    parsed = { protocol, baud, capcode: normCapcode(capcode.trim()), funcbits: parseInt(funcStr, 10), message: cleanMessage(msgRaw) };
  }

  const fmOld = !parsed && FLEX_RE_OLD.exec(line);
  if (fmOld) {
    const [, capcode, funcStr, , msgRaw] = fmOld;
    parsed = { protocol: 'FLEX', baud: null, capcode: normCapcode(capcode.trim()), funcbits: parseInt(funcStr, 10), message: cleanMessage(msgRaw) };
  }
  const fmNew = !parsed && FLEX_RE_NEW.exec(line);
  if (fmNew) {
    const [, capcode, msgType, msgRaw] = fmNew;
    parsed = { protocol: 'FLEX', baud: null, capcode: normCapcode(capcode.trim()), funcbits: FLEX_TYPE_FUNC[msgType] ?? 3, message: cleanMessage(msgRaw) };
  }

  if (!parsed) return;

  if (isDuplicate(parsed.capcode, parsed.message)) {
    addLog('system', `[dedup] ${parsed.capcode} "${parsed.message.substring(0, 40)}"`);
    return;
  }

  const timestamp = new Date().toISOString();
  const geocodeCountry = (getSetting('site_settings', {}).geocodeCountry || 'si');
  const location = parseLocation(parsed.message, geocodeCountry);
  const { lat, lng } = location;
  // Raw, alias-agnostic — alias/group naming is resolved per-org at broadcast/read
  // time (an alias can differ per org, or be a global shared default; see services/fanout.js).
  const rawMsg = { timestamp, raw: line, ...parsed, lat, lng, alias: null };

  const id     = insertMessage(rawMsg);
  const perOrg = broadcastAll(rawMsg, id); // resolves alias/group + applies each org's feed filter

  recordMessage(sourceId);
  sdrStatus.lastMessage = timestamp;

  // Geocode address first if no explicit coords, so notifications include a map link.
  // Runs once for the shared raw message, not per-org — location isn't org-specific.
  ;(async () => {
    let coordsPatch = null;
    if (!lat) {
      const result = await geocodeAddress(location.candidates || [], geocodeCountry, parsed.message).catch(() => null);
      if (result) {
        try { require('./database').getDb().prepare('UPDATE messages SET lat=?, lng=? WHERE id=?').run(result.lat, result.lng, id); } catch (_) {}
        broadcast({ type: 'message_location', id, lat: result.lat, lng: result.lng });
        coordsPatch = { lat: result.lat, lng: result.lng };
      }
    }
    await notifyAll(perOrg, coordsPatch);
  })();

  logger.info(`[${rawMsg.protocol}] ${rawMsg.capcode}: ${rawMsg.message.substring(0, 80)}`);
}

// ── Multi-dongle pipeline spawner ─────────────────────────────────────────────
function spawnDonglePipeline(dongle, label, myGen) {
  const dongleSourceId = `dongle-${dongle.device}`;
  registerSource(dongleSourceId);
  const mmonArgs = buildMmonArgsForDongle(dongle);
  const sourceName = dongle.mode === 'airband' ? 'rtl_airband' : 'rtl_fm';
  logger.info(`${label} Starting: device=${dongle.device} freq=${dongle.freq || process.env.RTL_FM_FREQ} mode=${dongle.mode || 'single'}`);

  const state = { running: false, error: null, restarts: 0, lastMessage: null };

  const { proc: rtl, dataStream, rtlArgs, socket, configPath } = spawnAudioSource(dongle, label);
  const mmon = spawn('multimon-ng', mmonArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
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
  dataStream.pipe(tap);
  tap.pipe(mmon.stdin);
  dataStream.on('error', () => {});
  mmon.stdin.on('error',  () => {});
  const watchdog = setInterval(() => {
    if (myGen !== generation) { clearInterval(watchdog); return; }
    if (Date.now() - lastRtlMs > 20000) {
      clearInterval(watchdog);
      logger.warn(`${label} watchdog: no audio data for 20s — restarting`);
      if (!stopping) onFail('watchdog', `${sourceName} stalled`);
    }
  }, 10000);

  rtl.stderr.on('data',  d => d.toString().split('\n').forEach(l => { if (l.trim()) addLog(sourceName,  `${label} ${l.trim()}`); }));
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
      handleDecodedMessage(msg, dongleSourceId);
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
  rtl.on('exit',  onExit(sourceName));
  mmon.on('exit', onExit('multimon-ng'));
  rtl.on('error',  e => { if (myGen !== generation) return; logger.error(`${label} ${sourceName}: ${e.message}`);  if (!stopping) onFail(sourceName,  e.message); });
  mmon.on('error', e => { if (myGen !== generation) return; logger.error(`${label} mmon: ${e.message}`);     if (!stopping) onFail('mmon',    e.message); });

  return { rtlProc: rtl, mmonProc: mmon, dataStream, cfg: dongle, label, state, watchdog, rtlArgs, mmonArgs, socket, configPath };
}

function broadcastDongleStatus() {
  const dongles = donglePipelines.map(p => ({
    device:      p.cfg.device,
    freq:        p.cfg.freq,
    label:       p.label,
    running:     p.state.running,
    error:       p.state.error,
    lastMessage: p.state.lastMessage,
    rtlArgs:     p.rtlArgs,
    mmonArgs:    p.mmonArgs,
  }));
  const allOk = dongles.every(d => d.running);
  sdrStatus.dongleStatuses = dongles;
  sdrStatus.running = allOk || dongles.some(d => d.running); // overall: running if any is up
  broadcast({ type: 'sdr_status', status: getStatus() });
}

function stopMultiDonglePipelines() {
  for (const p of donglePipelines) {
    try { clearInterval(p.watchdog); } catch (_) {}
    try { p.dataStream?.unpipe(); p.dataStream?.destroy(); } catch (_) {}
    try { p.mmonProc?.kill('SIGTERM'); } catch (_) {}
    try { p.rtlProc?.kill('SIGTERM'); } catch (_) {}
    try { unregisterSource(`dongle-${p.cfg.device}`); } catch (_) {}
    try { p.socket?.close(); } catch (_) {}
  }
  donglePipelines = [];
}

module.exports = { startSdrPipeline, stopSdrPipeline, restartSdrPipeline, getStatus, getLogs };

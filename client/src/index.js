'use strict';

const { spawn, execSync } = require('child_process');
const { PassThrough }     = require('stream');
const dgram = require('dgram');
const iconv               = require('iconv-lite');
const http  = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER_URL = (process.env.SERVER_URL || 'http://192.168.1.100:3000').replace(/\/$/, '');
const CLIENT_KEY = process.env.CLIENT_KEY  || '';
const CLIENT_ID  = process.env.CLIENT_ID   || 'rpi-1';

// Icecast lives alongside the main server — voice channels stream outbound to it (same
// direction as /client/message posts), never accepting inbound connections on this Pi.
const ICECAST_HOST = process.env.ICECAST_HOST || (() => { try { return new URL(SERVER_URL).hostname; } catch (_) { return 'localhost'; } })();
const ICECAST_PORT = process.env.ICECAST_PORT || '8000';
const ICECAST_SOURCE_PASSWORD = process.env.ICECAST_SOURCE_PASSWORD || '';

// ── Git version (reported to server so admin UI can show update availability) ─
let CLIENT_GIT_HASH = null;
try {
  const repoDir = path.join(__dirname, '..');
  CLIENT_GIT_HASH = execSync('git rev-parse HEAD', { cwd: repoDir, timeout: 3000 }).toString().trim();
} catch (_) { /* not a git repo or git not installed — that's fine */ }

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
    freq:           process.env.RTL_FM_FREQ                || '173.250M',
    modulation:     process.env.RTL_FM_MODULATION          || 'fm',
    sampleRate:     process.env.RTL_FM_SAMPLE_RATE         || '22050',
    gain:           process.env.RTL_FM_GAIN                || '40',
    ppm:            process.env.RTL_FM_PPM                 || '0',
    squelch:        process.env.RTL_FM_SQUELCH             || '0',
    resampleRate:   process.env.RTL_FM_RESAMPLE_RATE       || '',
    lowpass:        process.env.RTL_FM_LOWPASS             || '',
    tunerBandwidth: process.env.RTL_FM_TUNER_BANDWIDTH     || '',
    directSampling: process.env.RTL_FM_DIRECT_SAMPLING     || '0',
    offsetTuning:   process.env.RTL_FM_OFFSET_TUNING       || '0',
    protocols:      process.env.MULTIMON_PROTOCOLS         || 'POCSAG1200',
    verbosity:      process.env.MULTIMON_VERBOSITY         || '',
    quiet:          process.env.MULTIMON_QUIET             || '1',
    inputFormat:    process.env.MULTIMON_INPUT_FORMAT      || '',
    pocsagSpecial:  process.env.MULTIMON_POCSAG_SPECIAL    || '0',
    charset:        process.env.MULTIMON_POCSAG_CHARSET    || '',
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
  if (cfg.ppm            && cfg.ppm            !== '0') args.push('-p', cfg.ppm);
  if (cfg.squelch        && cfg.squelch        !== '0') args.push('-l', cfg.squelch);
  if (cfg.resampleRate)                                  args.push('-r', cfg.resampleRate);
  if (cfg.lowpass)                                       args.push('-E', cfg.lowpass);
  if (cfg.tunerBandwidth)                                args.push('-T', cfg.tunerBandwidth);
  if (cfg.directSampling && cfg.directSampling !== '0') args.push('-D', cfg.directSampling);
  if (cfg.offsetTuning   && cfg.offsetTuning   !== '0') args.push('-O', cfg.offsetTuning);
  args.push('-');
  return args;
}

function buildMmonArgs(cfg) {
  const args = [];
  cfg.protocols.split(/\s+/).forEach(p => args.push('-a', p));
  args.push('-t', cfg.inputFormat || 'raw');
  if (cfg.verbosity)             args.push('-v', cfg.verbosity);
  if (cfg.quiet       === '1')   args.push('-q');
  if (cfg.pocsagSpecial === '1') args.push('-s');
  if (cfg.charset)               args.push('-C', cfg.charset);
  args.push('-');
  return args;
}

// ── rtl_airband (multi-channel: POCSAG + voice, one dongle) ───────────────────
// Mirrors backend/src/services/sdr.js's airband support. voiceChannels here are already
// resolved (freq/mode/squelch/description) by the server's GET /client/config handler,
// since this client has no DB of its own — see routes/client.js.
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
// error" on line 1 when this was first written as TOML — see server-side sdr.js's
// identical note). Exact field names/types are still best-effort.
function buildAirbandConfig(cfg, voiceChannels, udpPort) {
  const pocsagHz = parseFreqHz(cfg.freq);
  const voiceHz  = voiceChannels.map(c => parseFreqHz(c.freq));
  const allHz    = [pocsagHz, ...voiceHz];

  // A frequency string missing its k/M/G suffix (e.g. "173.4875" instead of "173.4875M")
  // parses as a near-zero Hz value and silently wrecks the center-frequency math below —
  // catch it loudly here instead of producing a nonsense capture window.
  const tooLow = [{ label: 'POCSAG', hz: pocsagHz }, ...voiceChannels.map((c, i) => ({ label: c.description || `voice channel #${i}`, hz: voiceHz[i] }))]
    .filter(x => x.hz < 1_000_000);
  if (tooLow.length) {
    log('warn', `airband dongle ${cfg.device}: suspiciously low frequency (missing M suffix?) for: ${tooLow.map(x => `${x.label}=${x.hz}Hz`).join(', ')}`);
  }

  const minHz = Math.min(...allHz), maxHz = Math.max(...allHz);
  const span  = maxHz - minHz;
  const sampleRate = Math.min(2_880_000, Math.max(1_000_000, Math.ceil((span * 1.4) / 48_000) * 48_000 || 2_400_000));
  if (span > sampleRate * 0.9) {
    log('warn', `airband dongle ${cfg.device}: channel spread (${span}Hz) is close to or exceeds capture bandwidth (${sampleRate}Hz) — some channels may not decode`);
  }
  const centerHz = Math.round((minHz + maxHz) / 2);
  const gainRaw = String(cfg.gain || '40');
  const gainLit = gainRaw.includes('.') ? gainRaw : `${gainRaw}.0`; // libconfig gain is a float field
  // Pushed from Admin -> SDR Clients config takes priority over this Pi's local .env,
  // so the icecast password can be set from the UI instead of editing .env over SSH.
  const icecastHost = cfg.icecastHost || ICECAST_HOST;
  const icecastPort = cfg.icecastPort || ICECAST_PORT;
  const icecastPass = cfg.icecastPassword || ICECAST_SOURCE_PASSWORD;

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
    fft_size = 512;
    multiple_demod_threads = true;
    multiple_output_threads = true;
};

devices:
(
    {
        type = "rtlsdr";
        index = ${cfg.device ?? 0};
        gain = ${gainLit};
        correction = ${cfg.ppm || '0'};
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

function spawnAudioSource(cfg, label) {
  if (cfg.mode === 'airband') {
    const udpPort = udpPortForDongle(cfg.device);
    const voiceChannels = Array.isArray(cfg.voiceChannels) ? cfg.voiceChannels : [];
    const configText = buildAirbandConfig(cfg, voiceChannels, udpPort);
    const configPath = path.join(os.tmpdir(), `pagermonitor-airband-${cfg.device}.conf`);
    fs.writeFileSync(configPath, configText);
    log('info', `${label} rtl_airband -c ${configPath} (POCSAG + ${voiceChannels.length} voice channel(s))`);

    // Bind before spawning so we're ready to receive the moment rtl_airband starts sending.
    const dataStream = new PassThrough();
    const resample = createFloatToInt16Resampler(AIRBAND_UDP_SAMPLE_RATE, MULTIMON_SAMPLE_RATE);
    const socket = dgram.createSocket('udp4');
    socket.on('message', msg => dataStream.write(resample(msg)));
    socket.on('error', err => log('warn', `${label} UDP socket error: ${err.message}`));
    socket.bind(udpPort, '127.0.0.1');

    const proc = spawn('rtl_airband', ['-f', '-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { proc, dataStream, socket };
  }
  const rtlArgs = buildRtlArgs(cfg);
  const proc = spawn('rtl_fm', rtlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  return { proc, dataStream: proc.stdout };
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
    // Report the full running config of the primary dongle so the server UI can
    // show .env values as grey placeholders for fields that have no DB override.
    const mainCfg  = pipelines[0].getCfg();
    const liveCfg  = {
      freq: mainCfg.freq, modulation: mainCfg.modulation,
      sampleRate: mainCfg.sampleRate, gain: mainCfg.gain,
      device: mainCfg.device, ppm: mainCfg.ppm,
      squelch: mainCfg.squelch, resampleRate: mainCfg.resampleRate,
      lowpass: mainCfg.lowpass, tunerBandwidth: mainCfg.tunerBandwidth,
      directSampling: mainCfg.directSampling, offsetTuning: mainCfg.offsetTuning,
      protocols: mainCfg.protocols, verbosity: mainCfg.verbosity,
      quiet: mainCfg.quiet, inputFormat: mainCfg.inputFormat,
      pocsagSpecial: mainCfg.pocsagSpecial, charset: mainCfg.charset,
    };
    const hashParam = CLIENT_GIT_HASH ? `&gitHash=${CLIENT_GIT_HASH}` : '';
    const r = await httpRequest('GET', `/client/config?freq=${encodeURIComponent(freqs)}&protocols=${encodeURIComponent(protocols)}&sdrRunning=${sdrRunning}&cfg=${encodeURIComponent(JSON.stringify(liveCfg))}${hashParam}`);
    if (r.status !== 200 || !r.body) return;

    // Handle remote command (one-shot — server clears it after delivery)
    if (r.body.command) handleRemoteCommand(r.body.command);

    if (!r.body.config) return;
    const { config, version } = r.body;
    if (!config || version === globalConfigVersion) return;

    globalOverrideCfg   = config;
    globalConfigVersion = version;

    // A `dongles` array targets specific pipelines by device index (used for airband
    // mode/voiceChannels — server resolves voiceChannelIds into full channel data before
    // sending, see routes/client.js). Anything else is the older flat override applied
    // identically to every pipeline.
    if (Array.isArray(config.dongles)) {
      log('info', `Remote config updated (v${version}) — applying per-dongle overrides`);
      for (const d of config.dongles) {
        const p = pipelines.find(p => p.getCfg().device === String(d.device));
        if (p) p.applyRemoteConfig(d);
        else log('warn', `Remote config references device ${d.device} — no matching local pipeline, ignoring`);
      }
    } else {
      log('info', `Remote config updated (v${version}) — applying to all dongles`);
      for (const p of pipelines) p.applyRemoteConfig(config);
    }
  } catch (e) {
    log('debug', `Config poll failed: ${e.message}`);
  }
}

// ── Remote command handler ────────────────────────────────────────────────────
function handleRemoteCommand(command) {
  log('info', `Remote command received: ${command}`);
  if (command === 'update') {
    runUpdateScript();
  } else {
    log('warn', `Unknown remote command: ${command} — ignoring`);
  }
}

function runUpdateScript() {
  // update.sh lives in the client directory — one level up from src/
  const scriptPath = path.join(__dirname, '..', 'update.sh');

  if (!fs.existsSync(scriptPath)) {
    log('warn', `update.sh not found at ${scriptPath} — cannot run remote update`);
    return;
  }

  log('info', `Launching remote update: bash ${scriptPath}`);

  // Spawn detached so the script survives the service restart it triggers
  const child = spawn('bash', [scriptPath], {
    cwd:      path.join(__dirname, '..'), // client directory
    detached: true,
    stdio:    ['ignore', 'pipe', 'pipe'],
    env:      { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
  });

  child.stdout.on('data', d =>
    d.toString().split('\n').forEach(l => { if (l.trim()) log('info', `[update] ${l.trim()}`); })
  );
  child.stderr.on('data', d =>
    d.toString().split('\n').forEach(l => { if (l.trim()) log('warn', `[update] ${l.trim()}`); })
  );
  child.on('error', err => log('error', `[update] spawn error: ${err.message}`));
  child.on('close', code => {
    // We may never reach this if the service is restarted mid-update — that's expected
    if (code !== null && code !== 0) log('warn', `[update] script exited with code ${code}`);
  });

  // Unref so Node's event loop doesn't wait for the child
  child.unref();
}

// ── Single dongle pipeline ────────────────────────────────────────────────────
function createPipeline(baseCfg, index) {
  let cfg      = { ...baseCfg };
  let rtlProc  = null;
  let mmonProc = null;
  let dataStream = null;
  let udpSocket  = null;
  let stopping = false;
  let restartTimer    = null;
  let consecutiveFails = 0;
  let generation = 0;
  let watchdogTimer   = null;
  let pipelineRunning = false;
  const label = `[dongle-${cfg.device}]`;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Waits for a process to actually exit (SIGKILL-escalating after a timeout) rather than
  // just firing SIGTERM and hoping — on slow hardware, rtl_airband's teardown (releasing the
  // USB device, disconnecting Icecast, stopping FFT threads) can take longer than a fixed
  // sleep, and starting a new instance before the old one actually released the dongle
  // produces a "usb_claim_interface error -6" (device busy) loop.
  function killProcess(proc, timeoutMs = 4000) {
    return new Promise(resolve => {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      proc.once('exit', finish);
      try { proc.kill('SIGTERM'); } catch (_) { finish(); return; }
      setTimeout(() => {
        if (!done) { try { proc.kill('SIGKILL'); } catch (_) {} finish(); }
      }, timeoutMs);
    });
  }

  async function kill() {
    pipelineRunning = false;
    clearInterval(watchdogTimer); watchdogTimer = null;
    try { dataStream?.unpipe(); dataStream?.destroy(); } catch (_) {}
    try { udpSocket?.close(); } catch (_) {}
    const toKill = [mmonProc, rtlProc].filter(Boolean);
    rtlProc = null; mmonProc = null; dataStream = null; udpSocket = null;
    await Promise.all(toKill.map(p => killProcess(p)));
  }

  async function start() {
    if (stopping) return;
    // Bump generation BEFORE awaiting kill() — the old process's 'exit' event now fires
    // while we're inside that await, and its handler's staleness guard (myGen !== generation)
    // only works if generation has already moved on by then. Incrementing after kill() (as
    // this used to do, back when kill() didn't wait for real exit) left the exit handler
    // thinking it was still current, so it fired scheduleRestart() on every intentional
    // restart — a "ghost" restart timer stacked on top of the real one, compounding forever.
    const myGen = ++generation;
    await kill();
    if (stopping || myGen !== generation) return;

    log('info', `${label} Waiting 3s before starting...`);
    await sleep(3000);
    if (stopping || myGen !== generation) return;

    const mmonArgs = buildMmonArgs(cfg);
    const sourceName = cfg.mode === 'airband' ? 'rtl_airband' : 'rtl_fm';
    log('info', `${label} ${sourceName} -d ${cfg.device} -f ${cfg.freq} → multimon-ng ${cfg.protocols}`);

    try {
      const source = spawnAudioSource(cfg, label);
      rtlProc    = source.proc;
      dataStream = source.dataStream;
      udpSocket  = source.socket || null;
      mmonProc = spawn('multimon-ng', mmonArgs, { stdio: ['pipe',   'pipe', 'pipe'] });

      const tap = new PassThrough();
      let lastRtlMs = Date.now();
      tap.on('data', () => {
        lastRtlMs = Date.now();
        // Only reset backoff once real data actually flows — resetting on spawn alone (as
        // this used to do) meant a process that fails immediately after every spawn (e.g.
        // "device busy") retried at a flat 5s forever instead of backing off, which can
        // itself starve the OS of the time it needs to actually release a stuck USB handle.
        if (!pipelineRunning) { pipelineRunning = true; consecutiveFails = 0; }
      });
      tap.on('error', () => {});
      dataStream.pipe(tap);
      tap.pipe(mmonProc.stdin);
      dataStream.on('error', () => {});
      mmonProc.stdin.on('error',  () => {});
      watchdogTimer = setInterval(() => {
        if (stopping || myGen !== generation) { clearInterval(watchdogTimer); watchdogTimer = null; return; }
        if (Date.now() - lastRtlMs > 20000) {
          clearInterval(watchdogTimer); watchdogTimer = null;
          log('warn', `${label} ${sourceName} watchdog: no audio data for 20s — restarting`);
          if (!stopping) scheduleRestart();
        }
      }, 10000);

      rtlProc.stderr.on('data', d =>
        d.toString().split('\n').forEach(l => { if (l.trim()) log('debug', `${label} ${sourceName}: ${l.trim()}`); })
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
      rtlProc.on('exit',  onExit(sourceName));
      mmonProc.on('exit', onExit('multimon-ng'));
      rtlProc.on('error',  e => { if (myGen !== generation) return; log('error', `${label} ${sourceName} error: ${e.message}`);  pipelineRunning = false; if (!stopping) scheduleRestart(); });
      mmonProc.on('error', e => { if (myGen !== generation) return; log('error', `${label} mmon error: ${e.message}`);     pipelineRunning = false; if (!stopping) scheduleRestart(); });

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
    // JSON-compare rather than !== — voiceChannels (and any other array/object field) is a
    // fresh reference on every poll even when its content is identical, which would
    // otherwise look "changed" every cycle and restart the pipeline every 60s forever.
    const changed = Object.keys(newCfg).some(k => JSON.stringify(newCfg[k]) !== JSON.stringify(cfg[k]));
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
    return kill();
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

// Graceful shutdown — waits (bounded) for pipelines to actually release their SDR devices
// before exiting, so a systemd restart doesn't outrace kill()'s own SIGKILL escalation and
// leave an orphaned rtl_fm/rtl_airband process holding the dongle for the next start.
const shutdown = () => {
  log('info', 'Shutting down...');
  clearInterval(configTimer);
  const stopAll = Promise.all(pipelines.map(p => p.stop()));
  const stopped = Promise.race([stopAll, new Promise(r => setTimeout(r, 4500))]);
  stopped.finally(() => {
    // Notify server we're offline so it doesn't wait for the threshold to expire
    httpRequest('POST', '/client/offline', {})
      .catch(() => {})
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000); // safety exit if the offline POST hangs
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

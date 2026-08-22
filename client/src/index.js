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
const WebSocket = require('ws');

// ── Config ────────────────────────────────────────────────────────────────────
const SERVER_URL = (process.env.SERVER_URL || 'http://192.168.1.100:3000').replace(/\/$/, '');
const CLIENT_KEY = process.env.CLIENT_KEY  || '';
const CLIENT_ID  = process.env.CLIENT_ID   || 'rpi-1';

// Voice-channel audio relay lives alongside the main server — this Pi connects outbound to
// it (same direction as /client/message posts), never accepting inbound connections here.
const AUDIO_WS_URL = SERVER_URL.replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws') + '/ws/audio-source';

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
// Shared base fields (freq/gain/protocols/...) sourced from the Pi's local .env — used both
// as the starting point for every DONGLES-array entry at boot, and as what a dongle newly
// added via the server's Admin UI inherits for any field it doesn't explicitly set (mirrors
// how a blank field in the old flat per-client config always meant "use the Pi's .env value").
function buildGlobalDongleDefaults() {
  return {
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
    pocsagMode:     process.env.MULTIMON_POCSAG_MODE       || '',
  };
}

// Overlays override fields onto base, treating '' / null / undefined as "no override" (falls
// back to base) — e.g. a field left blank in Admin → SDR Clients means "use the Pi's .env
// value", not "clear it". Shared by applyRemoteConfig() and the initial-boot config merge
// below so both follow identical semantics.
function mergeConfig(base, override) {
  const merged = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v !== '' && v != null) merged[k] = v;
  }
  return merged;
}

function buildDongleConfigs() {
  const global = buildGlobalDongleDefaults();

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

// ── RTL-SDR hardware enumeration (serial-based device identification) ─────────
// Mirrors backend/src/services/rtlDevices.js. rtl_test's "Found N device(s):" header is
// printed from USB descriptor reads alone, before it tries to claim any device — safe to
// run even while other dongles on this Pi are actively streaming. The out-of-range device
// index makes it fail fast trying to open THAT device afterward, never touching a real one.
const RTL_ENUM_DEVICE_INDEX = 999;
const RTL_ENUM_TIMEOUT_MS   = 3000;
const RTL_DEVICE_LINE_RE    = /^\s*(\d+):\s*(.+?),\s*(.+?),\s*SN:\s*(\S+)/;

function parseDeviceList(output) {
  const list = [];
  for (const line of output.split('\n')) {
    const m = RTL_DEVICE_LINE_RE.exec(line);
    if (m) list.push({ index: Number(m[1]), vendor: m[2].trim(), product: m[3].trim(), serial: m[4].trim() });
  }
  return list;
}

function listAttachedDongles() {
  return new Promise(resolve => {
    let output = '';
    let done = false;
    let proc;
    try {
      proc = spawn('rtl_test', ['-d', String(RTL_ENUM_DEVICE_INDEX)]);
    } catch (e) {
      log('warn', `rtl_test spawn failed: ${e.message}`);
      resolve([]);
      return;
    }

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve(parseDeviceList(output));
    };

    const timer = setTimeout(finish, RTL_ENUM_TIMEOUT_MS);
    const onData = d => { output += d.toString(); };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', finish);
    proc.on('error', e => { log('warn', `rtl_test error: ${e.message}`); finish(); });
  });
}

async function resolveDeviceIndex(serial) {
  if (!serial) return null;
  const list  = await listAttachedDongles();
  const match = list.find(d => d.serial === serial);
  return match ? match.index : null;
}

// ── Logging ───────────────────────────────────────────────────────────────────
function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
  // Remote log viewing (Admin -> Client Logs) — piggybacks on the audio-relay connection
  // so the server can buffer/tail this client's logs without SSH/port forwarding. Sent
  // unconditionally once connected — the server decides whether anyone's watching.
  if (audioWs && audioWs.readyState === WebSocket.OPEN) {
    try { audioWs.send(JSON.stringify({ type: 'log', level, msg, ts })); } catch (_) {}
  }
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
  // multimon-ng's default (no -f) guesses Numeric vs Alpha per-message from decoded content
  // (penalizing brackets/junk chars, rewarding clean letters/digits) — confirmed in the field
  // to misclassify legitimate alpha messages as Numeric garbage when they're digit-heavy (e.g.
  // postal addresses/house numbers). -f alpha forces every message on this decoder to print as
  // alpha, skipping that guesswork entirely; only worth setting on networks that never send
  // genuinely numeric-only pages, since it'd misrender those.
  if (cfg.pocsagMode)            args.push('-f', cfg.pocsagMode);
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

// Distinct range from udpPortForDongle's (18000+device, device counts stay tiny) — voice
// channel ids come from the server's DB and this keeps them from ever colliding.
function udpPortForVoiceChannel(channelId) {
  return 19000 + Number(channelId);
}

// ── Voice-channel audio relay (outbound WebSocket to the server) ──────────────────────
// Persistent, always attempting to connect regardless of which dongles are configured —
// cheap to keep open, simpler than tearing it down/rebuilding around config changes.
// rtl_airband keeps demodulating any assigned voice channel locally & continuously either
// way (same as POCSAG); only whether a channel's already-flowing local audio gets forwarded
// onward over this socket is gated by start/stop control messages from the server (which it
// sends based on real listener count) — keeps WAN bandwidth at zero for unwatched channels.
let audioWs = null;
let audioWsReconnectTimer = null;
let audioWsAttempts = 0;
const voiceChannelForwarding = new Map(); // channelId -> boolean

// ── "Is someone talking" activity — runs for every voice channel regardless of whether
// its audio is currently being forwarded, so the app can show activity on channels nobody's
// listening to yet without streaming their full audio. Debounced locally (only sent to the
// server on an actual on/off transition) to keep this genuinely lightweight bandwidth-wise —
// same threshold/hang-time reasoning as the server's own local-dongle version.
const ACTIVITY_RMS_THRESHOLD = 0.02;
const ACTIVITY_HANG_MS = 800;
const channelActivityState = new Map();      // channelId -> boolean
const channelActivityHangTimers = new Map(); // channelId -> Timeout

function computeRms(buf) {
  const n = buf.length >> 2;
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) { const v = buf.readFloatLE(i * 4); sumSq += v * v; }
  return Math.sqrt(sumSq / n);
}

function sendActivity(channelId, active) {
  if (!audioWs || audioWs.readyState !== WebSocket.OPEN) return;
  try { audioWs.send(JSON.stringify({ type: 'activity', channelId: Number(channelId), active })); } catch (_) {}
}

// Recent audio kept per channel regardless of forwarding state (rtl_airband demodulates
// continuously either way) — flushed as a burst the moment forwarding turns on, so a listener
// who joins right as a transmission starts (the common auto-listen case) doesn't lose the
// first word or two to the round-trip time of the server telling us to start forwarding.
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

function flushPreRoll(channelId) {
  const buf = preRollBuffers.get(Number(channelId));
  if (!buf || buf.length === 0 || !audioWs || audioWs.readyState !== WebSocket.OPEN) return;
  // recordPreRoll only trims on a new push — a channel that's gone quiet stops getting
  // trimmed at all, so re-check staleness here too rather than trusting whatever's still
  // sitting in the array from whenever it was last fed.
  const cutoff = Date.now() - PREROLL_MS;
  const header = Buffer.alloc(4);
  header.writeUInt32LE(Number(channelId), 0);
  for (const { t, payload } of buf) {
    if (t < cutoff) continue;
    try { audioWs.send(Buffer.concat([header, payload])); } catch (_) {}
  }
}

function reportChannelActivity(channelId, isLoud) {
  const id = Number(channelId);
  if (isLoud) {
    clearTimeout(channelActivityHangTimers.get(id));
    channelActivityHangTimers.delete(id);
    if (!channelActivityState.get(id)) { channelActivityState.set(id, true); sendActivity(id, true); }
  } else if (channelActivityState.get(id) && !channelActivityHangTimers.has(id)) {
    const t = setTimeout(() => {
      channelActivityHangTimers.delete(id);
      channelActivityState.set(id, false);
      sendActivity(id, false);
    }, ACTIVITY_HANG_MS);
    channelActivityHangTimers.set(id, t);
  }
}

function connectAudioWs() {
  if (!CLIENT_KEY) return; // server rejects unauthenticated connections anyway
  if (audioWs && (audioWs.readyState === WebSocket.OPEN || audioWs.readyState === WebSocket.CONNECTING)) return;

  const ws = new WebSocket(AUDIO_WS_URL, { headers: { 'X-Client-Key': CLIENT_KEY, 'X-Client-Id': CLIENT_ID } });
  audioWs = ws;

  ws.on('open', () => {
    log('info', 'Audio relay connected');
    audioWsAttempts = 0;
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // server never sends us audio, only control messages
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    if (msg.type === 'start') { flushPreRoll(msg.channelId); voiceChannelForwarding.set(Number(msg.channelId), true); }
    else if (msg.type === 'stop') voiceChannelForwarding.set(Number(msg.channelId), false);
  });
  ws.on('close', () => {
    if (audioWs === ws) audioWs = null;
    voiceChannelForwarding.clear(); // server re-signals 'start' for anything still being listened to once we reconnect
    scheduleAudioWsReconnect();
  });
  ws.on('error', err => log('debug', `Audio relay error: ${err.message}`));
}

function scheduleAudioWsReconnect() {
  if (audioWsReconnectTimer) return;
  audioWsAttempts++;
  const delay = Math.min(3000 * Math.pow(2, audioWsAttempts - 1), 60_000);
  audioWsReconnectTimer = setTimeout(() => { audioWsReconnectTimer = null; connectAudioWs(); }, delay);
}

// NOTE: RTLSDR-Airband uses libconfig syntax, NOT TOML (confirmed via a real "syntax
// error" on line 1 when this was first written as TOML — see server-side sdr.js's
// identical note). Exact field names/types are still best-effort.
function buildAirbandConfig(cfg, voiceChannels, udpPort) {
  const pocsagEnabled = cfg.pocsagEnabled !== false;
  const pocsagHz = parseFreqHz(cfg.freq);
  const voiceHz  = voiceChannels.map(c => parseFreqHz(c.freq));
  const allHz    = pocsagEnabled ? [pocsagHz, ...voiceHz] : voiceHz;

  // A frequency string missing its k/M/G suffix (e.g. "173.4875" instead of "173.4875M")
  // parses as a near-zero Hz value and silently wrecks the center-frequency math below —
  // catch it loudly here instead of producing a nonsense capture window.
  const tooLow = [
    ...(pocsagEnabled ? [{ label: 'POCSAG', hz: pocsagHz }] : []),
    ...voiceChannels.map((c, i) => ({ label: c.description || `voice channel #${i}`, hz: voiceHz[i] })),
  ].filter(x => x.hz < 1_000_000);
  if (tooLow.length) {
    log('warn', `airband dongle ${cfg.device}: suspiciously low frequency (missing M suffix?) for: ${tooLow.map(x => `${x.label}=${x.hz}Hz`).join(', ')}`);
  }

  const minHz = Math.min(...allHz), maxHz = Math.max(...allHz);
  const span  = maxHz - minHz;
  // Floor is ~1.024Msps, matching rtl_fm's own empirically-proven-stable rate on this exact
  // hardware (its logs show "Sampling at 1014300 S/s" — POCSAG has run reliably at that rate
  // for a very long time). An earlier theory that *raising* the floor toward 2.56Msps (the
  // project's documented default) would fix a periodic instability only delayed it (68s->88s,
  // never eliminated) — worth testing the rate this hardware has actually demonstrated
  // long-term stability at, rather than a higher one that was never proven here.
  const sampleRate = Math.min(2_880_000, Math.max(1_024_000, Math.ceil((span * 1.4) / 48_000) * 48_000 || 1_024_000));
  if (span > sampleRate * 0.9) {
    log('warn', `airband dongle ${cfg.device}: channel spread (${span}Hz) is close to or exceeds capture bandwidth (${sampleRate}Hz) — some channels may not decode`);
  }
  const centerHz = Math.round((minHz + maxHz) / 2);

  // fft_size was previously a fixed 512 regardless of sample_rate, so each channel's
  // effective bandwidth (sample_rate / fft_size) swung wildly — only 2kHz/channel at our
  // 1.024Msps floor, confirmed too narrow in the field: POCSAG failed to decode (clipped
  // FSK deviation) on a config where a voice channel on the very same capture worked fine,
  // exactly matching rtl_airband's own documented low-sample-rate/default-FFT-size gotcha.
  // Target ~4kHz/channel instead, scaling with whatever sample rate gets picked above.
  const fftSize = Math.min(8192, Math.max(256, Math.pow(2, Math.round(Math.log2(sampleRate / 4000)))));
  const gainRaw = String(cfg.gain || '40');
  const gainLit = gainRaw.includes('.') ? gainRaw : `${gainRaw}.0`; // libconfig gain is a float field

  const pocsagChannel = `        {
            freq = ${pocsagHz};
            modulation = "nfm";
            outputs:
            (
                { type = "udp_stream"; dest_address = "127.0.0.1"; dest_port = ${udpPort}; continuous = true; }
            );
        }`;

  // Voice channels stream to our own low-latency WebSocket relay (see AUDIO_WS_URL /
  // connectAudioWs above) instead of Icecast — each gets its own loopback UDP port,
  // same pattern as the POCSAG channel above.
  const voiceBlocks = voiceChannels.map(c => {
    const hz = parseFreqHz(c.freq);
    const squelchLine = c.squelch ? `\n            squelch_threshold = ${c.squelch};` : '';
    // Blank means "use rtl_airband's own built-in default (200us)" — we don't impose a
    // different one unless the channel has an explicit value set.
    const tauLine = c.tau ? `\n            tau = ${c.tau};` : '';
    const port = udpPortForVoiceChannel(c.id);
    return `        {
            freq = ${hz};
            modulation = "${c.mode === 'am' ? 'am' : 'nfm'}";${squelchLine}${tauLine}
            outputs:
            (
                { type = "udp_stream"; dest_address = "127.0.0.1"; dest_port = ${port}; continuous = true; }
            );
        }`;
  });

  const allChannels = (pocsagEnabled ? [pocsagChannel, ...voiceBlocks] : voiceBlocks).join(',\n');

  return `general:
{
    fft_size = ${fftSize};
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
    const pocsagEnabled = cfg.pocsagEnabled !== false;
    const udpPort = udpPortForDongle(cfg.device);
    const voiceChannels = Array.isArray(cfg.voiceChannels) ? cfg.voiceChannels : [];
    const configText = buildAirbandConfig(cfg, voiceChannels, udpPort);
    const configPath = path.join(os.tmpdir(), `pagermonitor-airband-${cfg.device}.conf`);
    fs.writeFileSync(configPath, configText);
    log('info', `${label} rtl_airband -c ${configPath} (${pocsagEnabled ? 'POCSAG + ' : ''}${voiceChannels.length} voice channel(s))`);

    // Bind before spawning so we're ready to receive the moment rtl_airband starts sending.
    // POCSAG leg is entirely skipped when disabled — voice-only dongle, no multimon-ng feed.
    let dataStream = null, socket = null;
    if (pocsagEnabled) {
      dataStream = new PassThrough();
      const resample = createFloatToInt16Resampler(AIRBAND_UDP_SAMPLE_RATE, MULTIMON_SAMPLE_RATE);
      socket = dgram.createSocket('udp4');
      socket.on('message', msg => dataStream.write(resample(msg)));
      socket.on('error', err => log('warn', `${label} UDP socket error: ${err.message}`));
      socket.bind(udpPort, '127.0.0.1');
    }

    // Voice channels: one loopback socket per channel. Always receiving locally (cheap,
    // rtl_airband produces it regardless), but only actually forwarded over the WS relay
    // to the server while voiceChannelForwarding says a real listener is tuned in.
    const voiceSockets = voiceChannels.map(c => {
      const vSocket = dgram.createSocket('udp4');
      vSocket.on('message', msg => {
        reportChannelActivity(c.id, computeRms(msg) > ACTIVITY_RMS_THRESHOLD);
        recordPreRoll(c.id, msg);
        if (!voiceChannelForwarding.get(Number(c.id))) return;
        if (!audioWs || audioWs.readyState !== WebSocket.OPEN) return;
        const header = Buffer.alloc(4);
        header.writeUInt32LE(Number(c.id), 0);
        try { audioWs.send(Buffer.concat([header, msg])); } catch (_) {}
      });
      vSocket.on('error', err => log('warn', `${label} voice channel ${c.id} UDP socket error: ${err.message}`));
      vSocket.bind(udpPortForVoiceChannel(c.id), '127.0.0.1');
      return vSocket;
    });

    const proc = spawn('rtl_airband', ['-F', '-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', () => {}); // never consumed elsewhere — drain so it can't block rtl_airband on a full pipe
    return { proc, dataStream, socket, voiceSockets };
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

// Stable identity for a dongle config — serial when set (survives reboots/replugs),
// else its legacy device index (defaulting to '0' when absent, matching the single-dongle
// fallback in buildDongleConfigs() — a saved config that never explicitly set `device`,
// e.g. an old flat single-dongle config with blank fields stripped before storage, must
// still resolve to the SAME key as the locally-booted single-dongle pipeline it's meant to
// override, or reconcileDongles would wrongly treat it as a brand new dongle). Used both to
// key the `pipelines` Map and to match server-pushed per-dongle config against its pipeline.
function dongleKey(cfg) {
  return cfg.serial ? `serial:${cfg.serial}` : `device:${cfg.device ?? '0'}`;
}

// Reconciles the live `pipelines` Map against a server-pushed `dongles[]` array —
// starts pipelines for newly-added dongles, stops+removes ones no longer listed, and
// applies config to everything that still matches. Mirrors how the server's own local
// dongles are already fully config-driven (services/sdr.js), just diffed instead of
// torn down and rebuilt wholesale each time.
function reconcileDongles(pipelines, serverDongles) {
  const incomingKeys = new Set(serverDongles.map(dongleKey));

  for (const [key, p] of pipelines) {
    if (!incomingKeys.has(key)) {
      log('info', `Dongle ${key} removed from remote config — stopping`);
      pipelines.delete(key);
      p.stop().catch(() => {});
    }
  }

  for (const d of serverDongles) {
    const key = dongleKey(d);
    const existing = pipelines.get(key);
    if (existing) {
      existing.applyRemoteConfig(d);
    } else {
      log('info', `New dongle ${key} added via remote config — starting`);
      // No local pipeline ever existed for this one — unlike applyRemoteConfig (which
      // merges over an already-running pipeline's env-derived baseCfg), there's nothing to
      // merge over here, so any field the admin left unset would otherwise come through as
      // literally undefined (crashing buildMmonArgs' cfg.protocols.split, etc). Seed it from
      // the same global .env defaults every other dongle on this Pi inherits from.
      const merged = { ...buildGlobalDongleDefaults(), device: String(pipelines.size), ...d, device: String(d.device ?? pipelines.size) };
      const p = createPipeline(merged, pipelines.size);
      pipelines.set(key, p);
      p.start();
    }
  }
}

// One-shot fetch of the server-saved config, awaited before the very first pipeline start.
// Without this, every restart/update briefly spawns rtl_fm/rtl_airband with the Pi's local
// .env defaults (e.g. gain=40) and only picks up the real saved settings once the regular
// poll below catches up — anywhere from 10s to over a minute later if the first poll fails.
async function fetchInitialConfig() {
  try {
    const r = await httpRequest('GET', '/client/config');
    if (r.status === 200 && r.body && r.body.config) return r.body; // { config, version }
  } catch (e) {
    log('debug', `Initial config fetch failed: ${e.message}`);
  }
  return null;
}

async function pollConfig(pipelines) {
  try {
    const list = [...pipelines.values()];
    if (list.length === 0) return;
    const freqs      = list.map(p => p.getCfg().freq).join(':');
    const protocols  = [...new Set(list.map(p => p.getCfg().protocols))].join(' ');
    const sdrRunning = list.every(p => p.isRunning());
    // Per-dongle breakdown so the status bar can show one dot per dongle on this client,
    // same as it already does for the server's own local dongles — the flat freq/protocols/
    // sdrRunning above collapse multiple dongles into one summary and can't drive that.
    const dongleStatuses = list.map(p => {
      const c = p.getCfg();
      return { device: c.device, serial: c.serial || null, label: c.label || null, mode: c.mode || 'single', freq: c.freq, protocols: c.protocols, running: p.isRunning() };
    });
    // Report the full running config of the primary (first-added) dongle so the server UI
    // can show .env values as grey placeholders for fields that have no DB override.
    const mainCfg  = list[0].getCfg();
    const liveCfg  = {
      freq: mainCfg.freq, modulation: mainCfg.modulation,
      sampleRate: mainCfg.sampleRate, gain: mainCfg.gain,
      device: mainCfg.device, ppm: mainCfg.ppm,
      squelch: mainCfg.squelch, resampleRate: mainCfg.resampleRate,
      lowpass: mainCfg.lowpass, tunerBandwidth: mainCfg.tunerBandwidth,
      directSampling: mainCfg.directSampling, offsetTuning: mainCfg.offsetTuning,
      protocols: mainCfg.protocols, verbosity: mainCfg.verbosity,
      quiet: mainCfg.quiet, inputFormat: mainCfg.inputFormat,
      pocsagSpecial: mainCfg.pocsagSpecial, charset: mainCfg.charset, pocsagMode: mainCfg.pocsagMode,
    };
    const hashParam = CLIENT_GIT_HASH ? `&gitHash=${CLIENT_GIT_HASH}` : '';
    // Cheap to re-enumerate every poll cycle (60s) — lets the admin UI show newly-plugged
    // hardware without waiting on anything beyond the next regular poll.
    const detected = await listAttachedDongles();
    const detectedParam = detected.length ? `&detectedDongles=${encodeURIComponent(JSON.stringify(detected))}` : '';
    const dongleStatusesParam = `&dongleStatuses=${encodeURIComponent(JSON.stringify(dongleStatuses))}`;
    const r = await httpRequest('GET', `/client/config?freq=${encodeURIComponent(freqs)}&protocols=${encodeURIComponent(protocols)}&sdrRunning=${sdrRunning}&cfg=${encodeURIComponent(JSON.stringify(liveCfg))}${hashParam}${detectedParam}${dongleStatusesParam}`);
    if (r.status !== 200 || !r.body) return;

    // Handle remote command (one-shot — server clears it after delivery)
    if (r.body.command) handleRemoteCommand(r.body.command);

    if (!r.body.config) return;
    const { config, version } = r.body;
    if (!config || version === globalConfigVersion) return;

    globalOverrideCfg   = config;
    globalConfigVersion = version;

    // A `dongles` array is the full desired dongle set for this client (server resolves
    // airband voiceChannelIds into full channel data before sending, see routes/client.js)
    // — reconciled against the live pipeline Map so dongles can be added/removed from the
    // UI without a full restart. Anything else is the older flat override applied
    // identically to every existing pipeline.
    if (Array.isArray(config.dongles)) {
      log('info', `Remote config updated (v${version}) — reconciling dongle set`);
      reconcileDongles(pipelines, config.dongles);
    } else {
      log('info', `Remote config updated (v${version}) — applying to all dongles`);
      for (const p of pipelines.values()) p.applyRemoteConfig(config);
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
  let voiceUdpSockets = [];
  let stopping = false;
  let restartTimer    = null;
  let consecutiveFails = 0;
  let generation = 0;
  let watchdogTimer   = null;
  let ioPollTimer     = null;
  let pipelineRunning = false;
  const label = `[dongle-${cfg.device}]`;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Waits for a process to actually exit (SIGKILL-escalating after a timeout) rather than
  // just firing SIGTERM and hoping — on slow hardware, rtl_airband's teardown (releasing the
  // USB device, stopping FFT threads) can take longer than a fixed
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
    clearInterval(ioPollTimer);   ioPollTimer   = null;
    try { dataStream?.unpipe(); dataStream?.destroy(); } catch (_) {}
    try { udpSocket?.close(); } catch (_) {}
    try { voiceUdpSockets.forEach(s => s.close()); } catch (_) {}
    const toKill = [mmonProc, rtlProc].filter(Boolean);
    rtlProc = null; mmonProc = null; dataStream = null; udpSocket = null; voiceUdpSockets = [];
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

    const sourceName = cfg.mode === 'airband' ? 'rtl_airband' : 'rtl_fm';
    log('info', `${label} ${sourceName} -d ${cfg.device} -f ${cfg.freq} → multimon-ng ${cfg.protocols}`);

    // Re-resolve the serial into a live device index right before every spawn — this fires
    // on every restart (watchdog- or config-triggered), so it naturally catches USB
    // reordering across replugs without needing a separate periodic re-scan.
    let spawnCfg = cfg;
    if (cfg.serial) {
      const idx = await resolveDeviceIndex(cfg.serial);
      if (stopping || myGen !== generation) return;
      if (idx === null) {
        log('warn', `${label} serial ${cfg.serial} not currently detected — falling back to configured device=${cfg.device ?? 0}`);
      } else {
        spawnCfg = { ...cfg, device: String(idx) };
      }
    }

    try {
      const source = spawnAudioSource(spawnCfg, label);
      rtlProc    = source.proc;
      dataStream = source.dataStream;
      udpSocket  = source.socket || null;
      voiceUdpSockets = source.voiceSockets || [];

      // Liveness/watchdog fed by whichever streams this dongle actually has — the POCSAG
      // leg (when present) and every voice channel (rtl_airband's "continuous = true"
      // output means voice sockets emit steadily regardless of squelch), so this stays
      // reliable even for a voice-only dongle with no POCSAG leg at all.
      let lastDataMs = Date.now();
      const markAlive = () => {
        lastDataMs = Date.now();
        // Only reset backoff once real data actually flows — resetting on spawn alone (as
        // this used to do) meant a process that fails immediately after every spawn (e.g.
        // "device busy") retried at a flat 5s forever instead of backing off, which can
        // itself starve the OS of the time it needs to actually release a stuck USB handle.
        if (!pipelineRunning) { pipelineRunning = true; consecutiveFails = 0; }
      };
      voiceUdpSockets.forEach(vSocket => vSocket.on('message', markAlive));

      // No POCSAG leg (voice-only airband dongle) → no multimon-ng process at all.
      const mmonArgs  = dataStream ? buildMmonArgs(cfg) : null;
      const isAirband = cfg.mode === 'airband';

      // Plain rtl_fm mode: hand multimon-ng rtl_fm's stdout fd directly as its own stdin,
      // giving them a real OS-level pipe with zero Node involvement in the byte stream.
      // Confirmed in the field: routing that audio through a JS .pipe() hop (as below, still
      // needed for airband) — even just one, with nothing else competing for the event loop —
      // was enough scheduling jitter to desync multimon-ng's POCSAG512 bit timing on longer
      // alpha messages (e.g. ones containing a postal address) that an equivalent raw shell
      // `rtl_fm | multimon-ng` pipe on the same hardware/settings decoded cleanly every time;
      // short messages were unaffected. rtl_airband's leg can't use this trick — its
      // dataStream is a PassThrough fed by a hand-rolled UDP resampler, not a real pipe fd.
      mmonProc = dataStream
        ? spawn('multimon-ng', mmonArgs, { stdio: [isAirband ? 'pipe' : dataStream, 'pipe', 'pipe'] })
        : null;

      if (dataStream && mmonProc) {
        dataStream.on('error', () => {});
        if (isAirband) {
          const tap = new PassThrough();
          tap.on('data', markAlive);
          tap.on('error', () => {});
          dataStream.pipe(tap);
          tap.pipe(mmonProc.stdin);
          mmonProc.stdin.on('error', () => {});
        } else {
          // dataStream's fd now belongs to multimon-ng's stdin — nothing left for Node to
          // read 'data' events from, so the liveness watchdog polls multimon-ng's own
          // read-byte counter instead (/proc/<pid>/io's rchar on multimon-ng's PID, not
          // rtl_fm's — rtl_fm pulls USB samples via libusb's ioctl-based URB API, which
          // /proc/pid/io's rchar doesn't count at all, so watching rtl_fm here would read
          // as permanently stalled and force a restart every ~20s even under normal
          // operation. multimon-ng, by contrast, reads its stdin pipe with a plain blocking
          // read(), which rchar always counts.). A read failure (e.g. /proc unavailable on
          // this platform) is treated as "can't tell", not "stalled", so it can't spin up a
          // false restart loop — it just keeps the pipeline marked alive.
          let lastBytesRead = null, ioUnavailableWarned = false;
          ioPollTimer = setInterval(() => {
            if (stopping || myGen !== generation) return;
            let bytesRead = null;
            try {
              const m = /rchar:\s*(\d+)/.exec(fs.readFileSync(`/proc/${mmonProc.pid}/io`, 'utf8'));
              bytesRead = m ? parseInt(m[1], 10) : null;
            } catch (_) {}
            if (bytesRead === null) {
              if (!ioUnavailableWarned) {
                ioUnavailableWarned = true;
                log('warn', `${label} Cannot read /proc/<pid>/io — audio-flow watchdog disabled for this pipeline`);
              }
              markAlive();
              return;
            }
            if (bytesRead !== lastBytesRead) { lastBytesRead = bytesRead; markAlive(); }
          }, 2000);
        }
      }

      watchdogTimer = setInterval(() => {
        if (stopping || myGen !== generation) { clearInterval(watchdogTimer); watchdogTimer = null; return; }
        if (Date.now() - lastDataMs > 20000) {
          clearInterval(watchdogTimer); watchdogTimer = null;
          log('warn', `${label} ${sourceName} watchdog: no audio data for 20s — restarting`);
          if (!stopping) scheduleRestart();
        }
      }, 10000);

      rtlProc.stderr.on('data', d =>
        d.toString().split('\n').forEach(l => { if (l.trim()) log('debug', `${label} ${sourceName}: ${l.trim()}`); })
      );
      if (mmonProc) mmonProc.stderr.on('data', d =>
        d.toString().split('\n').forEach(l => { if (l.trim()) log('debug', `${label} mmon: ${l.trim()}`); })
      );

      let lineBuffer = '';
      if (mmonProc) mmonProc.stdout.on('data', chunk => {
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
            log('info', `${label} [${msg.protocol}] ${msg.capcode}: ${msg.message}`);
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
      if (mmonProc) mmonProc.on('exit', onExit('multimon-ng'));
      rtlProc.on('error',  e => { if (myGen !== generation) return; log('error', `${label} ${sourceName} error: ${e.message}`);  pipelineRunning = false; if (!stopping) scheduleRestart(); });
      if (mmonProc) mmonProc.on('error', e => { if (myGen !== generation) return; log('error', `${label} mmon error: ${e.message}`);     pipelineRunning = false; if (!stopping) scheduleRestart(); });

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
    const newCfg = mergeConfig(baseCfg, remote);
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
// Declared here (not inside main()) so the SIGTERM/SIGINT shutdown handler below can still
// reach them.
const pipelines = new Map();
let configTimer = null;

async function main() {
  log('info', `PagerMonitor Client — ID: ${CLIENT_ID}`);
  log('info', `Server: ${SERVER_URL}`);

  const localConfigs = buildDongleConfigs();

  // Pull the server-saved config before spawning anything — otherwise every dongle boots at
  // the Pi's local .env defaults and only picks up the real saved settings on the next poll
  // cycle. Bounded by httpRequest's own 5s timeout; falls back to local defaults on failure
  // (server unreachable at boot, no saved config yet, etc.) so the client still comes up.
  let dongleConfigs = localConfigs;
  const initial = await fetchInitialConfig();
  if (initial) {
    globalOverrideCfg   = initial.config;
    globalConfigVersion = initial.version;
    if (Array.isArray(initial.config.dongles)) {
      const global = buildGlobalDongleDefaults();
      dongleConfigs = initial.config.dongles.map((d, i) => {
        const local = localConfigs.find(c => dongleKey(c) === dongleKey(d));
        // Mirrors reconcileDongles()'s two merge paths: an already-known dongle merges the
        // server config onto its local .env-derived base, a brand new one merges onto the
        // shared global defaults.
        return local ? mergeConfig(local, d) : { ...global, device: String(i), ...d, device: String(d.device ?? i) };
      });
    } else {
      dongleConfigs = localConfigs.map(c => mergeConfig(c, initial.config));
    }
    log('info', 'Applied saved server config before first start');
  }

  log('info', `Dongles: ${dongleConfigs.length}`);
  dongleConfigs.forEach((c, i) => log('info', `  [${i}] device=${c.device} freq=${c.freq} protocols=${c.protocols}`));

  // Create and start a pipeline per dongle. Keyed by serial (or device index as a legacy
  // fallback) so server-pushed config can add/remove dongles later via reconcileDongles()
  // without needing a full client restart — mirrors the server's own local dongles, which
  // are already fully config-driven.
  for (const cfg of dongleConfigs) pipelines.set(dongleKey(cfg), createPipeline(cfg, pipelines.size));
  for (const p of pipelines.values()) p.start();

  // Config polling — applies to all pipelines
  async function startConfigPolling() {
    await pollConfig(pipelines);
    configTimer = setInterval(() => pollConfig(pipelines), 60_000);
    log('info', 'Remote config polling started (every 60s)');
  }
  setTimeout(startConfigPolling, 10_000);
}

// Voice-channel audio relay — persistent, independent of any specific dongle's lifecycle
connectAudioWs();

main();

// Graceful shutdown — waits (bounded) for pipelines to actually release their SDR devices
// before exiting, so a systemd restart doesn't outrace kill()'s own SIGKILL escalation and
// leave an orphaned rtl_fm/rtl_airband process holding the dongle for the next start.
const shutdown = () => {
  log('info', 'Shutting down...');
  clearInterval(configTimer);
  clearTimeout(audioWsReconnectTimer);
  try { audioWs?.close(); } catch (_) {}
  const stopAll = Promise.all([...pipelines.values()].map(p => p.stop()));
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

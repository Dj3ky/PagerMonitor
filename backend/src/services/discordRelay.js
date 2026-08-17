'use strict';

// Relays a voice channel live into a Discord voice channel via a bot connection —
// subscribes to audioRelay.js the same way a browser or local dongle does, just as an
// internal (non-WebSocket) subscriber instead. One discord.js Client per unique bot
// token (a bot can hold simultaneous voice connections across different guilds; within
// the same guild it can only occupy one channel at a time, so relaying into multiple
// channels on one guild needs multiple bot tokens — see Admin -> Discord Relay).

const { PassThrough } = require('stream');
const logger = require('../utils/logger');

// discord.js/@discordjs/voice pull in native modules (@discordjs/opus, sodium-native) that
// need to compile at install time — on a server where that failed (missing build tools,
// unsupported platform, etc.) requiring them at module load would crash the *entire*
// backend on startup, not just disable this one optional feature. Lazy-load and guard it.
let _deps;
function loadDeps() {
  if (_deps !== undefined) return _deps;
  try {
    _deps = {
      ...require('discord.js'),
      ...require('@discordjs/voice'),
    };
  } catch (e) {
    logger.warn(`Discord relay unavailable — dependencies failed to load: ${e.message}`);
    _deps = null;
  }
  return _deps;
}

const DISCORD_SAMPLE_RATE = 48000;
const SOURCE_SAMPLE_RATE  = 16000; // rtl_airband's native udp_stream rate — same source audioRelay.js already fans out

// Upsamples 16kHz mono float32 -> 48kHz stereo int16 (Discord's required raw PCM format
// for @discordjs/voice's StreamType.Raw, which handles Opus encoding for us from there).
// Same streaming linear-interpolation approach as the POCSAG resamplers in sdr.js/client,
// just targeting a different rate and duplicating mono into both channels.
function createDiscordResampler() {
  const ratio = SOURCE_SAMPLE_RATE / DISCORD_SAMPLE_RATE;
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

    const outBuf = Buffer.alloc(out.length * 4); // 2 bytes/sample * 2 channels
    for (let i = 0; i < out.length; i++) {
      const v = Math.max(-1, Math.min(1, out[i]));
      const s = Math.round(v * 32767);
      outBuf.writeInt16LE(s, i * 4);     // L
      outBuf.writeInt16LE(s, i * 4 + 2); // R
    }
    return outBuf;
  };
}

const clients = new Map(); // botToken -> { client, refCount, ready }
const active  = new Map(); // discord_relays.id -> { connection, player, passThrough, unsubscribe, botToken }

function getOrCreateClient(botToken, deps) {
  let entry = clients.get(botToken);
  if (entry) { entry.refCount++; return entry; }
  const { Client, GatewayIntentBits } = deps;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  entry = { client, refCount: 1, ready: false };
  client.once('ready', () => { entry.ready = true; logger.info(`Discord relay bot logged in as ${client.user.tag}`); });
  client.on('error', (err) => logger.warn(`Discord relay bot error: ${err.message}`));
  client.login(botToken).catch(err => logger.warn(`Discord relay bot login failed: ${err.message}`));
  clients.set(botToken, entry);
  return entry;
}

function releaseClient(botToken) {
  const entry = clients.get(botToken);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    try { entry.client.destroy(); } catch (_) {}
    clients.delete(botToken);
  }
}

async function waitForReady(entry) {
  if (entry.ready) return;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bot login timed out')), 20_000);
    entry.client.once('ready', () => { clearTimeout(t); resolve(); });
  });
}

// A relay can cover more than one voice_channels entry — only the actively-transmitting
// one gets relayed, so two simultaneous transmissions don't garble together. With a single
// channel this is a no-op (current never changes, no polling needed) — same as the old
// behavior. Unlike the browser player's auto-listen (LiveChannels.jsx), this doesn't add
// its own grace period before handing off — audioRelay.js's own ACTIVITY_HANG_MS (800ms)
// already debounces brief mid-transmission pauses upstream, so a relay-side grace period on
// top of that is redundant and actively harmful here: radio traffic on a given channel is
// often short and sparse, and a several-second "wait and see if it resumes" window meant for
// a human listener routinely eats an entire brief transmission on a different channel while
// waiting — which looked like "only my busiest source ever comes through" in practice.
function createChannelSelector(channelIds, audioRelay, onChange) {
  let current = channelIds.length === 1 ? channelIds[0] : null;
  let poll = null;
  if (channelIds.length > 1) {
    poll = setInterval(() => {
      const activeSet = audioRelay.getActiveChannels();
      if (current != null && activeSet[current]) return; // still talking — stay put
      const next = channelIds.find(id => activeSet[id]) ?? null;
      if (next !== current) { current = next; onChange?.(current, activeSet); }
    }, 250);
  }
  return {
    isSelected: (id) => channelIds.length === 1 || current === id,
    stop: () => { if (poll) clearInterval(poll); },
  };
}

// Best-effort bot status showing which channels this relay covers, with a live-counting
// "connected since" timer (Discord renders timestamps.start itself — no repeated updates
// needed). Presence is per bot *account*, not per-guild, so relays sharing one bot_token
// will overwrite each other's status; harmless, just cosmetic, last one wins.
function setRelayActivity(client, channelIds, deps) {
  try {
    const { getVoiceChannelById } = require('./database');
    const labels = channelIds.map(id => getVoiceChannelById(id)?.description || `#${id}`);
    client.user.setPresence({
      activities: [{ name: labels.join(', '), type: deps.ActivityType.Listening, timestamps: { start: Date.now() } }],
    });
  } catch (_) {}
}

async function startRelay(row, deps) {
  const label = row.description || `relay ${row.id}`;
  const entry = getOrCreateClient(row.bot_token, deps);
  const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType,
          VoiceConnectionStatus, entersState } = deps;
  const channelIds = Array.isArray(row.channel_ids) && row.channel_ids.length ? row.channel_ids : [row.voice_channel_id];
  let connection;
  try {
    await waitForReady(entry);

    const guild = await entry.client.guilds.fetch(row.guild_id);
    connection = joinVoiceChannel({
      channelId: row.discord_channel_id,
      guildId: row.guild_id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

    const passThrough = new PassThrough();
    const resource = createAudioResource(passThrough, { inputType: StreamType.Raw });
    const player = createAudioPlayer();
    player.play(resource);
    connection.subscribe(player);
    // TEMPORARY diagnostic — @discordjs/voice's AudioPlayer state (Idle/Buffering/Playing/
    // AutoPaused/Paused). Selection can be correct while this never reaches "Playing", or
    // gets stuck AutoPaused after a silent gap instead of resuming on the next write.
    player.on('stateChange', (oldS, newS) => {
      logger.warn(`Discord relay "${label}" diag: player state ${oldS.status} -> ${newS.status}`);
    });

    const audioRelay = require('./audioRelay');
    const selector = createChannelSelector(channelIds, audioRelay, (newCurrent, activeSet) => {
      logger.warn(`Discord relay "${label}" diag: selector switched to channel ${newCurrent}, activeSet=${JSON.stringify(activeSet)}`);
    });
    // Each channel keeps its own resampler instance (rather than sharing one across the
    // group) so a mid-stream hand-off doesn't carry over stale interpolation state from
    // whichever channel was previously selected.
    const resamplers = new Map(channelIds.map(id => [id, createDiscordResampler()]));
    // TEMPORARY diagnostic — logs at most once every 5s per channel, showing whether audio
    // is actually arriving from audioRelay.js at all (vs. arriving but not selected). Remove
    // once the "some channels never come through" issue is root-caused.
    const lastDiagLog = new Map();
    const unsubscribes = channelIds.map(chId => audioRelay.subscribeChannel(chId, (payload) => {
      const now = Date.now();
      if (!lastDiagLog.has(chId) || now - lastDiagLog.get(chId) > 5000) {
        lastDiagLog.set(chId, now);
        logger.warn(`Discord relay "${label}" diag: channel ${chId} got ${payload.length}B payload, selected=${selector.isSelected(chId)}`);
      }
      const pcm = resamplers.get(chId)(payload);
      if (!selector.isSelected(chId)) return;
      if (pcm.length) {
        try {
          const ok = passThrough.write(pcm);
          if (!lastDiagLog.has(`w${chId}`) || now - lastDiagLog.get(`w${chId}`) > 5000) {
            lastDiagLog.set(`w${chId}`, now);
            logger.warn(`Discord relay "${label}" diag: wrote ${pcm.length}B to passThrough for channel ${chId}, write()=${ok}, player state=${player.state.status}`);
          }
        } catch (e) { logger.warn(`Discord relay "${label}" diag: passThrough.write threw: ${e.message}`); }
      }
    }));
    const unsubscribe = () => { unsubscribes.forEach(u => { try { u(); } catch (_) {} }); selector.stop(); };

    setRelayActivity(entry.client, channelIds, deps);

    active.set(row.id, { connection, player, passThrough, unsubscribe, botToken: row.bot_token });
    logger.info(`Discord relay "${label}" connected — channel(s) ${channelIds.join(',')} -> guild ${row.guild_id}/${row.discord_channel_id}`);

    // Guards against connection-error, player-error, and a failed Disconnected
    // self-heal all firing for the same drop and stacking up multiple retries.
    let retrying = false;
    const retry = (reason) => {
      if (retrying) return;
      retrying = true;
      logger.warn(`Discord relay "${label}": ${reason}, retrying in 10s`);
      stopRelay(row.id);
      setTimeout(() => { startRelay(row, deps).catch(e => logger.warn(`Discord relay "${label}" retry failed: ${e.message}`)); }, 10_000);
    };

    // Both emit 'error' when something in the voice/audio pipeline hiccups (Opus
    // encoding glitch, UDP handshake issue, etc). An EventEmitter's 'error' event
    // with no listener throws and crashes the whole process — an unhandled error
    // here was previously taking down the entire backend a few seconds after
    // every relay start, which looked like "bot connects then vanishes forever".
    connection.on('error', (err) => retry(`connection error: ${err.message}`));
    player.on('error', (err) => retry(`player error: ${err.message}`));

    // Discord voice connections drop briefly and reconnect on their own fairly often —
    // give it a moment to self-heal before tearing down and retrying from scratch.
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        retry('lost connection');
      }
    });
  } catch (e) {
    // joinVoiceChannel() can succeed (signaling) while the later Ready wait times
    // out (UDP handshake never completes) — without destroy() that leaves the bot
    // dangling in the channel with nothing managing or retrying it.
    if (connection) { try { connection.destroy(); } catch (_) {} }
    releaseClient(row.bot_token);
    logger.warn(`Discord relay "${label}" failed to start: ${e.message}`);
  }
}

function stopRelay(id) {
  const entry = active.get(id);
  if (!entry) return;
  try { entry.unsubscribe(); } catch (_) {}
  try { entry.passThrough.end(); } catch (_) {}
  try { entry.player.stop(); } catch (_) {}
  try { entry.connection.destroy(); } catch (_) {}
  active.delete(id);
  releaseClient(entry.botToken);
}

// Tears down and rebuilds every relay from the current DB state. Simple and robust —
// this only runs on real config changes (admin save/delete) or startup, not per-frame,
// so the brief interruption to already-healthy relays is an acceptable tradeoff for
// avoiding hand-rolled incremental-diff bugs.
async function reconcile() {
  for (const id of [...active.keys()]) stopRelay(id);

  const { getAllDiscordRelays } = require('./database');
  const rows = getAllDiscordRelays().filter(r => r.enabled);
  if (rows.length === 0) return; // nothing configured — skip loading the heavy deps entirely

  const deps = loadDeps();
  if (!deps) return; // dependencies unavailable — feature silently disabled, already logged once
  for (const row of rows) await startRelay(row, deps);
}

function init() {
  reconcile().catch(err => logger.warn(`Discord relay init failed: ${err.message}`));
}

module.exports = { init, reconcile };

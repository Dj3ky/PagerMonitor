'use strict';
// Standalone diagnostic — connects the "TST15" Discord relay bypassing the normal
// service/journald path, with every available @discordjs/voice signal wired to
// console.log so nothing gets lost. Run directly: node scratch_voice_debug.js
// Delete this file once the voice-connect issue is root-caused.

require('dotenv').config();
const db = require('./src/services/database');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');

process.on('uncaughtException', (e) => console.log('[UNCAUGHT]', e));
process.on('unhandledRejection', (e) => console.log('[UNHANDLED REJECTION]', e));

async function main() {
  db.initDb();
  const rows = db.getAllDiscordRelays().filter(r => r.enabled);
  const row = rows.find(r => (r.description || '').includes('TST15')) || rows[0];
  if (!row) { console.log('No enabled relay rows found in DB'); process.exit(1); }
  console.log('Using relay row:', { id: row.id, description: row.description, guild_id: row.guild_id, discord_channel_id: row.discord_channel_id });

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  client.on('debug', (m) => console.log('[CLIENT DEBUG]', m));
  client.on('error', (e) => console.log('[CLIENT ERROR]', e));

  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.login(row.bot_token).catch(reject);
  });
  console.log('Logged in as', client.user.tag);

  const guild = await client.guilds.fetch(row.guild_id);
  const connection = joinVoiceChannel({
    channelId: row.discord_channel_id,
    guildId: row.guild_id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    debug: true,
  });

  connection.on('debug', (m) => console.log('[CONN DEBUG]', m));
  connection.on('error', (e) => console.log('[CONN ERROR]', e));
  connection.on('stateChange', (oldS, newS) => console.log('[STATE]', oldS.status, '->', newS.status, JSON.stringify(newS.reason !== undefined ? { reason: newS.reason } : {})));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log('CONNECTED — Ready reached successfully');
  } catch (e) {
    console.log('FAILED to reach Ready:', e.message);
  }

  setTimeout(() => process.exit(0), 3000);
}

main().catch((e) => { console.log('[MAIN ERROR]', e); process.exit(1); });

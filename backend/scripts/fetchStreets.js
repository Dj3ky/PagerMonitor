#!/usr/bin/env node
'use strict';

/**
 * Download named street ways from Overpass in tiles, with automatic resume.
 *
 * Large countries (see geoBounds.STREET_GRID_SIZE) are split into an N x N grid of
 * areas and fetched one at a time — a single whole-country query for e.g. France
 * routinely gets rejected by Overpass's public instances (oversized response /
 * server-side timeout) even with a raised maxsize. Smaller countries still use a
 * single "tile" covering the whole bbox, same as before.
 *
 * Progress is saved after every successful tile in:
 *   backend/data/<cc>_streets.progress.json
 * so an interrupted run (network drop, closed browser tab, restart) resumes from
 * the last completed tile instead of starting over.
 *
 * Final output:
 *   backend/data/<cc>_streets.json
 *
 * Usage:
 *   node scripts/fetchStreets.js [cc]        (default: si)
 *   node scripts/fetchStreets.js fr --reset  (discard saved progress, start over)
 *
 * Requires Node >=18. Single-tile countries: ~30-90s. Tiled countries (e.g. France,
 * 64 tiles): can take a long time depending on Overpass load and retries — safe to
 * interrupt and re-run, it picks up where it left off.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { BBOXES, STREET_GRID_SIZE, parseBbox, formatBbox, makeTiles } = require('./geoBounds');

// Country code from the first non-flag argument (e.g. "node fetchStreets.js de",
// or "node fetchStreets.js --reset de" — flag order shouldn't matter).
const CC = (process.argv.slice(2).find(a => !a.startsWith('-')) || 'si')
  .toLowerCase()
  .replace(/[^a-z]/g, '')
  .slice(0, 2);
const RESET = process.argv.includes('--reset');

if (!BBOXES[CC]) {
  console.error(`Unknown country code: ${CC}. Add a bbox to geoBounds.js or check the code.`);
  process.exit(1);
}

const GRID = STREET_GRID_SIZE[CC] || 1;
const ENDPOINTS = [
  'overpass-api.de',
  'overpass.kumi.systems',
  'overpass.openstreetmap.fr',
];

const REQUEST_TIMEOUT_MS       = 135000;
const TILE_PAUSE_MS            = 5000;
const MAX_ATTEMPTS_PER_ENDPOINT = 3;
const NORMAL_RETRY_BASE_MS     = 5000;
const RATE_LIMIT_DELAY_MS      = 60000;

const OUT      = path.join(__dirname, `../data/${CC}_streets.json`);
const PROGRESS = path.join(__dirname, `../data/${CC}_streets.progress.json`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function postOverpass(host, query) {
  return new Promise((resolve, reject) => {
    const body = `data=${encodeURIComponent(query)}`;

    const request = https.request({
      hostname: host,
      path: '/api/interpreter',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'PagerMonitor-fetchStreets/1.0',
        'Accept': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        const retryAfter = response.headers['retry-after'];

        if (response.statusCode !== 200) {
          const suffix = retryAfter ? `; Retry-After: ${retryAfter}` : '';
          return reject(new Error(`HTTP ${response.statusCode} from ${host}${suffix}`));
        }

        let json;
        try {
          json = JSON.parse(text);
        } catch (error) {
          return reject(new Error(`JSON parse error from ${host}: ${error.message}`));
        }

        if (json.remark && !Array.isArray(json.elements)) {
          return reject(new Error(json.remark));
        }

        resolve(json);
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Timeout on ${host}`));
    });

    request.write(body);
    request.end();
  });
}

async function fetchTile(tile, index, total) {
  const bbox = formatBbox(tile);
  const query = `[out:json][timeout:120][maxsize:1073741824];
way["highway"]["name"](${bbox});
out tags;`;

  console.log(`\nTile ${index}/${total}: ${bbox}`);

  for (const host of ENDPOINTS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ENDPOINT; attempt++) {
      process.stdout.write(`  ${host}, attempt ${attempt}/${MAX_ATTEMPTS_PER_ENDPOINT} ... `);

      try {
        const json = await postOverpass(host, query);
        const elements = Array.isArray(json.elements) ? json.elements : [];
        const names = elements
          .map(element => element.tags?.name)
          .filter(name => typeof name === 'string' && name.trim().length > 2)
          .map(name => name.trim());

        console.log(`OK (${elements.length} ways, ${names.length} names)`);
        return names;
      } catch (error) {
        console.log(error.message);
        if (attempt < MAX_ATTEMPTS_PER_ENDPOINT) {
          // Same rate-limit-aware backoff as fetchPlaces.js — a public Overpass
          // instance returning HTTP 429 needs its own cooldown honored, not just a
          // slightly longer version of the normal retry delay, or repeated hammering
          // risks a longer or harder ban.
          const isRateLimited = error.message.includes('HTTP 429');
          const retryAfterMatch = error.message.match(/Retry-After:\s*(\d+)/i);
          const retryAfterMs = retryAfterMatch ? Number(retryAfterMatch[1]) * 1000 : RATE_LIMIT_DELAY_MS;
          const delay = isRateLimited
            ? Math.max(RATE_LIMIT_DELAY_MS, retryAfterMs)
            : NORMAL_RETRY_BASE_MS * 2 ** (attempt - 1);
          console.log(`  Waiting ${delay / 1000}s before retry...`);
          await sleep(delay);
        }
      }
    }
  }

  throw new Error(`All endpoints and retries failed for tile ${index}`);
}

function loadProgress() {
  if (RESET || !fs.existsSync(PROGRESS)) {
    return { nextTile: 0, names: [] };
  }

  try {
    const progress = JSON.parse(fs.readFileSync(PROGRESS, 'utf8'));
    if (!Number.isInteger(progress.nextTile) || !Array.isArray(progress.names)) {
      throw new Error('invalid progress format');
    }
    return progress;
  } catch (error) {
    console.warn(`Progress file ignored: ${error.message}`);
    return { nextTile: 0, names: [] };
  }
}

function saveProgress(progress) {
  const temporary = `${PROGRESS}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(progress));
  fs.renameSync(temporary, PROGRESS);
}

async function main() {
  const tiles = makeTiles(parseBbox(BBOXES[CC]), GRID, GRID);
  const progress = loadProgress();
  const names = new Set(progress.names);

  if (progress.nextTile > 0) {
    console.log(`Resuming at tile ${progress.nextTile + 1}/${tiles.length}`);
    console.log(`Loaded ${names.size} saved street names`);
  } else {
    console.log(`Starting ${tiles.length}-tile download for [${CC.toUpperCase()}]`);
  }

  for (let index = progress.nextTile; index < tiles.length; index++) {
    const tileNames = await fetchTile(tiles[index], index + 1, tiles.length);

    for (const name of tileNames) {
      names.add(name);
    }

    progress.nextTile = index + 1;
    progress.names = [...names];
    saveProgress(progress);

    console.log(`  Saved checkpoint: tile ${progress.nextTile}/${tiles.length}`);
    console.log(`  Unique names so far: ${names.size}`);

    if (index < tiles.length - 1) {
      await sleep(TILE_PAUSE_MS);
    }
  }

  const result = [...names].sort((a, b) => a.localeCompare(b, CC));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result));

  fs.unlinkSync(PROGRESS);
  console.log(`\nSaved ${result.length} unique street names to ${OUT}`);
  console.log('Download complete; progress file removed.');
}

main().catch(error => {
  console.error(`\nError: ${error.message}`);
  console.error('Progress is preserved. Re-run the same command to resume.');
  process.exit(1);
});

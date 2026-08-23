#!/usr/bin/env node
'use strict';

/**
 * Download named settlements and municipality centres from Overpass in tiles, with
 * automatic resume.
 *
 * Large countries (see geoBounds.PLACE_GRID_SIZE) are split into an N x N grid of
 * areas. Queries are deliberately sequential — municipality query first, then
 * settlement query — to avoid sending two requests at once to public Overpass
 * instances. Smaller countries still use a single "tile" covering the whole bbox,
 * same as before.
 *
 * Progress is saved after every completed tile:
 *   backend/data/<cc>_places.progress.json
 *
 * Final output:
 *   backend/data/<cc>_places.json
 *
 * Usage from backend/:
 *   node scripts/fetchPlaces.js [cc]        (default: si)
 *   node scripts/fetchPlaces.js fr --reset  (discard saved progress, start over)
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { BBOXES, PLACE_GRID_SIZE, MUNI_LEVELS, parseBbox, formatBbox, makeTiles } = require('./geoBounds');

// Country code from the first non-flag argument — flag order shouldn't matter
// ("node fetchPlaces.js fr --reset" and "node fetchPlaces.js --reset fr" are equivalent).
const CC = (process.argv.slice(2).find(a => !a.startsWith('-')) || 'si')
  .toLowerCase()
  .replace(/[^a-z]/g, '')
  .slice(0, 2);
const RESET = process.argv.includes('--reset');

if (!BBOXES[CC]) {
  console.error(`Unknown country code: ${CC}`);
  process.exit(1);
}

const GRID = PLACE_GRID_SIZE[CC] || 1;
const ENDPOINTS = [
  'overpass-api.de',
  'overpass.kumi.systems',
  'overpass.openstreetmap.fr',
];

const REQUEST_TIMEOUT_MS        = 195000;
const MAX_ATTEMPTS_PER_ENDPOINT = 3;
const NORMAL_RETRY_BASE_MS      = 10000;
const RATE_LIMIT_DELAY_MS       = 60000;
const BETWEEN_QUERIES_MS        = 10000;
const BETWEEN_TILES_MS          = 10000;

const OUT       = path.join(__dirname, `../data/${CC}_places.json`);
const PROGRESS  = path.join(__dirname, `../data/${CC}_places.progress.json`);
const muniLevel = MUNI_LEVELS[CC] || '8';

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
        'User-Agent': 'PagerMonitor-fetchPlaces/1.0',
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

async function fetchQuery(query, label) {
  for (const host of ENDPOINTS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ENDPOINT; attempt++) {
      process.stdout.write(`  [${label}] ${host}, attempt ${attempt}/${MAX_ATTEMPTS_PER_ENDPOINT} ... `);

      try {
        const json = await postOverpass(host, query);
        console.log(`OK (${json.elements?.length || 0} elements)`);
        return json;
      } catch (error) {
        console.log(error.message);

        const isRateLimited = error.message.includes('HTTP 429');
        const retryAfterMatch = error.message.match(/Retry-After:\s*(\d+)/i);
        const retryAfterMs = retryAfterMatch
          ? Number(retryAfterMatch[1]) * 1000
          : RATE_LIMIT_DELAY_MS;
        const delay = isRateLimited
          ? Math.max(RATE_LIMIT_DELAY_MS, retryAfterMs)
          : NORMAL_RETRY_BASE_MS * attempt;

        if (attempt < MAX_ATTEMPTS_PER_ENDPOINT) {
          console.log(`  Waiting ${delay / 1000}s before retry...`);
          await sleep(delay);
        }
      }
    }
  }

  throw new Error(`All Overpass endpoints failed for ${label}`);
}

function loadProgress() {
  if (RESET || !fs.existsSync(PROGRESS)) {
    return { nextTile: 0, municipalities: [], settlements: [] };
  }

  try {
    const progress = JSON.parse(fs.readFileSync(PROGRESS, 'utf8'));

    if (!Number.isInteger(progress.nextTile) ||
        !Array.isArray(progress.municipalities) ||
        !Array.isArray(progress.settlements)) {
      throw new Error('invalid progress format');
    }

    return progress;
  } catch (error) {
    console.warn(`Ignoring invalid progress file: ${error.message}`);
    return { nextTile: 0, municipalities: [], settlements: [] };
  }
}

function saveProgress(progress) {
  const temporary = `${PROGRESS}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(progress));
  fs.renameSync(temporary, PROGRESS);
}

function addMunicipalities(progress, elements) {
  const existing = new Map(progress.municipalities.map(item => [item.key, item]));

  for (const element of elements || []) {
    if (element.type !== 'relation' || !element.tags?.name || !element.center) continue;

    const key = String(element.id ||
      `${element.tags.name}:${element.center.lat}:${element.center.lon}`);

    existing.set(key, {
      key,
      name: element.tags.name,
      lat: element.center.lat,
      lng: element.center.lon,
    });
  }

  progress.municipalities = [...existing.values()];
}

function addSettlements(progress, elements) {
  const existing = new Map(progress.settlements.map(item => [item.key, item]));

  for (const element of elements || []) {
    const name = element.tags?.name;
    if (!name || typeof element.lat !== 'number' || typeof element.lon !== 'number') continue;

    const key = String(element.id || `${name}:${element.lat}:${element.lon}`);

    existing.set(key, {
      key,
      name,
      tags: element.tags || {},
      lat: element.lat,
      lng: element.lon,
    });
  }

  progress.settlements = [...existing.values()];
}

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestMuni(lat, lon, munis) {
  let best = null;
  let bestDistance = Infinity;

  for (const muni of munis) {
    const distance = distKm(lat, lon, muni.lat, muni.lng);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = muni;
    }
  }

  return best;
}

async function main() {
  const tiles = makeTiles(parseBbox(BBOXES[CC]), GRID, GRID);
  const progress = loadProgress();

  console.log(`Fetching place data for [${CC.toUpperCase()}]`);
  console.log(`Using ${tiles.length} tile(s)`);
  console.log(`Output: ${OUT}`);

  if (progress.nextTile > 0) {
    console.log(`Resuming at tile ${progress.nextTile + 1}/${tiles.length}`);
    console.log(`Loaded ${progress.municipalities.length} municipalities and ${progress.settlements.length} settlements`);
  }

  for (let index = progress.nextTile; index < tiles.length; index++) {
    const bbox = formatBbox(tiles[index]);
    const muniQuery = `[out:json][timeout:60][maxsize:536870912];
rel["admin_level"="${muniLevel}"]["name"](${bbox});
out center tags;`;
    const placeQuery = `[out:json][timeout:180][maxsize:1073741824];
node["place"~"^(city|town|village|hamlet|suburb)$"]["name"](${bbox});
out body;`;

    console.log(`\nTile ${index + 1}/${tiles.length}: ${bbox}`);

    const muniJson = await fetchQuery(muniQuery, 'municipalities');
    addMunicipalities(progress, muniJson.elements);
    await sleep(BETWEEN_QUERIES_MS);

    const placeJson = await fetchQuery(placeQuery, 'settlements');
    addSettlements(progress, placeJson.elements);

    progress.nextTile = index + 1;
    saveProgress(progress);

    console.log(`  Saved checkpoint: tile ${progress.nextTile}/${tiles.length}`);
    console.log(`  Municipalities: ${progress.municipalities.length}`);
    console.log(`  Settlements: ${progress.settlements.length}`);

    if (index < tiles.length - 1) {
      await sleep(BETWEEN_TILES_MS);
    }
  }

  const munis = progress.municipalities.map(({ key, ...item }) => item);
  const places = [];

  for (const settlement of progress.settlements) {
    const municipality =
      settlement.tags['addr:municipality'] ||
      settlement.tags['is_in:municipality'] ||
      nearestMuni(settlement.lat, settlement.lng, munis)?.name;

    if (municipality) {
      places.push({
        name: settlement.name,
        municipality,
        lat: settlement.lat,
        lng: settlement.lng,
      });
    }
  }

  places.sort((a, b) =>
    a.name.localeCompare(b.name, CC) ||
    a.municipality.localeCompare(b.municipality, CC) ||
    a.lat - b.lat ||
    a.lng - b.lng,
  );

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(places));
  fs.unlinkSync(PROGRESS);

  console.log(`\nSaved ${places.length} settlement entries to ${OUT}`);
  console.log('Download complete; progress file removed.');
}

main().catch(error => {
  console.error(`\nError: ${error.message}`);
  console.error('Progress is preserved. Re-run the same command to resume.');
  process.exit(1);
});

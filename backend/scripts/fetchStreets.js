#!/usr/bin/env node
'use strict';

/**
 * Downloads all named street ways within the given country's bounding box from
 * the Overpass API and saves a deduplicated, sorted JSON array to
 * backend/data/<cc>_streets.json.
 *
 * Usage:
 *   node backend/scripts/fetchStreets.js [cc]   (default: si)
 *
 * Requires Node >=18. Takes ~30-90 s depending on network.
 */

const fs   = require('fs');
const path = require('path');
const http = require('https');

// Country code from CLI argument (e.g. "node fetchStreets.js de")
const CC = (process.argv[2] || 'si').toLowerCase().replace(/[^a-z]/g, '').slice(0, 2);

const BBOXES = {
  si: '45.42,13.38,46.88,16.61',
  hr: '42.39,13.49,46.55,19.45',
  de: '47.27,5.87,55.06,15.04',
  at: '46.37,9.53,49.02,17.16',
  it: '35.49,6.63,47.10,18.52',
  ch: '45.82,5.96,47.81,10.49',
  fr: '41.34,-5.14,51.09,9.56',
  gb: '49.87,-8.62,60.86,1.77',
  pl: '49.00,14.12,54.84,24.15',
  hu: '45.74,16.11,48.59,22.90',
  nz: '-47.35,166.43,-34.35,178.55',
  au: '-43.74,113.34,-10.41,153.64',
  ca: '41.68,-141.00,83.11,-52.64',
  us: '24.52,-124.77,49.38,-66.95',
};
if (!BBOXES[CC]) { console.error(`Unknown country code: ${CC}. Add a bbox to BBOXES or check the code.`); process.exit(1); }
const BBOX = BBOXES[CC];
const OUT  = path.join(__dirname, `../data/${CC}_streets.json`);

const QUERY = `[out:json][timeout:120][bbox:${BBOX}];
way["highway"]["name"];
out tags;`;

const ENDPOINTS = [
  'overpass-api.de',
  'overpass.kumi.systems',
  'overpass.openstreetmap.fr',
];

function postOverpass(host, query) {
  return new Promise((resolve, reject) => {
    const body = `data=${encodeURIComponent(query)}`;
    const req  = http.request(
      {
        hostname: host,
        path:     '/api/interpreter',
        method:   'POST',
        headers: {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent':     'PagerMonitor-fetchStreets/1.0',
          'Accept':         'application/json',
        },
        timeout: 130_000, // a bit above the [timeout:120] query hint so the server's own cutoff wins the race
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${host}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        });
      },
    );
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout on ${host}`)); });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`Fetching street data for [${CC.toUpperCase()}] from Overpass API...`);
  console.log(`bbox: ${BBOX}\n`);

  let json = null;
  for (const host of ENDPOINTS) {
    process.stdout.write(`Trying ${host} ... `);
    try {
      json = await postOverpass(host, QUERY);
      console.log('OK');
      break;
    } catch (e) {
      console.log(e.message);
    }
  }

  if (!json?.elements?.length) {
    console.error('\nAll endpoints failed or returned no data.');
    process.exit(1);
  }

  const names = [...new Set(
    json.elements
      .map(e => e.tags?.name)
      .filter(n => typeof n === 'string' && n.trim().length > 2),
  )].sort((a, b) => a.localeCompare(b, CC));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(names));
  const rel = path.relative(process.cwd(), OUT);
  console.log(`\nSaved ${names.length} unique street names to ${rel}`);
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });

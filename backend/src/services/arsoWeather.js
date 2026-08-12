'use strict';
// ARSO (Slovenian environment agency) weather data — current conditions from the
// full 96-station automatic network, 15-region 5-day forecast, and CAP warnings.
const { XMLParser } = require('fast-xml-parser');
const { getSetting } = require('./database');
const logger = require('../utils/logger');

const BASE = 'https://meteo.arso.gov.si/uploads/probase/www';
const CURRENT_HEAD_BYTES  = 20000;    // comfortably covers the newest 1-2 metData entries
const BACKFILL_HEAD_BYTES = 1500000;  // ~150 entries (~25h @ 10-min interval) — one-time only, at startup
const REFRESH_MS = 10 * 60 * 1000; // matches the AMS network's own 10-min update cadence
const STATION_CONCURRENCY = 6;     // be polite to ARSO + gentle on Pi-class hardware

// Full automatic weather station network (meteosiId, minus trailing underscore).
// Each station publishes a rolling 2-day/10-min history file — we only ever
// need the tail of it, fetched via HTTP Range so we don't pull the whole
// multi-MB file on every refresh.
const STATION_IDS = [
  'AJDOV-INA_DOLENJE', 'BABNO-POL', 'BLEGOS', 'BOHIN-CES', 'BORST_GOREN-VAS',
  'BOVEC', 'BREGINJ', 'BUKOV-VRH', 'CELJE', 'CERKN-JEZ', 'GACNIK', 'GODNJE',
  'GORICKO_KRAJI-PAR', 'GORNJ-GRA', 'HOCKO-POH', 'HRASTNIK', 'IDRIJA_CISTI-NAP',
  'ILIRS-BIS', 'ISKRBA', 'JERONIM', 'JERUZ-LEM', 'JEZERSKO', 'KAMNI-BIS', 'KANIN',
  'KOCEVJE', 'KOPER_LUKA', 'KOREN-SED', 'KRANJ', 'KREDA-ICA', 'KRVAVEC', 'KUBED',
  'KUM', 'LESCE', 'LISCA', 'LITIJA_GRBIN', 'LJUBL-ANA_BEZIGRAD', 'LJUBL-ANA_BRNIK',
  'LJUBL-ANA_VIC', 'LOGAR-DOL', 'LOGATEC', 'MALKOVEC', 'MARIBOR_SLIVNICA',
  'MARIBOR_VRBAN-PLA', 'MARIN-VAS', 'METLIKA', 'MEZICA', 'MIKLAVZ_NA-GOR',
  'MURSK-SOB', 'NANOS', 'NOVA-GOR_BILJE', 'NOVA-GOR', 'NOVA-VAS_BLOKE', 'NOVO-MES',
  'OSILNICA', 'OTLICA', 'PASJA-RAV', 'PAVLI-SED', 'PIRAN_OCEAN-BOJ', 'PLANI-POD',
  'PODCE-TEK_ATOMS-TOP', 'PODNANOS', 'PORTOROZ_SECOVLJE', 'POSTOJNA', 'PREDEL',
  'PTUJ', 'RADEG-NDA', 'RATECE', 'RATIT-VEC', 'ROGAS-SLA', 'ROGLA', 'RUDNO-POL',
  'SEBRE-VRH', 'SEVNO', 'SKOCJAN', 'SLAVNIK', 'SLOVE-GRA', 'SLOVE-KON', 'SVISCAKI',
  'TATRE', 'TOLMIN_VOLCE', 'TOPOL', 'TRBOVLJE', 'TREBNJE', 'TRIJE-KRA_NA-POH',
  'TROJANE_LIMOVCE', 'URSLJ-GOR', 'VEDRIJAN', 'VELENJE', 'VELIK-LAS', 'VOGEL',
  'VRHNIKA', 'VRSIC', 'ZADLOG', 'ZELENICA', 'ZGORN-KAP', 'ZGORN-RAD',
];

const WARNING_REGIONS = ['SOUTH-EAST', 'SOUTH-WEST', 'MIDDLE', 'NORTH-EAST', 'NORTH-WEST'];
const SEVERITY_COLOR = { 2: 'yellow', 3: 'orange', 4: 'red' };

const parser = new XMLParser({
  ignoreAttributes: true,
  htmlEntities: true, // ARSO XML uses numeric char refs (&#382; etc.) for diacritics
  // 'polygon' forced to array too: each <area> carries a real polygon plus a
  // second, empty <polygon/> — without this, fast-xml-parser keeps only the
  // last occurrence (the empty one), silently discarding the coordinates.
  isArray: (name) => ['metData', 'info', 'parameter', 'area', 'polygon'].includes(name),
});

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// ARSO's own "…_UTC" fields look like "03.08.2026 14:10 UTC" — parse straight
// to an epoch, avoiding any ambiguity from the CEST/CET-suffixed local fields.
function parseArsoUtc(str) {
  const m = typeof str === 'string' && str.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mo, yyyy, hh, mi] = m;
  return Date.UTC(+yyyy, +mo - 1, +dd, +hh, +mi);
}

let cache = {
  current:  { stations: [], updatedAt: null },
  forecast: { regions: [],  updatedAt: null },
  warnings: { alerts: [], regions: [], updatedAt: null },
};
let timer = null;

async function fetchText(url, headers) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Current conditions ─────────────────────────────────────────────────────
function mapStation(m) {
  const lat = num(m.domain_lat), lon = num(m.domain_lon);
  if (lat === null || lon === null) return null;
  return {
    id:            (m.domain_meteosiId || '').replace(/_+$/, ''),
    name:          m.domain_longTitle || m.domain_title || m.domain_shortTitle,
    lat, lon,
    altitude:      num(m.domain_altitude),
    tempC:         num(m.t),
    dewPointC:     num(m.td),
    humidity:      num(m.rh),
    windDirDeg:    num(m.dd_val),
    windDirText:   m.dd_shortText || m.ddavg_shortText || null,
    windSpeedKmh:  num(m.ff_val_kmh),
    gustKmh:       num(m.ffmax_val_kmh),
    pressureMsl:   num(m.msl),
    precip24hMm:   num(m.tp_24h_acc) ?? num(m.rr24h_val),
    precipIntervalMm: num(m.rr_val),
    snowCm:        num(m.snow),
    visibilityKm:  num(m.vis_val) ?? num(m.vis_value),
    icon:          m['nn_icon-wwsyn_icon'] || m.nn_icon || null,
    conditionText: m.nn_shortText || m.wwsyn_shortText || null,
    updated:       m.valid || m.tsValid_issued || null,
    updatedMs:     parseArsoUtc(m.valid_UTC || m.tsValid_issued_UTC),
  };
}

// Fetches the HEAD of a station's rolling history file and returns every
// complete metData entry found in it, newest → oldest — ARSO writes each
// station's file with the most recent reading first, so the file's *head*
// (not its tail) is what holds live data; the tail is the ~2-day-old end of
// the window. The last block in the chunk may be truncated by the Range
// boundary, so it's dropped whenever more than one block is present.
async function fetchStationEntries(id, headBytes) {
  const url = `${BASE}/observ/surface/text/sl/recent/observationAms_${id}_history.xml`;
  const text = await fetchText(url, { Range: `bytes=0-${headBytes - 1}` });
  const blocks = text.match(/<metData>[\s\S]*?<\/metData>/g);
  if (!blocks || !blocks.length) return [];
  const usable = blocks.length > 1 ? blocks.slice(0, -1) : blocks;
  return usable
    .map(b => {
      const parsed = parser.parse(`<root>${b}</root>`);
      const list = parsed.root?.metData;
      return Array.isArray(list) ? list[0] : list;
    })
    .filter(Boolean);
}

// Rolling 24h min/max (with the timestamp each extreme occurred) for
// temperature, humidity and wind speed. Seeded once at startup from a larger
// one-off history fetch per station, then topped up for free from each
// regular 10-min poll — no repeated heavy downloads.
const HISTORY_MS = 24 * 60 * 60 * 1000;
const historyByStation = new Map(); // id -> Map<epochMs, { temp, humidity, windKmh }>

function recordSample(id, m) {
  const tMs = parseArsoUtc(m.valid_UTC || m.tsValid_issued_UTC);
  if (!tMs) return;
  let byTime = historyByStation.get(id);
  if (!byTime) { byTime = new Map(); historyByStation.set(id, byTime); }
  byTime.set(tMs, { temp: num(m.t), humidity: num(m.rh), windKmh: num(m.ff_val_kmh) });
  const cutoff = Date.now() - HISTORY_MS;
  for (const t of byTime.keys()) if (t < cutoff) byTime.delete(t);
}

function statFor(id, field) {
  const byTime = historyByStation.get(id);
  const empty = { min: null, minAt: null, max: null, maxAt: null };
  if (!byTime || !byTime.size) return empty;
  let min = Infinity, minAt = null, max = -Infinity, maxAt = null;
  for (const [t, s] of byTime) {
    const v = s[field];
    if (v === null) continue;
    if (v < min) { min = v; minAt = t; }
    if (v > max) { max = v; maxAt = t; }
  }
  if (min === Infinity) return empty;
  return { min, minAt: new Date(minAt).toISOString(), max, maxAt: new Date(maxAt).toISOString() };
}

async function refreshStation(id, seedHistory) {
  const entries = await fetchStationEntries(id, seedHistory ? BACKFILL_HEAD_BYTES : CURRENT_HEAD_BYTES);
  if (!entries.length) return null;
  for (const m of entries) recordSample(id, m);
  const st = mapStation(entries[0]); // newest-first — entries[0] is the latest reading
  if (!st) return null;
  st.temp24h     = statFor(id, 'temp');
  st.humidity24h = statFor(id, 'humidity');
  st.wind24h     = statFor(id, 'windKmh');
  return st;
}

async function refreshCurrent(seedHistory = false) {
  const stations = [];
  let idx = 0;
  async function worker() {
    while (idx < STATION_IDS.length) {
      const id = STATION_IDS[idx++];
      try {
        const st = await refreshStation(id, seedHistory);
        if (st) stations.push(st);
      } catch (e) {
        logger.warn(`ARSO station ${id}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: STATION_CONCURRENCY }, worker));
  cache.current = { stations, updatedAt: new Date().toISOString() };
}

// ── Forecast (15 sub-regions × 5 days) ──────────────────────────────────────
async function refreshForecast() {
  const text = await fetchText(`${BASE}/fproduct/text/sl/forecast_si_latest.xml`);
  const parsed = parser.parse(text);
  const list = parsed.data?.metData || [];
  const regions = new Map();
  for (const m of list) {
    const id = (m.domain_meteosiId || '').replace(/_+$/, '');
    if (!id) continue;
    if (!regions.has(id)) {
      regions.set(id, {
        id,
        name: m.domain_longTitle || m.domain_title,
        lat: num(m.domain_lat), lon: num(m.domain_lon),
        days: [],
      });
    }
    regions.get(id).days.push({
      date:          m.valid_day,
      validAt:       m.valid,
      tMinC:         num(m.tnsyn),
      tMaxC:         num(m.txsyn),
      icon:          m['nn_icon-wwsyn_icon'] || m.nn_icon || null,
      conditionText: m.wwsyn_shortText || m.nn_shortText || null,
      windDirText:   m.dd_longText || null,
      windSpeedKmh:  num(m.ff_val_kmh),
      gustKmh:       num(m.ffmax_val_kmh),
      pressureMsl:   num(m.msl),
    });
  }
  cache.forecast = { regions: [...regions.values()], updatedAt: new Date().toISOString() };
}

// ── Warnings (CAP, yellow-or-higher only — level 1/green is ARSO's baseline
//    "no warning" entry present for every hazard, not an actual alert) ──────
// CAP polygons are "lat,lon lat,lon ..." space-separated pairs.
function parsePolygon(str) {
  if (!str) return null;
  const pts = str.trim().split(/\s+/).map(pair => pair.split(',').map(Number));
  const clean = pts.filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  return clean.length >= 3 ? clean : null;
}

// The region's boundary is identical across every hazard's <info> block within
// one region's CAP file — grab it once from whichever block has it.
function extractRegionShape(infos) {
  for (const info of infos) {
    if (info.language !== 'sl') continue;
    const areas = Array.isArray(info.area) ? info.area : (info.area ? [info.area] : []);
    for (const area of areas) {
      const polys = Array.isArray(area.polygon) ? area.polygon : (area.polygon ? [area.polygon] : []);
      for (const p of polys) {
        const polygon = parsePolygon(p);
        if (polygon) return { areaDesc: area.areaDesc || null, polygon };
      }
    }
  }
  return null;
}

async function fetchRegionWarnings(region) {
  const text = await fetchText(`${BASE}/warning/text/sl/warning_SLOVENIA_${region}_latest_CAP.xml`);
  const parsed = parser.parse(text);
  const infos = parsed.alert?.info || [];
  const alerts = [];
  for (const info of infos) {
    if (info.language !== 'sl') continue;
    const params = Array.isArray(info.parameter) ? info.parameter : (info.parameter ? [info.parameter] : []);
    const levelParam = params.find(p => p.valueName === 'awareness_level');
    const level = levelParam ? parseInt(String(levelParam.value).split(';')[0].trim(), 10) : NaN;
    if (!Number.isFinite(level) || level < 2) continue;
    const areas = Array.isArray(info.area) ? info.area : (info.area ? [info.area] : []);
    alerts.push({
      region,
      event:    info.event,
      level,
      color:    SEVERITY_COLOR[level] || 'yellow',
      headline: info.headline,
      onset:    info.onset,
      expires:  info.expires,
      areaDesc: areas[0]?.areaDesc || null,
    });
  }
  const shape = extractRegionShape(infos);
  return { alerts, shape };
}

async function refreshWarnings() {
  const settled = await Promise.allSettled(WARNING_REGIONS.map(fetchRegionWarnings));
  const alerts = [];
  const regions = [];
  settled.forEach((r, i) => {
    const region = WARNING_REGIONS[i];
    if (r.status === 'fulfilled') {
      alerts.push(...r.value.alerts);
      if (r.value.shape) regions.push({ region, areaDesc: r.value.shape.areaDesc, polygon: r.value.shape.polygon });
    } else {
      logger.warn(`ARSO warnings ${region}: ${r.reason?.message}`);
    }
  });
  // Same hazard can appear at multiple thresholds for one region — keep only the highest.
  const byKey = new Map();
  for (const a of alerts) {
    const key = `${a.region}|${a.event}`;
    const prev = byKey.get(key);
    if (!prev || a.level > prev.level) byKey.set(key, a);
  }
  const dedupedAlerts = [...byKey.values()].sort((a, b) => b.level - a.level);

  // Attach each region's current worst active level/color, if any.
  for (const r of regions) {
    const worst = dedupedAlerts.filter(a => a.region === r.region).sort((a, b) => b.level - a.level)[0];
    r.worstLevel = worst?.level ?? null;
    r.worstColor = worst?.color ?? null;
  }

  cache.warnings = { alerts: dedupedAlerts, regions, updatedAt: new Date().toISOString() };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
async function refreshAll(seedHistory = false) {
  if (getSetting('site_settings', {}).enableArsoWeather === false) return;
  const results = await Promise.allSettled([refreshCurrent(seedHistory), refreshForecast(), refreshWarnings()]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') logger.warn(`ARSO weather refresh (${['current','forecast','warnings'][i]}): ${r.reason?.message}`);
  });
}

function start() {
  if (timer) return;
  refreshAll(true); // first run also backfills ~24h of history per station
  timer = setInterval(() => refreshAll(false), REFRESH_MS);
}

function stop() { clearInterval(timer); timer = null; }

function getCurrent()  { return cache.current; }
function getForecast() { return cache.forecast; }
function getWarnings() { return cache.warnings; }

module.exports = { start, stop, getCurrent, getForecast, getWarnings };

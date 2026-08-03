'use strict';
// ARSO (Slovenian environment agency) weather data — current conditions from the
// full 96-station automatic network, 15-region 5-day forecast, and CAP warnings.
const { XMLParser } = require('fast-xml-parser');
const logger = require('../utils/logger');

const BASE = 'https://meteo.arso.gov.si/uploads/probase/www';
const CURRENT_TAIL_BYTES = 20000; // comfortably covers the last 1-2 metData entries
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
  isArray: (name) => ['metData', 'info', 'parameter', 'area'].includes(name),
});

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

let cache = {
  current:  { stations: [], updatedAt: null },
  forecast: { regions: [],  updatedAt: null },
  warnings: { alerts: [],   updatedAt: null },
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
    snowCm:        num(m.snow),
    visibilityKm:  num(m.vis_val) ?? num(m.vis_value),
    icon:          m['nn_icon-wwsyn_icon'] || m.nn_icon || null,
    conditionText: m.nn_shortText || m.wwsyn_shortText || null,
    updated:       m.valid || m.tsValid_issued || null,
  };
}

async function fetchStationLatest(id) {
  const url = `${BASE}/observ/surface/text/sl/recent/observationAms_${id}_history.xml`;
  const text = await fetchText(url, { Range: `bytes=-${CURRENT_TAIL_BYTES}` });
  const blocks = text.match(/<metData>[\s\S]*?<\/metData>/g);
  if (!blocks || !blocks.length) return null;
  const parsed = parser.parse(`<root>${blocks[blocks.length - 1]}</root>`);
  const list = parsed.root?.metData;
  const m = Array.isArray(list) ? list[0] : list;
  return m ? mapStation(m) : null;
}

async function refreshCurrent() {
  const stations = [];
  let idx = 0;
  async function worker() {
    while (idx < STATION_IDS.length) {
      const id = STATION_IDS[idx++];
      try {
        const st = await fetchStationLatest(id);
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
async function fetchRegionWarnings(region) {
  const text = await fetchText(`${BASE}/warning/text/sl/warning_SLOVENIA_${region}_latest_CAP.xml`);
  const parsed = parser.parse(text);
  const infos = parsed.alert?.info || [];
  const out = [];
  for (const info of infos) {
    if (info.language !== 'sl') continue;
    const params = Array.isArray(info.parameter) ? info.parameter : (info.parameter ? [info.parameter] : []);
    const levelParam = params.find(p => p.valueName === 'awareness_level');
    const level = levelParam ? parseInt(String(levelParam.value).split(';')[0].trim(), 10) : NaN;
    if (!Number.isFinite(level) || level < 2) continue;
    const areas = Array.isArray(info.area) ? info.area : (info.area ? [info.area] : []);
    out.push({
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
  return out;
}

async function refreshWarnings() {
  const settled = await Promise.allSettled(WARNING_REGIONS.map(fetchRegionWarnings));
  const alerts = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') alerts.push(...r.value);
    else logger.warn(`ARSO warnings ${WARNING_REGIONS[i]}: ${r.reason?.message}`);
  });
  // Same hazard can appear at multiple thresholds for one region — keep only the highest.
  const byKey = new Map();
  for (const a of alerts) {
    const key = `${a.region}|${a.event}`;
    const prev = byKey.get(key);
    if (!prev || a.level > prev.level) byKey.set(key, a);
  }
  cache.warnings = { alerts: [...byKey.values()].sort((a, b) => b.level - a.level), updatedAt: new Date().toISOString() };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
async function refreshAll() {
  const results = await Promise.allSettled([refreshCurrent(), refreshForecast(), refreshWarnings()]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') logger.warn(`ARSO weather refresh (${['current','forecast','warnings'][i]}): ${r.reason?.message}`);
  });
}

function start() {
  if (timer) return;
  refreshAll();
  timer = setInterval(refreshAll, REFRESH_MS);
}

function stop() { clearInterval(timer); timer = null; }

function getCurrent()  { return cache.current; }
function getForecast() { return cache.forecast; }
function getWarnings() { return cache.warnings; }

module.exports = { start, stop, getCurrent, getForecast, getWarnings };

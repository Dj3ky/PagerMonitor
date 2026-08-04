import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, Loader } from 'lucide-react';
import { getJson, BASEMAPS, useBasemap, BasemapSwitcher, LastUpdated } from './weatherMapShared.jsx';

const REFRESH_MS = 2 * 60 * 1000; // backend itself only refreshes every 10 min — this just
                                   // catches that update reasonably quickly, cost is a same-origin
                                   // read from the in-memory cache, not a new ARSO fetch.

const BASEMAP_STORAGE_KEY = 'pm_arso_basemap';
const METRIC_STORAGE_KEY  = 'pm_arso_metric';

const SEVERITY_LABEL = { yellow: 'Yellow', orange: 'Orange', red: 'Red' };
const SEVERITY_HEX   = { yellow: '#d29922', orange: '#f0883e', red: '#f85149' };

const NO_DATA_COLOR = '#888';

// Blue (cold) → red (hot). Clamped to a sane Slovenian range.
function tempColor(t) {
  const clamped = Math.max(-10, Math.min(40, t));
  const frac = (clamped + 10) / 50; // 0..1
  const hue = 220 - frac * 220; // 220 (blue) → 0 (red)
  return `hsl(${hue}, 80%, 50%)`;
}

// Dry → deep blue. 0mm gets a distinct neutral tone so "dry" doesn't read as "no data".
function precipColor(v) {
  if (v <= 0) return '#4a5568';
  const frac = Math.min(50, v) / 50;
  return `hsl(215, 85%, ${75 - frac * 45}%)`;
}

// Bare ground → deep blue/cyan snowpack.
function snowColor(v) {
  if (v <= 0) return '#4a5568';
  const frac = Math.min(100, v) / 100;
  return `hsl(195, 80%, ${85 - frac * 50}%)`;
}

// Calm (green) → gale (red).
function windColor(v) {
  const clamped = Math.max(0, Math.min(60, v));
  const frac = clamped / 60;
  return `hsl(${130 - frac * 130}, 75%, 50%)`;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60  ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

// Picks black-ish or white label text based on the marker's actual background
// brightness — a single fixed color (e.g. always white) loses contrast against
// the lighter end of these gradients (pale blues, yellows, etc).
function contrastText(bg) {
  let r, g, b;
  const hsl = bg.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/);
  if (hsl) {
    [r, g, b] = hslToRgb(+hsl[1], +hsl[2] / 100, +hsl[3] / 100);
  } else {
    const hex = bg.replace('#', '');
    const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    b = parseInt(full.slice(4, 6), 16);
  }
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#12151a' : '#fff';
}

// Map metric definitions — value getter, marker color, and compact in-circle label.
const METRICS = {
  temp: {
    label: 'Temp',
    get:     st => st.tempC,
    color:   tempColor,
    display: v => `${v.toFixed(1)}°`,
  },
  precip: {
    label: 'Precip',
    get:     st => st.precip24hMm ?? st.precipIntervalMm,
    color:   precipColor,
    display: v => `${v.toFixed(1)}`,
  },
  snow: {
    label: 'Snow',
    get:     st => st.snowCm,
    color:   snowColor,
    display: v => `${Math.round(v)}cm`,
  },
  wind: {
    label: 'Wind',
    get:     st => st.windSpeedKmh,
    color:   windColor,
    display: v => `${Math.round(v)}`,
  },
};

function fmtTime(str) {
  if (!str) return '—';
  // ARSO format: "03.08.2026 16:10 CEST"
  const m = str.match(/(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/);
  if (!m) return str;
  return `${m[4]}:${m[5]}`;
}

function fmtExpiry(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return iso; }
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return iso; }
}

function fmtAge(ms) {
  if (!ms) return null;
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

const STALE_MS = 60 * 60 * 1000; // no reading for 1h+ → flagged as stale on the map

function isStale(st) {
  return !st.updatedMs || (Date.now() - st.updatedMs) > STALE_MS;
}

function buildRegionPopupHtml(region, alertsForRegion) {
  const rows = alertsForRegion.map(a => `
    <div style="display:flex;align-items:baseline;gap:0.4rem;font-size:0.72rem;margin-top:0.3rem">
      <span style="font-size:0.6rem;font-weight:700;padding:0.05rem 0.4rem;border-radius:0.6rem;
        color:${SEVERITY_HEX[a.color]};background:${SEVERITY_HEX[a.color]}22;white-space:nowrap">${SEVERITY_LABEL[a.color]}</span>
      <span style="color:var(--text-1)">${a.event}</span>
    </div>`).join('');
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.78rem;min-width:200px;color:var(--text-1)">
      <div style="font-weight:700;font-size:0.9rem">${region.areaDesc || region.region}</div>
      ${rows || `<div style="color:var(--text-3);font-size:0.72rem;margin-top:0.3rem">No active warnings</div>`}
    </div>
  `;
}

// ── Popup content ────────────────────────────────────────────────────────────
function statCard(label, value) {
  return `<div style="background:var(--bg-3);border:1px solid var(--border);border-radius:0.5rem;padding:0.35rem 0.5rem">
    <div style="font-size:0.62rem;color:var(--text-3);text-transform:uppercase;letter-spacing:0.02em">${label}</div>
    <div style="font-weight:700;font-size:0.92rem;color:var(--text-1)">${value}</div>
  </div>`;
}

function historyCard(label, unit, stat) {
  if (!stat || stat.min == null) return '';
  const row = (tag, color, val, at) => `
    <div style="display:flex;align-items:center;gap:0.4rem;font-size:0.7rem;margin-top:0.15rem">
      <span style="color:${color};font-weight:700;min-width:28px">${tag}</span>
      <span style="font-weight:600;color:var(--text-1)">${val}${unit}</span>
      <span style="color:var(--text-3);margin-left:auto;white-space:nowrap">${fmtDateTime(at)}</span>
    </div>`;
  return `<div style="background:var(--bg-3);border:1px solid var(--border);border-radius:0.5rem;padding:0.4rem 0.5rem;margin-top:0.35rem">
    <div style="font-weight:600;font-size:0.72rem;color:var(--text-2)">${label}</div>
    ${row('MIN', 'var(--accent-blue)', stat.min, stat.minAt)}
    ${row('MAX', 'var(--accent-red)', stat.max, stat.maxAt)}
  </div>`;
}

function buildPopupHtml(st) {
  const age = fmtAge(st.updatedMs);
  const stale = isStale(st);
  const cards = [
    st.tempC     != null && statCard('Temperature', `${st.tempC}°C`),
    st.humidity  != null && statCard('Humidity', `${st.humidity}%`),
    st.windSpeedKmh != null && statCard('Wind', `${st.windSpeedKmh} km/h`),
    st.gustKmh   != null && statCard('Gusts', `${st.gustKmh} km/h`),
  ].filter(Boolean).join('');

  const precip = st.precip24hMm ?? st.precipIntervalMm;
  const extraRows = [
    ['Wind direction', st.windDirText ? `${st.windDirText}${st.windDirDeg != null ? ` (${st.windDirDeg}°)` : ''}` : '—'],
    ['Precipitation', precip != null ? `${precip} mm` : '—'],
    ['Pressure', st.pressureMsl != null ? `${st.pressureMsl} hPa` : '—'],
    ['Snow depth', st.snowCm != null ? `${st.snowCm} cm` : '—'],
  ].map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">${k}</span><span style="color:var(--text-1)">${v}</span></div>`).join('');

  const history = [
    historyCard('Temperature', '°C', st.temp24h),
    historyCard('Humidity', '%', st.humidity24h),
    historyCard('Wind', ' km/h', st.wind24h),
  ].filter(Boolean).join('');

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.78rem;min-width:210px;color:var(--text-1)">
      <div style="font-weight:700;font-size:0.9rem">${st.name}${st.altitude != null ? ` <span style="font-weight:400;color:var(--text-3);font-size:0.72rem">(${st.altitude} m)</span>` : ''}</div>
      <div style="color:${stale ? 'var(--accent-red)' : 'var(--text-3)'};font-size:0.68rem;margin-bottom:0.5rem">
        ${stale ? '⚠ Stale — ' : ''}Measured ${fmtTime(st.updated)}${age ? ` · ${age}` : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.35rem;margin-bottom:0.5rem">${cards}</div>
      <div style="display:flex;flex-direction:column;gap:0.15rem;font-size:0.72rem;margin-bottom:0.4rem">${extraRows}</div>
      ${history ? `<div style="font-weight:600;font-size:0.72rem;color:var(--text-2);border-top:1px solid var(--border);padding-top:0.35rem">24h history</div>${history}` : ''}
    </div>
  `;
}

// ── Warnings banner ─────────────────────────────────────────────────────────
function WarningsBanner({ alerts }) {
  const [open, setOpen] = useState(false);
  if (!alerts.length) return null;
  const worst = alerts[0]; // pre-sorted by level desc
  return (
    <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border)' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem',
        padding: '0.5rem 0.75rem', border: 'none', cursor: 'pointer', textAlign: 'left',
        background: `color-mix(in srgb, ${SEVERITY_HEX[worst.color]} 14%, transparent)`,
        color: SEVERITY_HEX[worst.color], fontSize: '0.8rem', fontWeight: 600,
      }}>
        <AlertTriangle size={15} />
        {alerts.length === 1 ? worst.headline : `${alerts.length} active weather warnings — worst: ${worst.event} (${SEVERITY_LABEL[worst.color]})`}
        <span style={{ marginLeft: 'auto', fontSize: '0.7rem', fontWeight: 400, opacity: 0.8 }}>{open ? 'hide' : 'details'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 0.75rem 0.6rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {alerts.map((a, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline', gap: '0.5rem', fontSize: '0.75rem',
              padding: '0.35rem 0.5rem', borderRadius: '0.35rem',
              background: 'var(--bg-2)', border: `1px solid color-mix(in srgb, ${SEVERITY_HEX[a.color]} 40%, transparent)`,
            }}>
              <span style={{
                fontSize: '0.62rem', fontWeight: 700, padding: '0.05rem 0.4rem', borderRadius: '0.6rem',
                color: SEVERITY_HEX[a.color], background: `${SEVERITY_HEX[a.color]}22`, whiteSpace: 'nowrap',
              }}>{SEVERITY_LABEL[a.color]}</span>
              <span style={{ color: 'var(--text-1)', fontWeight: 500 }}>{a.event}</span>
              <span style={{ color: 'var(--text-3)' }}>{a.areaDesc}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>until {fmtExpiry(a.expires)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Metric switcher (Temp / Precip / Snow / Wind) — stacked under BasemapSwitcher
function MetricSwitcher({ metric, onChange }) {
  return (
    <div style={{
      position: 'absolute', top: '2.6rem', right: '0.5rem', zIndex: 1000,
      display: 'flex', flexDirection: 'column', gap: '0.2rem', padding: '0.2rem', borderRadius: '0.5rem',
      background: 'var(--bg-1)', border: '1px solid var(--border)', boxShadow: '0 1px 6px rgba(0,0,0,0.3)',
    }}>
      {Object.entries(METRICS).map(([id, m]) => (
        <button key={id} onClick={() => onChange(id)} title={m.label} style={{
          padding: '0.2rem 0.5rem', borderRadius: '0.35rem', fontSize: '0.68rem', fontWeight: 500,
          cursor: 'pointer', border: 'none', whiteSpace: 'nowrap', textAlign: 'left',
          background: metric === id ? 'color-mix(in srgb, var(--accent-green) 16%, transparent)' : 'transparent',
          color: metric === id ? 'var(--accent-green)' : 'var(--text-2)',
        }}>{m.label}</button>
      ))}
    </div>
  );
}

// ── Station map ──────────────────────────────────────────────────────────────
function StationMap({ stations, visible, updatedAt, regions, alerts }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const regionLayersRef = useRef([]);
  const tileLayerRef = useRef(null);
  const [basemap, setBasemap] = useBasemap(BASEMAP_STORAGE_KEY);
  const [metric, setMetric] = useState(
    () => (localStorage.getItem(METRIC_STORAGE_KEY) in METRICS ? localStorage.getItem(METRIC_STORAGE_KEY) : 'temp')
  );
  useEffect(() => { localStorage.setItem(METRIC_STORAGE_KEY, metric); }, [metric]);

  useEffect(() => {
    if (mapRef.current || !divRef.current || !window.L) return;
    const L = window.L;
    const map = L.map(divRef.current, { center: [46.12, 14.80], zoom: 9 });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; tileLayerRef.current = null; };
  }, []);

  // Swap the tile layer whenever the chosen basemap style changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    const style = BASEMAPS[basemap] || BASEMAPS.dark;
    if (tileLayerRef.current) map.removeLayer(tileLayerRef.current);
    tileLayerRef.current = L.tileLayer(style.url, { attribution: style.attr, maxZoom: 19, detectRetina: true }).addTo(map);
    localStorage.setItem(BASEMAP_STORAGE_KEY, basemap);
  }, [basemap]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => mapRef.current?.invalidateSize());
  }, [visible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    const m = METRICS[metric] || METRICS.temp;
    markersRef.current.forEach(mk => map.removeLayer(mk));
    markersRef.current = stations.map(st => {
      const stale = isStale(st);
      const val = m.get(st);
      const color = val != null ? m.color(val) : NO_DATA_COLOR;
      const text = val != null ? m.display(val) : '—';
      const textColor = stale ? '#888' : contrastText(color);
      const icon = L.divIcon({
        className: '',
        html: `<div style="
          width:38px;height:38px;border-radius:50%;
          background:${stale ? '#1a1a1a' : color};
          display:flex;align-items:center;justify-content:center;
          font-weight:700;font-size:0.64rem;color:${textColor};
          border:2px solid ${stale ? '#555' : 'rgba(255,255,255,0.9)'};
          box-shadow:0 1px 4px rgba(0,0,0,0.45);
          font-family:system-ui,sans-serif;
          white-space:nowrap;
          opacity:${stale ? 0.75 : 1};
        ">${text}</div>`,
        iconSize: [38, 38], iconAnchor: [19, 19],
      });
      const marker = L.marker([st.lat, st.lon], { icon }).addTo(map);
      marker.bindPopup(buildPopupHtml(st), { minWidth: 230 });
      return marker;
    });
  }, [stations, metric]);

  // Warning-region outlines — subtle when calm, filled with severity color when active.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    regionLayersRef.current.forEach(l => map.removeLayer(l));
    regionLayersRef.current = (regions || []).map(region => {
      const active = region.worstColor && SEVERITY_HEX[region.worstColor];
      const color = active || '#4a5568';
      const layer = L.polygon(region.polygon, {
        color, weight: active ? 2 : 1, opacity: active ? 0.85 : 0.4,
        fillColor: color, fillOpacity: active ? 0.15 : 0.02,
        dashArray: active ? null : '4 4',
      }).addTo(map);
      const alertsForRegion = (alerts || []).filter(a => a.region === region.region);
      layer.bindPopup(buildRegionPopupHtml(region, alertsForRegion), { minWidth: 220 });
      return layer;
    });
  }, [regions, alerts]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <LastUpdated updatedAt={updatedAt} />
      <BasemapSwitcher basemap={basemap} onChange={setBasemap} />
      <MetricSwitcher metric={metric} onChange={setMetric} />
      <div ref={divRef} style={{ height: '100%' }} />
    </div>
  );
}

// ── Forecast strip ───────────────────────────────────────────────────────────
function ForecastStrip({ regions }) {
  const [regionId, setRegionId] = useState(null);
  useEffect(() => {
    if (!regionId && regions.length) setRegionId(regions[0].id);
  }, [regions, regionId]);

  const region = regions.find(r => r.id === regionId) || regions[0];
  if (!region) return null;

  return (
    <div style={{
      flexShrink: 0, borderTop: '1px solid var(--border)', background: 'var(--bg-1)',
      padding: '0.5rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem',
    }}>
      <select value={region.id} onChange={e => setRegionId(e.target.value)} className="pm-input"
        style={{ width: 'fit-content', fontSize: '0.75rem', padding: '0.15rem 0.4rem' }}>
        {regions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto' }}>
        {region.days.map((d, i) => (
          <div key={i} style={{
            flex: '0 0 auto', minWidth: '92px', padding: '0.4rem 0.5rem', borderRadius: '0.4rem',
            background: 'var(--bg-3)', border: '1px solid var(--border)', fontSize: '0.72rem', textAlign: 'center',
          }}>
            <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>{d.date?.replace(/ CEST| CET/, '') || `Day ${i + 1}`}</div>
            <div style={{ color: 'var(--text-3)', margin: '0.15rem 0' }}>{d.conditionText || '—'}</div>
            <div style={{ fontWeight: 700 }}>
              {d.tMaxC != null ? `${d.tMaxC}°` : '—'} <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>/ {d.tMinC != null ? `${d.tMinC}°` : '—'}</span>
            </div>
            {d.windSpeedKmh != null && (
              <div style={{ color: 'var(--text-3)', marginTop: '0.15rem' }}>{d.windSpeedKmh} km/h</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function ArsoWeatherPanel({ visible }) {
  const [current, setCurrent]   = useState({ stations: [], updatedAt: null });
  const [forecast, setForecast] = useState({ regions: [], updatedAt: null });
  const [warnings, setWarnings] = useState({ alerts: [], regions: [], updatedAt: null });
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      const [c, f, w] = await Promise.all([
        getJson('/api/weather/arso/current'),
        getJson('/api/weather/arso/forecast'),
        getJson('/api/weather/arso/warnings'),
      ]);
      setCurrent(c); setForecast(f); setWarnings(w);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      loadedOnce.current = true;
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, REFRESH_MS);
    return () => clearInterval(iv);
  }, [load]);

  if (!visible) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <WarningsBanner alerts={warnings.alerts} />
      {loading && !loadedOnce.current ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '0.6rem', color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
          <Loader size={20} style={{ animation: 'spin 0.8s linear infinite' }} />
          Loading ARSO station data…
        </div>
      ) : error && !current.stations.length ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent-red)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
          Failed to load ARSO data: {error}
        </div>
      ) : (
        <>
          <StationMap stations={current.stations} visible={visible} updatedAt={current.updatedAt}
            regions={warnings.regions} alerts={warnings.alerts} />
          <ForecastStrip regions={forecast.regions} />
        </>
      )}
    </div>
  );
}

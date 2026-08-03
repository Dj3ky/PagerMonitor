import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, Loader } from 'lucide-react';
import { getJson, BASEMAPS, useBasemap, BasemapSwitcher, LastUpdated } from './weatherMapShared.jsx';

const REFRESH_MS = 2 * 60 * 1000; // backend itself only refreshes every 10 min — this just
                                   // catches that update reasonably quickly, cost is a same-origin
                                   // read from the in-memory cache, not a new ARSO fetch.

const BASEMAP_STORAGE_KEY = 'pm_arso_basemap';

const SEVERITY_LABEL = { yellow: 'Yellow', orange: 'Orange', red: 'Red' };
const SEVERITY_HEX   = { yellow: '#d29922', orange: '#f0883e', red: '#f85149' };

// Blue (cold) → red (hot) gradient for station dots. Clamped to a sane Slovenian range.
function tempColor(t) {
  if (t === null || t === undefined) return '#888';
  const clamped = Math.max(-10, Math.min(40, t));
  const frac = (clamped + 10) / 50; // 0..1
  const hue = 220 - frac * 220; // 220 (blue) → 0 (red)
  return `hsl(${hue}, 80%, 50%)`;
}

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

// ── Station map ──────────────────────────────────────────────────────────────
function StationMap({ stations, visible, updatedAt }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const tileLayerRef = useRef(null);
  const [basemap, setBasemap] = useBasemap(BASEMAP_STORAGE_KEY);

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
    markersRef.current.forEach(m => map.removeLayer(m));
    markersRef.current = stations.map(st => {
      const stale = isStale(st);
      const icon = L.divIcon({
        className: '',
        html: `<div style="
          width:38px;height:38px;border-radius:50%;
          background:${stale ? '#1a1a1a' : tempColor(st.tempC)};
          display:flex;align-items:center;justify-content:center;
          font-weight:700;font-size:0.64rem;color:${stale ? '#888' : '#fff'};
          border:2px solid ${stale ? '#555' : 'rgba(255,255,255,0.9)'};
          box-shadow:0 1px 4px rgba(0,0,0,0.45);
          font-family:system-ui,sans-serif;
          white-space:nowrap;
          opacity:${stale ? 0.75 : 1};
        ">${st.tempC != null ? st.tempC.toFixed(1) + '°' : '—'}</div>`,
        iconSize: [38, 38], iconAnchor: [19, 19],
      });
      const marker = L.marker([st.lat, st.lon], { icon }).addTo(map);
      marker.bindPopup(buildPopupHtml(st), { minWidth: 230 });
      return marker;
    });
  }, [stations]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <LastUpdated updatedAt={updatedAt} />
      <BasemapSwitcher basemap={basemap} onChange={setBasemap} />
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
  const [warnings, setWarnings] = useState({ alerts: [], updatedAt: null });
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
          <StationMap stations={current.stations} visible={visible} updatedAt={current.updatedAt} />
          <ForecastStrip regions={forecast.regions} />
        </>
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, Loader } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const authHeaders = () => ({ Authorization: `Bearer ${tok()}` });

const REFRESH_MS = 2 * 60 * 1000; // backend itself only refreshes every 10 min — this just
                                   // catches that update reasonably quickly, cost is a same-origin
                                   // read from the in-memory cache, not a new ARSO fetch.

const TILE_URL  = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

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

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
function StationMap({ stations, visible }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);

  useEffect(() => {
    if (mapRef.current || !divRef.current || !window.L) return;
    const L = window.L;
    const map = L.map(divRef.current, { center: [46.12, 14.80], zoom: 8 });
    L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => mapRef.current?.invalidateSize());
  }, [visible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    markersRef.current.forEach(m => map.removeLayer(m));
    markersRef.current = stations.map(st => {
      const marker = L.circleMarker([st.lat, st.lon], {
        radius: 7, weight: 1.5, color: '#fff', fillColor: tempColor(st.tempC), fillOpacity: 0.9,
      }).addTo(map);
      const rows = [
        st.tempC  != null && ['Temperature', `${st.tempC}°C`],
        st.humidity != null && ['Humidity', `${st.humidity}%`],
        st.dewPointC != null && ['Dew point', `${st.dewPointC}°C`],
        (st.windSpeedKmh != null) && ['Wind', `${st.windSpeedKmh} km/h${st.windDirText ? ' ' + st.windDirText : ''}${st.gustKmh ? ` (gust ${st.gustKmh})` : ''}`],
        st.pressureMsl != null && ['Pressure', `${st.pressureMsl} hPa`],
        st.precip24hMm != null && ['24h precip', `${st.precip24hMm} mm`],
        st.snowCm != null && ['Snow depth', `${st.snowCm} cm`],
      ].filter(Boolean);
      marker.bindPopup(`
        <div style="font-family:monospace;font-size:0.8rem;min-width:170px">
          <div style="font-weight:700;margin-bottom:0.3rem">${st.name}${st.altitude != null ? ` (${st.altitude} m)` : ''}</div>
          ${rows.map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="opacity:0.65">${k}</span><span>${v}</span></div>`).join('')}
          <div style="margin-top:0.3rem;opacity:0.55;font-size:0.7rem">Updated ${fmtTime(st.updated)}</div>
        </div>
      `);
      return marker;
    });
  }, [stations]);

  return <div ref={divRef} style={{ flex: 1, minHeight: 0 }} />;
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
          <StationMap stations={current.stations} visible={visible} />
          <ForecastStrip regions={forecast.regions} />
        </>
      )}
    </div>
  );
}

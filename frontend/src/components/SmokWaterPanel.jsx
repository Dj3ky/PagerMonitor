import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, Loader } from 'lucide-react';
import { getJson, BASEMAPS, useBasemap, BasemapSwitcher, LastUpdated } from './weatherMapShared.jsx';

const REFRESH_MS = 2 * 60 * 1000; // backend itself only refreshes every 15 min — see comment there
const BASEMAP_STORAGE_KEY = 'pm_smok_basemap';
const TILE_URL  = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

const STATUS_HEX   = { alarm: '#f85149', rising: '#f0883e', steady: '#3fb950', falling: '#58a6ff', noData: '#8b949e', unknown: '#8b949e' };
const STATUS_LABEL = { alarm: 'Alarm', rising: 'Rising', steady: 'Steady', falling: 'Falling', noData: 'No data', unknown: 'Unknown' };

function fmtDelta(v, digits = 0) {
  if (v == null) return '';
  if (v === 0) return '';
  const s = v.toFixed(digits);
  return ` (${v > 0 ? '+' : ''}${s})`;
}

function statRow(label, value, unit, delta, deltaDigits) {
  if (value == null) return '';
  return `<div style="display:flex;justify-content:space-between;gap:0.75rem">
    <span style="color:var(--text-3)">${label}</span>
    <span style="color:var(--text-1)">${value}${unit}<span style="color:var(--text-3);font-size:0.68rem">${fmtDelta(delta, deltaDigits)}${unit}</span></span>
  </div>`;
}

function buildPopupHtml(st) {
  const color = STATUS_HEX[st.status] || STATUS_HEX.unknown;
  const rows = [
    statRow('Water level', st.waterLevelCm, ' cm', st.waterLevelDeltaCm, 0),
    statRow('Flow', st.flowM3s, ' m³/s', st.flowDeltaM3s, 3),
    statRow('Temperature', st.tempC, '°C', st.tempDeltaC, 1),
  ].filter(Boolean).join('');

  const alarmRow = (st.actualAlarmLevel || st.statisticalAlarmLevel)
    ? `<div style="display:flex;justify-content:space-between;gap:0.75rem;color:var(--accent-red);font-weight:600">
        <span>Alarm level</span><span>actual ${st.actualAlarmLevel ?? '—'} · statistical ${st.statisticalAlarmLevel ?? '—'}</span>
      </div>`
    : '';

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.78rem;min-width:200px;color:var(--text-1)">
      <div style="font-weight:700;font-size:0.9rem">${st.name || `Station ${st.id}`}</div>
      ${st.river ? `<div style="color:var(--text-3);font-size:0.72rem;margin-bottom:0.3rem">${st.river}</div>` : ''}
      <span style="display:inline-block;font-size:0.62rem;font-weight:700;padding:0.08rem 0.45rem;border-radius:0.6rem;color:${color};background:${color}22;margin-bottom:0.4rem">${STATUS_LABEL[st.status] || st.status}</span>
      <div style="display:flex;flex-direction:column;gap:0.15rem;font-size:0.72rem">
        ${rows || '<div style="color:var(--text-3)">No current readings</div>'}
        ${alarmRow}
        ${st.dataAgeText ? `<div style="display:flex;justify-content:space-between;gap:0.75rem;margin-top:0.2rem"><span style="color:var(--text-3)">Data age</span><span style="color:var(--text-1)">${st.dataAgeText}</span></div>` : ''}
      </div>
    </div>
  `;
}

// ── Active-alarm banner ──────────────────────────────────────────────────────
function AlarmBanner({ stations }) {
  const alarms = stations.filter(st => st.status === 'alarm');
  if (!alarms.length) return null;
  return (
    <div style={{
      flexShrink: 0, borderBottom: '1px solid var(--border)', padding: '0.5rem 0.75rem',
      display: 'flex', alignItems: 'center', gap: '0.5rem',
      background: 'color-mix(in srgb, var(--accent-red) 14%, transparent)',
      color: 'var(--accent-red)', fontSize: '0.8rem', fontWeight: 600,
    }}>
      <AlertTriangle size={15} />
      {alarms.length} station{alarms.length > 1 ? 's' : ''} in alarm: {alarms.map(a => a.name).filter(Boolean).join(', ')}
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
    const map = L.map(divRef.current, { center: [46.12, 14.80], zoom: 8 });
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; tileLayerRef.current = null; };
  }, []);

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
      const icon = L.icon({ iconUrl: st.iconUrl, iconSize: [24, 24], iconAnchor: [12, 12] });
      const marker = L.marker([st.lat, st.lon], { icon }).addTo(map);
      marker.bindPopup(buildPopupHtml(st), { minWidth: 220 });
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

// ── Main panel ────────────────────────────────────────────────────────────────
export default function SmokWaterPanel({ visible }) {
  const [data, setData] = useState({ stations: [], updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await getJson('/api/weather/smok/stations'));
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
      <AlarmBanner stations={data.stations} />
      {loading && !loadedOnce.current ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '0.6rem', color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
          <Loader size={20} style={{ animation: 'spin 0.8s linear infinite' }} />
          Loading SMOK station data…
        </div>
      ) : error && !data.stations.length ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent-red)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
          Failed to load SMOK data: {error}
        </div>
      ) : (
        <StationMap stations={data.stations} visible={visible} updatedAt={data.updatedAt} />
      )}
    </div>
  );
}

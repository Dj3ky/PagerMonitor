import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader, Plane } from 'lucide-react';
import { getJson, BASEMAPS, useBasemap, BasemapSwitcher, LastUpdated } from './weatherMapShared.jsx';

const REFRESH_MS = 60 * 1000; // backend itself only refreshes every 5 min — see comment there
const BASEMAP_STORAGE_KEY = 'pm_aircraft_basemap';

function fmtAge(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusColor(a) {
  if (a.live && !a.onGround) return '#3fb950'; // airborne
  if (a.live && a.onGround) return '#d29922';  // on ground, broadcasting
  return '#8b949e'; // last known position only
}

function statusLabel(a) {
  if (a.live && !a.onGround) return 'Airborne';
  if (a.live && a.onGround) return 'On ground';
  if (a.lastSeen) return `Last seen ${fmtAge(a.lastSeen)}`;
  return 'Not seen recently';
}

function buildPopupHtml(a) {
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.78rem;min-width:190px;color:var(--text-1)">
      <div style="font-weight:700;font-size:0.9rem">${a.reg}</div>
      <div style="color:var(--text-3);font-size:0.68rem;margin-bottom:0.45rem">${statusLabel(a)}</div>
      <div style="display:flex;flex-direction:column;gap:0.15rem;font-size:0.72rem">
        <div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">Altitude</span><span style="color:var(--text-1)">${a.altitude != null ? `${Math.round(a.altitude)} m` : '—'}</span></div>
        <div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">Speed</span><span style="color:var(--text-1)">${a.velocity != null ? `${Math.round(a.velocity * 3.6)} km/h` : '—'}</span></div>
        <div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">Heading</span><span style="color:var(--text-1)">${a.heading != null ? `${Math.round(a.heading)}°` : '—'}</span></div>
      </div>
    </div>
  `;
}

// ── Airborne-now strip ───────────────────────────────────────────────────────
function StatusStrip({ aircraft }) {
  const airborne = aircraft.filter(a => a.live && !a.onGround);
  if (!airborne.length) return null;
  return (
    <div style={{
      flexShrink: 0, borderBottom: '1px solid var(--border)', padding: '0.5rem 0.75rem',
      display: 'flex', alignItems: 'center', gap: '0.5rem',
      background: 'color-mix(in srgb, #3fb950 14%, transparent)',
      color: '#3fb950', fontSize: '0.8rem', fontWeight: 600,
    }}>
      <Plane size={14} />
      {airborne.length} Fire Boss aircraft airborne — {airborne.map(a => a.reg).join(', ')}
    </div>
  );
}

// ── Aircraft map ─────────────────────────────────────────────────────────────
function AircraftMap({ aircraft, visible, updatedAt }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const tileLayerRef = useRef(null);
  const [basemap, setBasemap] = useBasemap(BASEMAP_STORAGE_KEY, 'streets');

  useEffect(() => {
    if (mapRef.current || !divRef.current || !window.L) return;
    const L = window.L;
    const map = L.map(divRef.current, { center: [45.85, 14.2], zoom: 8 }); // Slovenian coast — usual scooping grounds
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; tileLayerRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    const style = BASEMAPS[basemap] || BASEMAPS.streets;
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
    markersRef.current = aircraft
      .filter(a => a.lat != null && a.lon != null)
      .map(a => {
        const marker = L.circleMarker([a.lat, a.lon], {
          radius: 8, weight: 2, color: '#fff',
          fillColor: statusColor(a), fillOpacity: a.live ? 0.85 : 0.35,
        }).addTo(map);
        marker.bindPopup(buildPopupHtml(a), { minWidth: 210 });
        return marker;
      });
  }, [aircraft]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <LastUpdated updatedAt={updatedAt} />
      <BasemapSwitcher basemap={basemap} onChange={setBasemap} />
      <div ref={divRef} style={{ height: '100%' }} />
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────
export default function AircraftView({ visible }) {
  const [data, setData] = useState({ aircraft: [], updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await getJson('/api/aircraft'));
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
      <StatusStrip aircraft={data.aircraft} />
      {loading && !loadedOnce.current ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '0.6rem', color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
          <Loader size={20} style={{ animation: 'spin 0.8s linear infinite' }} />
          Loading aircraft data…
        </div>
      ) : error && !data.aircraft.length ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent-red)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
          Failed to load aircraft data: {error}
        </div>
      ) : (
        <AircraftMap aircraft={data.aircraft} visible={visible} updatedAt={data.updatedAt} />
      )}
    </div>
  );
}

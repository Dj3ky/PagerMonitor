import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader } from 'lucide-react';
import { getJson, BASEMAPS, useBasemap, BasemapSwitcher, LastUpdated } from './weatherMapShared.jsx';

const REFRESH_MS = 2 * 60 * 1000; // backend itself only refreshes every 10 min — see comment there
const BASEMAP_STORAGE_KEY = 'pm_quake_basemap';

function fmtWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return iso; }
}

function fmtAge(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `pred ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `pred ${hours}h`;
  return `pred ${Math.floor(hours / 24)}d`;
}

// Marker radius scales with magnitude — small tremors stay subtle, larger quakes stand out.
function radiusFor(mag) {
  if (mag == null) return 6;
  return Math.max(5, Math.min(22, 5 + mag * 3.2));
}

function buildPopupHtml(q) {
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.78rem;min-width:200px;color:var(--text-1)">
      <div style="font-weight:700;font-size:0.9rem">M${q.magnitude != null ? q.magnitude.toFixed(1) : '?'} — ${q.location || 'Neznana lokacija'}</div>
      <div style="color:var(--text-3);font-size:0.68rem;margin-bottom:0.45rem">${fmtWhen(q.time)} · ${fmtAge(q.time)}</div>
      <div style="display:flex;flex-direction:column;gap:0.15rem;font-size:0.72rem">
        <div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">Globina</span><span style="color:var(--text-1)">${q.depthKm != null ? `${q.depthKm} km` : '—'}</span></div>
        <div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">Postaje</span><span style="color:var(--text-1)">${q.stations ?? '—'}</span></div>
        ${q.intensity ? `<div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">Intenziteta (EMS)</span><span style="color:var(--text-1)">${q.intensity}</span></div>` : ''}
        ${q.reportCount ? `<div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">Zaznana poročila</span><span style="color:var(--text-1)">${q.reportCount}</span></div>` : ''}
      </div>
    </div>
  `;
}

// ── Recent-activity strip — the strongest quake in the last 24h, if any ─────
function RecentBanner({ quakes }) {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const recent = quakes.filter(q => new Date(q.time).getTime() >= dayAgo);
  if (!recent.length) return null;
  const strongest = [...recent].sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0))[0];
  return (
    <div style={{
      flexShrink: 0, borderBottom: '1px solid var(--border)', padding: '0.5rem 0.75rem',
      display: 'flex', alignItems: 'center', gap: '0.5rem',
      background: `color-mix(in srgb, ${strongest.color} 14%, transparent)`,
      color: strongest.color, fontSize: '0.8rem', fontWeight: 600,
    }}>
      {recent.length} {recent.length > 1 ? 'potresov' : 'potres'} v zadnjih 24h — najmočnejši M{strongest.magnitude?.toFixed(1)} blizu {strongest.location}
    </div>
  );
}

// ── Quake map ────────────────────────────────────────────────────────────────
function QuakeMap({ quakes, visible, updatedAt }) {
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
    // Newest-on-top: draw oldest first so recent quakes aren't hidden underneath.
    markersRef.current = [...quakes].reverse().map(q => {
      const marker = L.circleMarker([q.lat, q.lon], {
        radius: radiusFor(q.magnitude), weight: 1.5, color: '#fff',
        fillColor: q.color, fillOpacity: 0.75,
      }).addTo(map);
      marker.bindPopup(buildPopupHtml(q), { minWidth: 220 });
      return marker;
    });
  }, [quakes]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <LastUpdated updatedAt={updatedAt} />
      <BasemapSwitcher basemap={basemap} onChange={setBasemap} />
      <div ref={divRef} style={{ height: '100%' }} />
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function QuakePanel({ visible }) {
  const [data, setData] = useState({ quakes: [], updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await getJson('/api/weather/arso/quakes'));
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
      <RecentBanner quakes={data.quakes} />
      {loading && !loadedOnce.current ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '0.6rem', color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
          <Loader size={20} style={{ animation: 'spin 0.8s linear infinite' }} />
          Nalaganje podatkov o potresih…
        </div>
      ) : error && !data.quakes.length ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent-red)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
          Nalaganje podatkov o potresih ni uspelo: {error}
        </div>
      ) : (
        <QuakeMap quakes={data.quakes} visible={visible} updatedAt={data.updatedAt} />
      )}
    </div>
  );
}

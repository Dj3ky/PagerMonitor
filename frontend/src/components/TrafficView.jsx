import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader } from 'lucide-react';
import { getJson, BASEMAPS, useBasemap, BasemapSwitcher, LastUpdated } from './weatherMapShared.jsx';

// Our own backend's in-memory cache (napTraffic polls b2b.nap.si every 10 min) —
// cheap to re-read often so the tab feels responsive without hammering NAP.
const REFRESH_MS = 2 * 60 * 1000;
const BASEMAP_STORAGE_KEY = 'pm_traffic_basemap';
const CAMERA_COLOR = '#0ea5e9';

function buildPopupHtml(feature) {
  const group = feature.properties?.group || {};
  const items = feature.properties?.items || [];
  const body = items.map(it => `
    <div style="margin-top:0.4rem">
      ${items.length > 1 ? `<div style="color:var(--text-3);font-size:0.68rem;margin-bottom:0.2rem">${it.text_slo || it.title_slo || ''}</div>` : ''}
      ${it.image ? `<img src="${it.image}" loading="lazy" style="width:100%;max-width:260px;border-radius:4px;display:block" onerror="this.style.display='none'"/>` : ''}
    </div>`).join('');
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.8rem;min-width:200px;color:var(--text-1)">
      <div style="font-weight:700;color:${CAMERA_COLOR}">${group.title_slo || group.name || 'Camera'}</div>
      ${body}
    </div>`;
}

function cameraIcon(L) {
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${CAMERA_COLOR};border:2px solid #fff;box-shadow:0 0 6px ${CAMERA_COLOR};display:flex;align-items:center;justify-content:center;font-size:9px;">📷</div>`,
    iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -8],
  });
}

// ── Traffic map ──────────────────────────────────────────────────────────────
function TrafficMap({ features, visible, updatedAt }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const tileLayerRef = useRef(null);
  const [basemap, setBasemap] = useBasemap(BASEMAP_STORAGE_KEY, 'streets');

  useEffect(() => {
    if (mapRef.current || !divRef.current || !window.L) return;
    const L = window.L;
    const map = L.map(divRef.current, { center: [46.05, 14.9], zoom: 8 }); // Slovenia
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
    markersRef.current = features
      .filter(f => f.geometry?.coordinates)
      .map(f => {
        const [lon, lat] = f.geometry.coordinates;
        const marker = L.marker([lat, lon], { icon: cameraIcon(L) }).addTo(map);
        marker.bindPopup(buildPopupHtml(f), { maxWidth: 300 });
        return marker;
      });
  }, [features]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <LastUpdated updatedAt={updatedAt} />
      <BasemapSwitcher basemap={basemap} onChange={setBasemap} />
      <div ref={divRef} style={{ height: '100%' }} />
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────
export default function TrafficView({ visible }) {
  const [data, setData] = useState({ features: [], updatedAt: null, configured: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await getJson('/api/traffic/cameras'));
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
      {!data.configured && !loading && (
        <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border)', padding: '0.5rem 0.75rem',
          fontSize: '0.78rem', color: 'var(--accent-amber)', fontFamily: 'monospace' }}>
          No NAP credentials configured — set them in Admin → Traffic Data (NAP)
        </div>
      )}
      {loading && !loadedOnce.current ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '0.6rem', color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
          <Loader size={20} style={{ animation: 'spin 0.8s linear infinite' }} />
          Loading traffic cameras…
        </div>
      ) : error && !data.features?.length ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent-red)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
          Failed to load traffic data: {error}
        </div>
      ) : (
        <TrafficMap features={data.features || []} visible={visible} updatedAt={data.updatedAt} />
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader, X, Camera as CameraIcon, TriangleAlert } from 'lucide-react';
import { getJson, BASEMAPS, useBasemap, BasemapSwitcher, LastUpdated } from './weatherMapShared.jsx';

// Our own backend's in-memory cache (napTraffic polls b2b.nap.si — every 10 min for
// cameras, every 5 min for road works) — cheap to re-read often so the tab feels
// responsive without hammering NAP.
const REFRESH_MS = 2 * 60 * 1000;
const IMG_REFRESH_MS = 12 * 1000; // only runs while a camera's popup is open
const BASEMAP_STORAGE_KEY = 'pm_traffic_basemap';
const CAMERA_COLOR = '#0ea5e9';
const ROADWORK_COLOR = '#f59e0b';

const LAYERS = [
  { id: 'cameras',   label: 'Cameras',    icon: <CameraIcon size={13}/> },
  { id: 'roadworks', label: 'Road works', icon: <TriangleAlert size={13}/> },
];

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString(undefined, { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }); }
  catch (_) { return iso; }
}

// ── Cameras: popup content + icon ────────────────────────────────────────────
// data-src holds the real snapshot URL; src starts cache-busted so the very
// first paint is fresh too, not whatever the browser had cached from before.
// Clicking an image calls window.__pmOpenCamera (bridged from React below) to
// open a bigger, independently-refreshing view — Leaflet popup content is raw
// HTML, so a plain global-function call is the simplest way back into React.
function buildCameraPopupHtml(feature) {
  const group = feature.properties?.group || {};
  const items = feature.properties?.items || [];
  const groupTitle = group.title_slo || group.name || 'Camera';
  const body = items.map(it => {
    const label = it.text_slo || it.title_slo || groupTitle;
    return `
    <div style="margin-top:0.4rem">
      ${items.length > 1 ? `<div style="color:var(--text-3);font-size:0.68rem;margin-bottom:0.2rem">${label}</div>` : ''}
      ${it.image ? `<img class="pm-cam-img" data-src="${it.image}" data-title="${escAttr(label)}" src="${it.image}?t=${Date.now()}" loading="lazy" title="Click to enlarge" style="width:100%;max-width:260px;border-radius:4px;display:block;cursor:zoom-in" onclick="window.__pmOpenCamera && window.__pmOpenCamera(this.dataset.src, this.dataset.title)" onerror="this.style.display='none'"/>` : ''}
    </div>`;
  }).join('');
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.8rem;min-width:200px;color:var(--text-1)">
      <div style="font-weight:700;color:${CAMERA_COLOR}">${groupTitle}</div>
      ${body}
    </div>`;
}

function refreshPopupImages(popupEl) {
  if (!popupEl) return;
  popupEl.querySelectorAll('img.pm-cam-img').forEach(img => {
    const base = img.dataset.src;
    if (base) img.src = `${base}${base.includes('?') ? '&' : '?'}t=${Date.now()}`;
  });
}

function cameraIcon(L) {
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${CAMERA_COLOR};border:2px solid #fff;box-shadow:0 0 6px ${CAMERA_COLOR};display:flex;align-items:center;justify-content:center;font-size:9px;">📷</div>`,
    iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -8],
  });
}

// ── Road works: popup content + icon ─────────────────────────────────────────
function buildRoadworkPopupHtml(feature) {
  const p = feature.properties || {};
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.8rem;min-width:220px;max-width:280px;color:var(--text-1)">
      <div style="font-weight:700;color:${ROADWORK_COLOR}">${p.cesta || 'Road works'}</div>
      <div style="color:var(--text-3);font-size:0.68rem;margin-top:0.15rem">
        ${p.kategorija || ''}${p.kategorija && p.vzrok ? ' · ' : ''}${p.vzrok || ''}${p.IsConfirmed === false ? ' · unconfirmed' : ''}
      </div>
      ${p.opis ? `<div style="margin-top:0.4rem;line-height:1.4">${p.opis}</div>` : ''}
      ${p.updated ? `<div style="color:var(--text-3);font-size:0.65rem;margin-top:0.4rem">Updated ${fmtDate(p.updated)}</div>` : ''}
    </div>`;
}

function roadworkIcon(L) {
  return L.divIcon({
    className: '',
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${ROADWORK_COLOR};border:2px solid #fff;box-shadow:0 0 6px ${ROADWORK_COLOR};display:flex;align-items:center;justify-content:center;font-size:9px;">🚧</div>`,
    iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -8],
  });
}

// ── Enlarged camera view ─────────────────────────────────────────────────────
function CameraLightbox({ camera, onClose }) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!camera) return;
    const iv = setInterval(() => forceTick(t => t + 1), IMG_REFRESH_MS);
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(iv); window.removeEventListener('keydown', onKey); };
  }, [camera, onClose]);

  if (!camera) return null;
  const src = `${camera.src}${camera.src.includes('?') ? '&' : '?'}t=${Date.now()}`;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 2000,
      background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '2rem', cursor: 'zoom-out' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '90vw', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: '#fff',
          fontFamily: 'monospace', fontSize: '0.85rem' }}>
          <span>{camera.title}</span>
          <button onClick={onClose} title="Close" style={{ display: 'flex', padding: '0.2rem',
            border: '1px solid rgba(255,255,255,0.3)', borderRadius: '0.3rem', background: 'transparent',
            color: '#fff', cursor: 'pointer' }}><X size={14} /></button>
        </div>
        <img src={src} alt={camera.title}
          style={{ maxWidth: '100%', maxHeight: '80vh', borderRadius: '6px', boxShadow: '0 4px 24px rgba(0,0,0,0.5)' }} />
      </div>
    </div>
  );
}

// ── Layer tab toolbar ────────────────────────────────────────────────────────
function Toolbar({ activeLayer, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.4rem',
      padding: '0.4rem 0.75rem', borderBottom: '1px solid var(--border)',
      background: 'var(--bg-1)', flexShrink: 0, flexWrap: 'wrap',
    }}>
      {LAYERS.map(l => (
        <button key={l.id} onClick={() => onChange(l.id)}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.3rem',
            padding: '0.25rem 0.55rem', borderRadius: '0.4rem', fontSize: '0.78rem',
            fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.15s',
            border: activeLayer === l.id
              ? '1px solid color-mix(in srgb, var(--accent-green) 35%, transparent)'
              : '1px solid var(--border)',
            background: activeLayer === l.id
              ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)'
              : 'var(--bg-3)',
            color: activeLayer === l.id ? 'var(--accent-green)' : 'var(--text-2)',
          }}>
          {l.icon} {l.label}
        </button>
      ))}
    </div>
  );
}

// ── Traffic map ──────────────────────────────────────────────────────────────
function TrafficMap({ layer, features, visible, updatedAt, onOpenCamera }) {
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
    window.__pmOpenCamera = (src, title) => onOpenCamera?.({ src, title });
    return () => { delete window.__pmOpenCamera; };
  }, [onOpenCamera]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    markersRef.current.forEach(m => { clearInterval(m._pmImgTimer); map.removeLayer(m); });

    markersRef.current = features
      .filter(f => f.geometry?.coordinates)
      .map(f => {
        const [lon, lat] = f.geometry.coordinates;
        if (layer === 'cameras') {
          const marker = L.marker([lat, lon], { icon: cameraIcon(L) }).addTo(map);
          marker.bindPopup(buildCameraPopupHtml(f), { maxWidth: 300 });
          marker.on('popupopen', e => {
            refreshPopupImages(e.popup.getElement());
            marker._pmImgTimer = setInterval(() => refreshPopupImages(e.popup.getElement()), IMG_REFRESH_MS);
          });
          marker.on('popupclose', () => clearInterval(marker._pmImgTimer));
          return marker;
        }
        const marker = L.marker([lat, lon], { icon: roadworkIcon(L) }).addTo(map);
        marker.bindPopup(buildRoadworkPopupHtml(f), { maxWidth: 300 });
        return marker;
      });

    return () => { markersRef.current.forEach(m => clearInterval(m._pmImgTimer)); };
  }, [layer, features]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <LastUpdated updatedAt={updatedAt} />
      <BasemapSwitcher basemap={basemap} onChange={setBasemap} />
      <div ref={divRef} style={{ height: '100%' }} />
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────
const EMPTY = { features: [], updatedAt: null, configured: false };

export default function TrafficView({ visible }) {
  const [activeLayer, setActiveLayer] = useState('cameras');
  const [cameras, setCameras] = useState(EMPTY);
  const [roadworks, setRoadworks] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lightboxCamera, setLightboxCamera] = useState(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([
        getJson('/api/traffic/cameras'),
        getJson('/api/traffic/roadworks'),
      ]);
      setCameras(c);
      setRoadworks(r);
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

  const data = activeLayer === 'cameras' ? cameras : roadworks;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Toolbar activeLayer={activeLayer} onChange={setActiveLayer} />
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
          Loading traffic data…
        </div>
      ) : error && !data.features?.length ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent-red)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
          Failed to load traffic data: {error}
        </div>
      ) : (
        <TrafficMap layer={activeLayer} features={data.features || []} visible={visible} updatedAt={data.updatedAt}
          onOpenCamera={setLightboxCamera} />
      )}
      <CameraLightbox camera={lightboxCamera} onClose={() => setLightboxCamera(null)} />
    </div>
  );
}

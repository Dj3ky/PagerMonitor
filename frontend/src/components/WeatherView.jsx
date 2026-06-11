import { useState, useEffect, useMemo, useRef } from 'react';
import { Wind, CloudRain, Thermometer, Cloud, Radar, LocateFixed, Loader } from 'lucide-react';
import { useSite } from '../context/SiteContext.jsx';
import { getCountryCenter } from '../utils/countryCenters.js';

const LAYERS = [
  { id: 'radar',  label: 'Radar',  icon: <Radar size={13}/>,       desc: 'Precipitation radar' },
  { id: 'rain',   label: 'Rain',   icon: <CloudRain size={13}/>,   desc: 'Rain forecast' },
  { id: 'wind',   label: 'Wind',   icon: <Wind size={13}/>,        desc: 'Wind speed & direction' },
  { id: 'temp',   label: 'Temp',   icon: <Thermometer size={13}/>, desc: 'Surface temperature' },
  { id: 'clouds', label: 'Clouds', icon: <Cloud size={13}/>,       desc: 'Cloud cover' },
];

// Windy JS API uses different overlay names than the iframe embed.
// 'radar' is not available in the API; map to the closest equivalent.
const API_OVERLAY = { radar: 'rain', rain: 'rain', wind: 'wind', temp: 'temp', clouds: 'clouds' };

// Module-level refs — survive component remounts and cross-effect communication.
// Captures are done once; cleared on page reload.
let _reactL   = null;  // react-leaflet Leaflet 1.9.x — preserved across swaps
let _windy14L = null;  // Leaflet 1.4.x — needed for Windy marker creation

function haversineKm(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lng - a.lng) * r;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

function buildWindyUrl(lat, lon, zoom, overlay, userLat, userLon) {
  const params = new URLSearchParams({
    lat: lat.toFixed(4), lon: lon.toFixed(4), zoom,
    level: 'surface', overlay, product: 'ecmwf',
    calendar: 'now', type: 'map',
    metricWind: 'default', metricTemp: 'default', radarRange: '-1',
  });
  if (userLat != null && userLon != null) {
    params.set('detailLat', userLat.toFixed(4));
    params.set('detailLon', userLon.toFixed(4));
    params.set('message', 'true');
  }
  return `https://embed.windy.com/embed2.html?${params}`;
}

// Shared toolbar used by both API and iframe modes
function Toolbar({ overlay, onOverlayChange, geoState, userPos, locationSharing }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.4rem',
      padding: '0.4rem 0.75rem', borderBottom: '1px solid var(--border)',
      background: 'var(--bg-1)', flexShrink: 0, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginRight: '0.2rem', whiteSpace: 'nowrap' }}>Layer:</span>
      {LAYERS.map(l => (
        <button key={l.id} title={l.desc} onClick={() => onOverlayChange(l.id)}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.3rem',
            padding: '0.25rem 0.55rem', borderRadius: '0.4rem', fontSize: '0.78rem',
            fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.15s',
            border: overlay === l.id
              ? '1px solid color-mix(in srgb, var(--accent-green) 35%, transparent)'
              : '1px solid var(--border)',
            background: overlay === l.id
              ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)'
              : 'var(--bg-3)',
            color: overlay === l.id ? 'var(--accent-green)' : 'var(--text-2)',
          }}>
          {l.icon} {l.label}
        </button>
      ))}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {geoState === 'denied' ? (
          <span style={{ fontSize: '0.68rem', color: 'var(--accent-amber)' }}>Location blocked</span>
        ) : (
          <button
            onClick={geoState === 'idle' ? locationSharing?.start : undefined}
            title={userPos ? 'Centered on your location' : 'Center on my location'}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.3rem',
              padding: '0.25rem 0.55rem', borderRadius: '0.4rem', fontSize: '0.72rem',
              fontWeight: 500, cursor: userPos ? 'default' : 'pointer',
              transition: 'all 0.15s', whiteSpace: 'nowrap',
              border: userPos
                ? '1px solid color-mix(in srgb, var(--accent-green) 35%, transparent)'
                : '1px solid var(--border)',
              background: userPos
                ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)'
                : 'var(--bg-3)',
              color: userPos ? 'var(--accent-green)' : 'var(--text-2)',
            }}>
            {geoState === 'asking'
              ? <><Loader size={12} style={{ animation: 'spin 1s linear infinite' }}/> Locating…</>
              : <><LocateFixed size={12}/> {userPos ? 'My location' : 'Use my location'}</>}
          </button>
        )}
        <span style={{ fontSize: '0.68rem', color: 'var(--text-3)' }}>
          Powered by <a href="https://www.windy.com" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>Windy</a>
        </span>
      </div>
    </div>
  );
}

// ── Windy JS API map — no iframe, smooth position updates ─────────────────────
function ApiMap({ windyApiKey, userPos, countryCenter, overlay, visible, onInitFail }) {
  const windyRef  = useRef(null);   // windyAPI instance
  const markerRef = useRef(null);   // Leaflet marker for user position
  const initRef   = useRef(false);  // windyInit called?
  const [ready, setReady] = useState(false); // true once windyInit callback fires

  // Windy's libBoot.js AND its async GL modules (gl-particles etc.) all access
  // window.L expecting Leaflet 1.4.x (.Layer.extend() removed in 1.9.x).
  // Strategy:
  //   1. Pre-load Leaflet 1.4.0 from CDN, capture it in _windy14L
  //   2. Keep window.L = 1.4.x until windyInit callback fires (all async modules done)
  //   3. In the callback, restore _reactL (react-leaflet 1.9.x)
  //   4. Safety timeout restores L if callback never fires (e.g. API error)
  useEffect(() => {
    if (!_reactL) _reactL = window.L; // capture once before any swap

    if (document.getElementById('windy-api-script')) return; // already loaded

    const lf = document.createElement('script');
    lf.id  = 'windy-leaflet14';
    lf.src = 'https://unpkg.com/leaflet@1.4.0/dist/leaflet.js';
    lf.addEventListener('load', () => {
      _windy14L = window.L; // capture 1.4.x — window.L stays 1.4.x for Windy

      const s = document.createElement('script');
      s.id  = 'windy-api-script';
      s.src = 'https://api.windy.com/assets/map-forecast/libBoot.js';
      // On network error only — normal path restores in windyInit callback
      s.addEventListener('error', () => { window.L = _reactL; });
      document.head.appendChild(s);
    });
    lf.addEventListener('error', () => { window.L = _reactL; });
    document.head.appendChild(lf);
  }, []);

  // Init when the tab becomes visible for the first time.
  // libBoot.js is a *boot loader* — it fetches the real SDK asynchronously,
  // so window.windyInit is not available when the script's own load event fires.
  // Poll every 100 ms until it becomes a function (max ~15 s).
  useEffect(() => {
    if (!visible || initRef.current) return;

    const lat        = userPos?.lat ?? countryCenter.lat;
    const lon        = userPos?.lng ?? countryCenter.lon;
    const zoom       = userPos ? 10  : countryCenter.zoom;
    const apiOverlay = API_OVERLAY[overlay] ?? 'wind';

    let cancelled = false;
    let timer;
    let attempts  = 0;

    const tryInit = () => {
      if (cancelled || initRef.current) return;
      if (typeof window.windyInit !== 'function') {
        if (++attempts < 150) timer = setTimeout(tryInit, 100);
        else window.L = _reactL; // timed out — restore L
        return;
      }
      initRef.current = true;

      // Safety: restore window.L if windyInit never calls back (e.g. API key error)
      const safetyTimer = setTimeout(() => { window.L = _reactL; }, 30_000);

      const handleFail = () => {
        clearTimeout(safetyTimer);
        window.L = _reactL;
        if (!cancelled) onInitFail?.();
      };

      const p = window.windyInit(
        { key: windyApiKey, verbose: false, lat, lon, zoom },
        (api) => {
          clearTimeout(safetyTimer);
          window.L = _reactL; // all Windy GL modules loaded — safe to restore
          if (cancelled) return;
          windyRef.current = api;
          setReady(true);
          try { api.store.set('overlay', apiOverlay); } catch (_) {}
        },
      );
      // windyInit returns a Promise — catch rejections (e.g. gl-particles WebGL failure)
      // so they don't surface as unhandled and we can fall back to iframe
      if (p && typeof p.catch === 'function') p.catch(handleFail);
    };

    tryInit();
    return () => { cancelled = true; clearTimeout(timer); };
  // Intentionally captures initial position once — subsequent moves use setView().
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Layer change — no reload needed
  useEffect(() => {
    const api = windyRef.current;
    if (!api) return;
    try { api.store.set('overlay', API_OVERLAY[overlay] ?? 'wind'); } catch (_) {}
  }, [overlay]);

  // Position update — smooth pan, no reload
  useEffect(() => {
    const api = windyRef.current;
    if (!api || !userPos) return;
    api.map.setView([userPos.lat, userPos.lng], api.map.getZoom());
    if (markerRef.current) {
      markerRef.current.setLatLng([userPos.lat, userPos.lng]);
    } else if (_windy14L) {
      const icon = _windy14L.divIcon({
        className: '',
        html: '<div style="width:14px;height:14px;background:#3b82f6;border:2.5px solid #fff;border-radius:50%;box-shadow:0 0 8px rgba(59,130,246,.7)"></div>',
        iconSize: [14, 14], iconAnchor: [7, 7],
      });
      markerRef.current = _windy14L.marker([userPos.lat, userPos.lng], { icon }).addTo(api.map);
    }
  }, [userPos]);

  // Leaflet needs invalidateSize() after a display:none parent becomes visible
  useEffect(() => {
    if (visible) requestAnimationFrame(() => windyRef.current?.map?.invalidateSize());
  }, [visible]);

  // Keep the div in DOM (Leaflet measures it) but invisible until windyInit fires.
  // This prevents the brief Windy logo blink before the fallback kicks in on failure.
  return <div id="windy" style={{ flex: 1, minHeight: 0, visibility: ready ? 'visible' : 'hidden' }} />;
}

// ── Iframe embed fallback — used when no API key is configured ────────────────
function IframeEmbed({ visible, userPos, geoState, countryCenter, overlay }) {
  const [iframeSrc, setIframeSrc] = useState(null);
  const loadedPosRef = useRef(null);

  useEffect(() => {
    if (userPos) {
      const prev  = loadedPosRef.current;
      const moved = !prev || haversineKm(prev, userPos) > 0.5;
      if (moved) {
        loadedPosRef.current = userPos;
        setIframeSrc(buildWindyUrl(userPos.lat, userPos.lng, 10, overlay, userPos.lat, userPos.lng));
      }
    } else if (
      geoState === 'denied' ||
      (geoState === 'idle' && localStorage.getItem('pm_location_prompt') !== 'granted')
    ) {
      const url = buildWindyUrl(countryCenter.lat, countryCenter.lon, countryCenter.zoom, overlay, null, null);
      setIframeSrc(prev => prev === url ? prev : url);
    } else {
      setIframeSrc(null);
    }
  }, [geoState, userPos, countryCenter, overlay]);

  if (!visible) return null;
  if (!iframeSrc) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center',
      flex:1, flexDirection:'column', gap:'0.75rem',
      color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem' }}>
      <div style={{ width:'24px', height:'24px', borderRadius:'50%',
        border:'3px solid var(--bg-4)', borderTopColor:'var(--accent-green)',
        animation:'spin 0.8s linear infinite' }} />
      Waiting for location…
    </div>
  );
  return (
    <iframe key={iframeSrc} src={iframeSrc} title="Windy weather radar"
      allow="geolocation; fullscreen"
      style={{ flex:1, width:'100%', border:'none', display:'block' }}
      allowFullScreen />
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function WeatherView({ visible, locationSharing }) {
  const { geocodeCountry, windyApiKey, settingsLoaded } = useSite();
  const [overlay, setOverlay]       = useState('radar');
  // Persist API failure within the session — avoids re-trying (and blinking) on refresh.
  // sessionStorage clears on tab close so Windy gets another chance next session.
  const [apiInitFailed, setApiFail] = useState(
    () => sessionStorage.getItem('pm_windy_api_failed') === '1'
  );

  const countryCenter = useMemo(() => getCountryCenter(geocodeCountry), [geocodeCountry]);
  const userPos  = locationSharing?.position ?? null;
  const geoState = locationSharing?.state    ?? 'idle';

  // useApi: attempt the JS API only when we have a key and init hasn't failed yet
  const useApi = settingsLoaded && !!windyApiKey && !apiInitFailed;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-0)' }}>
      <Toolbar overlay={overlay} onOverlayChange={setOverlay}
        geoState={geoState} userPos={userPos} locationSharing={locationSharing} />

      {useApi ? (
        <ApiMap
          windyApiKey={windyApiKey}
          userPos={userPos}
          countryCenter={countryCenter}
          overlay={overlay}
          visible={visible}
          onInitFail={() => {
            sessionStorage.setItem('pm_windy_api_failed', '1');
            setApiFail(true);
          }}
        />
      ) : (
        <IframeEmbed
          visible={visible}
          userPos={userPos}
          geoState={geoState}
          countryCenter={countryCenter}
          overlay={overlay}
        />
      )}
    </div>
  );
}

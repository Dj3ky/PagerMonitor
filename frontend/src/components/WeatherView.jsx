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
function ApiMap({ windyApiKey, userPos, countryCenter, overlay, visible }) {
  const windyRef     = useRef(null);  // windyAPI instance
  const markerRef    = useRef(null);  // Leaflet marker for user position
  const initRef      = useRef(false); // windyInit called?
  const [scriptReady, setScriptReady] = useState(!!window.windyInit);

  // Step 1 — load the Windy script (fire-and-forget, before tab is opened)
  useEffect(() => {
    if (window.windyInit) { setScriptReady(true); return; }
    let s = document.getElementById('windy-api-script');
    if (!s) {
      s = document.createElement('script');
      s.id = 'windy-api-script';
      s.src = 'https://api.windy.com/assets/map-forecast/libBoot.js';
      document.head.appendChild(s);
    }
    const onLoad = () => setScriptReady(true);
    s.addEventListener('load', onLoad);
    return () => s.removeEventListener('load', onLoad);
  }, []);

  // Step 2 — init only when the tab is visible AND the script is ready.
  // windyInit needs the #windy div to have real dimensions; calling it inside a
  // display:none parent causes Leaflet to size everything as 0×0.
  useEffect(() => {
    if (!visible || !scriptReady || initRef.current) return;
    initRef.current = true;
    const lat  = userPos?.lat ?? countryCenter.lat;
    const lon  = userPos?.lng ?? countryCenter.lon;
    const zoom = userPos ? 10  : countryCenter.zoom;
    window.windyInit(
      { key: windyApiKey, verbose: false, lat, lon, zoom },
      (api) => {
        windyRef.current = api;
        api.store.set('overlay', overlay);
      },
    );
  // Only re-run when the two readiness flags change; all other values are
  // captured once intentionally (initial center is set once, updates via setView).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, scriptReady]);

  // Layer change — no reload needed
  useEffect(() => {
    windyRef.current?.store.set('overlay', overlay);
  }, [overlay]);

  // Position update — smooth pan, no reload
  useEffect(() => {
    const api = windyRef.current;
    if (!api || !userPos) return;
    api.map.setView([userPos.lat, userPos.lng], api.map.getZoom());
    if (markerRef.current) {
      markerRef.current.setLatLng([userPos.lat, userPos.lng]);
    } else if (window.L) {
      const icon = window.L.divIcon({
        className: '',
        html: '<div style="width:14px;height:14px;background:#3b82f6;border:2.5px solid #fff;border-radius:50%;box-shadow:0 0 8px rgba(59,130,246,.7)"></div>',
        iconSize: [14, 14], iconAnchor: [7, 7],
      });
      markerRef.current = window.L.marker([userPos.lat, userPos.lng], { icon }).addTo(api.map);
    }
  }, [userPos]);

  // Leaflet needs invalidateSize() after a display:none parent becomes visible
  useEffect(() => {
    if (visible) requestAnimationFrame(() => windyRef.current?.map?.invalidateSize());
  }, [visible]);

  return <div id="windy" style={{ flex: 1, minHeight: 0 }} />;
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
  const [overlay, setOverlay] = useState('radar');

  const countryCenter = useMemo(() => getCountryCenter(geocodeCountry), [geocodeCountry]);
  const userPos  = locationSharing?.position ?? null;
  const geoState = locationSharing?.state    ?? 'idle';

  const useApi = settingsLoaded && !!windyApiKey;

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

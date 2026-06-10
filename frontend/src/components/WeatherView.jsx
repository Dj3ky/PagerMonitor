import { useState, useEffect, useMemo } from 'react';
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

function buildWindyUrl(lat, lon, zoom, overlay, userLat, userLon) {
  const params = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    zoom,
    level: 'surface',
    overlay,
    product: 'ecmwf',
    calendar: 'now',
    type: 'map',
    metricWind: 'default',
    metricTemp: 'default',
    radarRange: '-1',
  });
  // Only add the detail marker when we have the user's real GPS position
  if (userLat != null && userLon != null) {
    params.set('detailLat', userLat.toFixed(4));
    params.set('detailLon', userLon.toFixed(4));
    params.set('message', 'true');
  }
  return `https://embed.windy.com/embed2.html?${params}`;
}

export default function WeatherView({ visible, locationSharing }) {
  const { geocodeCountry } = useSite();
  const [overlay, setOverlay] = useState('radar');

  const countryCenter = useMemo(() => getCountryCenter(geocodeCountry), [geocodeCountry]);

  // Use position from the shared hook if available
  const userPos  = locationSharing?.position ?? null;  // { lat, lng }
  const geoState = locationSharing?.state    ?? 'idle';

  // Only build the Windy URL when we have a definitive state.
  // Requiring BOTH geoState==='active' AND userPos truthy guards against the
  // batching race where setState('active') fires before setPosition({lat,lng}).
  const [iframeSrc, setIframeSrc] = useState(null);
  useEffect(() => {
    if (geoState === 'active' && userPos) {
      // Real position available — center Windy on user's GPS coords
      const url = buildWindyUrl(userPos.lat, userPos.lng, 10, overlay, userPos.lat, userPos.lng);
      setIframeSrc(prev => prev === url ? prev : url);
    } else if (
      geoState === 'denied' ||
      (geoState === 'idle' && localStorage.getItem('pm_location_prompt') !== 'granted')
    ) {
      // Location refused or never asked — use country center (dot will be there)
      const url = buildWindyUrl(countryCenter.lat, countryCenter.lon, countryCenter.zoom, overlay, null, null);
      setIframeSrc(prev => prev === url ? prev : url);
    } else {
      // Still waiting for position (asking / idle+granted / active+noPos) — hold iframe
      setIframeSrc(null);
    }
  }, [geoState, userPos, countryCenter, overlay]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-0)' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.4rem',
        padding: '0.4rem 0.75rem', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-1)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginRight: '0.2rem', whiteSpace: 'nowrap' }}>Layer:</span>
        {LAYERS.map(l => (
          <button key={l.id} title={l.desc} onClick={() => setOverlay(l.id)}
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

        {/* Location status / request button */}
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

      {/* Windy iframe */}
      <div style={{ flex: 1, position: 'relative' }}>
        {visible && !iframeSrc ? (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center',
            height:'100%', flexDirection:'column', gap:'0.75rem',
            color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem' }}>
            <div style={{ width:'24px', height:'24px', borderRadius:'50%',
              border:'3px solid var(--bg-4)', borderTopColor:'var(--accent-green)',
              animation:'spin 0.8s linear infinite' }} />
            Waiting for location…
          </div>
        ) : visible && iframeSrc ? (
          <iframe
            key={iframeSrc}
            src={iframeSrc}
            title="Windy weather radar"
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            allowFullScreen
          />
        ) : null}
      </div>
    </div>
  );
}

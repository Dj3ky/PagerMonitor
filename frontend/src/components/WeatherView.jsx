import { useState, useMemo, useEffect } from 'react';
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
  // detailLat/detailLon place the marker — only include when we have the user's real location
  if (userLat != null && userLon != null) {
    params.set('detailLat', userLat.toFixed(4));
    params.set('detailLon', userLon.toFixed(4));
    params.set('message', 'true');
  }
  return `https://embed.windy.com/embed2.html?${params}`;
}

export default function WeatherView({ visible }) {
  const { geocodeCountry } = useSite();
  const [overlay, setOverlay]     = useState('radar');
  const [userPos, setUserPos]     = useState(null);   // { lat, lon } once granted
  const [geoState, setGeoState]   = useState('idle'); // 'idle' | 'asking' | 'granted' | 'denied'

  const countryCenter = getCountryCenter(geocodeCountry);

  // Center on user location if granted, otherwise country center
  const centerLat  = userPos ? userPos.lat : countryCenter.lat;
  const centerLon  = userPos ? userPos.lon : countryCenter.lon;
  const centerZoom = userPos ? 10          : countryCenter.zoom;

  const src = useMemo(
    () => buildWindyUrl(centerLat, centerLon, centerZoom, overlay,
                        userPos?.lat ?? null, userPos?.lon ?? null),
    [centerLat, centerLon, centerZoom, overlay, userPos]
  );

  const requestLocation = () => {
    if (!navigator.geolocation) { setGeoState('denied'); return; }
    setGeoState('asking');
    navigator.geolocation.getCurrentPosition(
      pos => {
        setUserPos({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setGeoState('granted');
      },
      () => setGeoState('denied'),
      { timeout: 10000 }
    );
  };

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

        {/* Location button */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {geoState !== 'denied' && (
            <button
              onClick={geoState === 'granted' ? undefined : requestLocation}
              title={geoState === 'granted' ? 'Centered on your location' : 'Center on my location'}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.3rem',
                padding: '0.25rem 0.55rem', borderRadius: '0.4rem', fontSize: '0.72rem',
                fontWeight: 500, cursor: geoState === 'granted' ? 'default' : 'pointer',
                transition: 'all 0.15s', whiteSpace: 'nowrap',
                border: geoState === 'granted'
                  ? '1px solid color-mix(in srgb, var(--accent-green) 35%, transparent)'
                  : '1px solid var(--border)',
                background: geoState === 'granted'
                  ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)'
                  : 'var(--bg-3)',
                color: geoState === 'granted' ? 'var(--accent-green)' : 'var(--text-2)',
              }}>
              {geoState === 'asking'
                ? <><Loader size={12} style={{ animation: 'spin 1s linear infinite' }}/> Locating…</>
                : <><LocateFixed size={12}/> {geoState === 'granted' ? 'My location' : 'Use my location'}</>}
            </button>
          )}
          {geoState === 'denied' && (
            <span style={{ fontSize: '0.68rem', color: 'var(--accent-amber)' }}>Location blocked</span>
          )}
          <span style={{ fontSize: '0.68rem', color: 'var(--text-3)' }}>
            Powered by <a href="https://www.windy.com" target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>Windy</a>
          </span>
        </div>
      </div>

      {/* Windy iframe */}
      <div style={{ flex: 1, position: 'relative' }}>
        {visible && (
          <iframe
            key={src}
            src={src}
            title="Windy weather radar"
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            allowFullScreen
          />
        )}
      </div>
    </div>
  );
}

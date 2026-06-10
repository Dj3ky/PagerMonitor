import { useState, useMemo } from 'react';
import { Wind, CloudRain, Thermometer, Cloud, Radar } from 'lucide-react';
import { useSite } from '../context/SiteContext.jsx';

const LAYERS = [
  { id: 'radar',  label: 'Radar',  icon: <Radar size={13}/>,       desc: 'Precipitation radar' },
  { id: 'rain',   label: 'Rain',   icon: <CloudRain size={13}/>,   desc: 'Rain forecast' },
  { id: 'wind',   label: 'Wind',   icon: <Wind size={13}/>,        desc: 'Wind speed & direction' },
  { id: 'temp',   label: 'Temp',   icon: <Thermometer size={13}/>, desc: 'Surface temperature' },
  { id: 'clouds', label: 'Clouds', icon: <Cloud size={13}/>,       desc: 'Cloud cover' },
];

// Default map center (same as MapView default)
const DEFAULT_LAT = 46.12;
const DEFAULT_LON = 14.80;
const DEFAULT_ZOOM = 7;

function buildWindyUrl(lat, lon, zoom, overlay) {
  const params = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    detailLat: lat.toFixed(4),
    detailLon: lon.toFixed(4),
    zoom,
    level: 'surface',
    overlay,
    product: 'ecmwf',
    message: 'true',
    calendar: 'now',
    type: 'map',
    location: 'coordinates',
    metricWind: 'default',
    metricTemp: 'default',
    radarRange: '-1',
  });
  return `https://embed.windy.com/embed2.html?${params}`;
}

export default function WeatherView({ visible }) {
  const { weatherLat, weatherLon, weatherZoom } = useSite();
  const [overlay, setOverlay] = useState('radar');

  const lat  = parseFloat(weatherLat)  || DEFAULT_LAT;
  const lon  = parseFloat(weatherLon)  || DEFAULT_LON;
  const zoom = parseInt(weatherZoom)   || DEFAULT_ZOOM;

  const src = useMemo(() => buildWindyUrl(lat, lon, zoom, overlay), [lat, lon, zoom, overlay]);

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
        <span style={{ marginLeft: 'auto', fontSize: '0.68rem', color: 'var(--text-3)' }}>
          Powered by <a href="https://www.windy.com" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>Windy</a>
        </span>
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

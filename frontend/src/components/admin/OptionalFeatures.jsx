import { useState, useEffect } from 'react';
import { SlidersHorizontal, Save, Camera, Plane, CloudRain, Siren } from 'lucide-react';
import { useSite } from '../../context/SiteContext.jsx';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m,p,b) => fetch(`${BASE}${p}`,{method:m,headers:{'Content-Type':'application/json','Authorization':`Bearer ${tok()}`},body:b?JSON.stringify(b):undefined}).then(r=>r.json());

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div style={{ padding:'0.45rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem',
      fontFamily:'monospace', marginBottom:'0.75rem',
      color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
      background: `color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)` }}>
      {msg.text}
    </div>
  );
}

const FEATURES = [
  { key: 'enableTraffic', icon: <Camera size={15}/>, label: 'Traffic',
    desc: 'DARS/DRSI cameras, road works, incidents & variable message signs (NAP). Hides the Traffic menu and stops polling b2b.nap.si.' },
  { key: 'enableAircraft', icon: <Plane size={15}/>, label: 'Aircraft',
    desc: 'Live wildfire aircraft tracking (OpenSky). Hides the Aircraft menu and stops polling the OpenSky API.' },
  { key: 'enableArsoWeather', icon: <CloudRain size={15}/>, label: 'ARSO Weather',
    desc: 'Slovenia-specific ARSO station data, SMOK river/water levels, and ARSO seismology (earthquakes). Removes the ARSO, Water & Quakes layers from the Weather menu and stops polling all three feeds. The base Windy weather map stays available.' },
  { key: 'enableInterventions', icon: <Siren size={15}/>, label: 'SPIN',
    desc: 'Live SPIN public-safety intervention feed for Slovenia (fires, traffic accidents, technical assistance, and more), with a searchable archive. Hides the SPIN menu and stops the background feed.' },
];

export default function OptionalFeatures() {
  const { update: updateSite, geocodeCountry } = useSite();
  // All off by default — opt-in, not opt-out.
  const [cfg, setCfg]       = useState({ enableTraffic: false, enableAircraft: false, enableArsoWeather: false, enableInterventions: false });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState(null);

  useEffect(() => {
    api('GET', '/admin/site-settings')
      .then(d => setCfg({
        enableTraffic:     d.enableTraffic     === true,
        enableAircraft:    d.enableAircraft    === true,
        enableArsoWeather: d.enableArsoWeather === true,
        enableInterventions: d.enableInterventions === true,
      }))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const save = async () => {
    setSaving(true);
    try {
      await api('PUT', '/admin/site-settings', cfg);
      updateSite(cfg);
      flash('ok', 'Saved');
    } catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ maxWidth: '560px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem',
        display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <SlidersHorizontal size={16} style={{ color:'var(--accent-blue)' }} /> Optional Features
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem', lineHeight:1.6 }}>
        Turn off the extra data sources you don't need. Disabling a feature hides its menu for
        everyone on this instance and stops the background fetch that feeds it — nothing keeps
        running or polling external APIs in the background once turned off.
      </p>

      {geocodeCountry !== 'si' && (
        <div style={{ padding:'0.6rem 0.8rem', borderRadius:'0.4rem', fontSize:'0.78rem',
          color:'var(--accent-orange, #d29922)', lineHeight:1.5, marginBottom:'0.75rem',
          background:'color-mix(in srgb, var(--accent-orange, #d29922) 10%, transparent)',
          border:'1px solid color-mix(in srgb, var(--accent-orange, #d29922) 30%, transparent)' }}>
          All four features below are Slovenia-specific data sources and stay inactive regardless
          of these toggles until <strong>Geocoding country code</strong> (Site Settings → Map) is set
          to <code>si</code>. Currently set to {geocodeCountry ? <code>{geocodeCountry}</code> : 'not set'}.
        </div>
      )}

      <div className="pm-card">
        <Flash msg={msg} />

        {FEATURES.map((f, i) => (
          <div key={f.key} style={{
            marginBottom: i === FEATURES.length - 1 ? '1.25rem' : '1rem',
            paddingBottom: i === FEATURES.length - 1 ? 0 : '1rem',
            borderBottom: i === FEATURES.length - 1 ? 'none' : '1px solid var(--border-soft)',
          }}>
            <label style={{ display:'flex', alignItems:'flex-start', gap:'0.6rem', cursor:'pointer' }}>
              <input type="checkbox" checked={!!cfg[f.key]} style={{ marginTop:'3px' }}
                onChange={e => setCfg(c => ({ ...c, [f.key]: e.target.checked }))} />
              <div>
                <div style={{ display:'flex', alignItems:'center', gap:'0.4rem', fontSize:'0.9rem',
                  fontWeight:600, color:'var(--text-1)' }}>
                  {f.icon} {f.label}
                </div>
                <div style={{ fontSize:'0.72rem', color:'var(--text-3)', marginTop:'0.25rem', lineHeight:1.5 }}>
                  {f.desc}
                </div>
              </div>
            </label>
          </div>
        ))}

        <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving || !loaded}>
          <Save size={13} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

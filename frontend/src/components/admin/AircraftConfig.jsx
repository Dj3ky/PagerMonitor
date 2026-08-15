import { useState, useEffect } from 'react';
import { Plane, Save, Eye, EyeOff } from 'lucide-react';
import { useSite } from '../../context/SiteContext.jsx';

const BASE     = import.meta.env.VITE_BACKEND_URL || '';
const getToken = () => localStorage.getItem('pm_token') || '';

async function fetchConfig() {
  const r = await fetch(`${BASE}/admin/opensky/config`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function saveConfig(cfg) {
  const r = await fetch(`${BASE}/admin/opensky/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export default function AircraftConfig() {
  const { geocodeCountry } = useSite();
  const [clientId, setClientId]         = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [show, setShow]       = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState(null);

  useEffect(() => {
    fetchConfig()
      .then(d => { setClientId(d.clientId || ''); setClientSecret(d.clientSecret || ''); })
      .catch(console.warn)
      .finally(() => setLoading(false));
  }, []);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  const save = async () => {
    setSaving(true);
    try {
      await saveConfig({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      flash('ok', 'Saved — aircraft tracking restarted with the new credentials');
    } catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const authenticated = !loading && clientId.trim() && clientSecret.trim();

  return (
    <div style={{ maxWidth:'600px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem',
        display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Plane size={16} style={{ color:'var(--accent-blue)' }} /> Aircraft Tracking
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1.25rem', lineHeight:1.6 }}>
        Tracks Slovenia's Fire Boss wildfire aircraft (S5-BZR/BZS/BZT/BZU) via the OpenSky Network.
        Without credentials, tracking uses anonymous access (400 credits/day, polls every 5 min).
        Register a free account at{' '}
        <a href="https://opensky-network.org" target="_blank" rel="noreferrer" style={{ color:'var(--accent-blue)' }}>opensky-network.org</a>,
        then create an API client on your Account page to get a Client ID and Secret below
        (Standard tier: 4000 credits/day, polls every 1 min).
      </p>

      {geocodeCountry !== 'si' && (
        <div style={{ padding:'0.6rem 0.8rem', borderRadius:'0.4rem', fontSize:'0.78rem',
          color:'var(--accent-orange, #d29922)', lineHeight:1.5, marginBottom:'0.75rem',
          background:'color-mix(in srgb, var(--accent-orange, #d29922) 10%, transparent)',
          border:'1px solid color-mix(in srgb, var(--accent-orange, #d29922) 30%, transparent)' }}>
          This tracks a Slovenia-specific bounding box and stays inactive until <strong>Geocoding
          country code</strong> (Site Settings → Map) is set to <code>si</code>. Currently set to{' '}
          {geocodeCountry ? <code>{geocodeCountry}</code> : 'not set'}.
        </div>
      )}

      {msg && (
        <div style={{ padding:'0.45rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem',
          fontFamily:'monospace', marginBottom:'0.75rem',
          color: msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)',
          background: `color-mix(in srgb, ${msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
        }}>{msg.text}</div>
      )}

      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title">API credentials</div>
        <div style={{ fontSize:'0.75rem', marginBottom:'0.75rem',
          color: authenticated ? 'var(--accent-green)' : 'var(--text-3)' }}>
          {authenticated ? 'Authenticated — polling every 1 min' : 'Not configured — anonymous access, polling every 5 min'}
        </div>

        <label style={{ fontSize:'0.75rem', color:'var(--text-3)', display:'block', marginBottom:'0.3rem' }}>Client ID</label>
        <input className="pm-input" type="text" value={clientId} onChange={e => setClientId(e.target.value)}
          placeholder="OpenSky API client ID" style={{ marginBottom:'0.75rem' }} />

        <label style={{ fontSize:'0.75rem', color:'var(--text-3)', display:'block', marginBottom:'0.3rem' }}>Client Secret</label>
        <div style={{ position:'relative', marginBottom:'0.75rem' }}>
          <input className="pm-input" type={show ? 'text' : 'password'} value={clientSecret}
            onChange={e => setClientSecret(e.target.value)} placeholder="OpenSky API client secret"
            style={{ paddingRight:'2.5rem' }} />
          <button onClick={() => setShow(s => !s)} style={{
            position:'absolute', right:'0.5rem', top:'50%', transform:'translateY(-50%)',
            background:'none', border:'none', cursor:'pointer', color:'var(--text-3)' }}>
            {show ? <EyeOff size={14}/> : <Eye size={14}/>}
          </button>
        </div>

        <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving || loading}>
          <Save size={13}/> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { Camera, Save, Eye, EyeOff } from 'lucide-react';

const BASE     = import.meta.env.VITE_BACKEND_URL || '';
const getToken = () => localStorage.getItem('pm_token') || '';

async function fetchConfig() {
  const r = await fetch(`${BASE}/admin/nap/config`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function saveConfig(cfg) {
  const r = await fetch(`${BASE}/admin/nap/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export default function NapTrafficConfig() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus]     = useState(null);
  const [show, setShow]         = useState(false);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [msg, setMsg]           = useState(null);

  useEffect(() => {
    fetchConfig()
      .then(d => { setUsername(d.username || ''); setPassword(d.password || ''); setStatus(d.status || null); })
      .catch(console.warn)
      .finally(() => setLoading(false));
  }, []);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  const save = async () => {
    setSaving(true);
    try {
      await saveConfig({ username: username.trim(), password: password.trim() });
      flash('ok', 'Saved — traffic data restarted with the new credentials');
      const d = await fetchConfig();
      setStatus(d.status || null);
    } catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const configured = !loading && username.trim() && password.trim();

  return (
    <div style={{ maxWidth:'600px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem',
        display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Camera size={16} style={{ color:'var(--accent-blue)' }} /> Traffic Data (NAP)
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1.25rem', lineHeight:1.6 }}>
        Road cameras (DARS/DRSI) from the National Access Point B2B feed at{' '}
        <code style={{ fontSize:'0.75rem' }}>b2b.nap.si</code>. Enter the B2B account credentials
        issued by NAP below — the same account will also cover road works, variable message
        signs and traffic info feeds as they're added.
      </p>

      {msg && (
        <div style={{ padding:'0.45rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem',
          fontFamily:'monospace', marginBottom:'0.75rem',
          color: msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)',
          background: `color-mix(in srgb, ${msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
        }}>{msg.text}</div>
      )}

      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title">B2B credentials</div>
        <div style={{ fontSize:'0.75rem', marginBottom:'0.75rem',
          color: configured ? 'var(--accent-green)' : 'var(--text-3)' }}>
          {configured ? 'Configured' : 'Not configured — cameras layer is empty until credentials are saved'}
          {status?.updatedAt && <> · last refreshed {new Date(status.updatedAt).toLocaleString()}</>}
        </div>

        <label style={{ fontSize:'0.75rem', color:'var(--text-3)', display:'block', marginBottom:'0.3rem' }}>Username</label>
        <input className="pm-input" type="text" value={username} onChange={e => setUsername(e.target.value)}
          placeholder="NAP B2B username" style={{ marginBottom:'0.75rem' }} autoComplete="off" />

        <label style={{ fontSize:'0.75rem', color:'var(--text-3)', display:'block', marginBottom:'0.3rem' }}>Password</label>
        <div style={{ position:'relative', marginBottom:'0.75rem' }}>
          <input className="pm-input" type={show ? 'text' : 'password'} value={password}
            onChange={e => setPassword(e.target.value)} placeholder="NAP B2B password"
            style={{ paddingRight:'2.5rem' }} autoComplete="new-password" />
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

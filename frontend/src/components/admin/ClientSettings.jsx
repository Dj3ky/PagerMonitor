import { useState, useEffect } from 'react';
import { Wifi, Save, RefreshCw, Copy, Eye, EyeOff, CheckCircle } from 'lucide-react';

const BASE     = import.meta.env.VITE_BACKEND_URL || '';
const getToken = () => localStorage.getItem('pm_token') || '';

async function fetchClientKey() {
  const r = await fetch(`${BASE}/admin/client-key`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function saveClientKey(key) {
  const r = await fetch(`${BASE}/admin/client-key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ key }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function generateKey() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function ClientSettings() {
  const [key, setKey]         = useState('');
  const [show, setShow]       = useState(false);
  const [saving, setSaving]   = useState(false);
  const [copied, setCopied]   = useState(false);
  const [msg, setMsg]         = useState(null);

  useEffect(() => {
    fetchClientKey()
      .then(d => setKey(d.key || ''))
      .catch(console.warn);
  }, []);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  const save = async () => {
    if (!key.trim()) { flash('err', 'Key cannot be empty'); return; }
    setSaving(true);
    try { await saveClientKey(key.trim()); flash('ok', 'Client key saved'); }
    catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const copy = () => {
    navigator.clipboard.writeText(key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const serverUrl = window.location.origin;

  return (
    <div style={{ maxWidth:'600px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem',
        display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Wifi size={16} style={{ color:'var(--accent-blue)' }} /> Remote SDR Client
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1.25rem', lineHeight:1.6 }}>
        Run PagerMonitor Client on a Raspberry Pi with RTL-SDR. It will forward decoded messages
        to this server without needing a database, web server, or display on the Pi.
      </p>

      {msg && (
        <div style={{ padding:'0.45rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem',
          fontFamily:'monospace', marginBottom:'0.75rem',
          color: msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)',
          background: `color-mix(in srgb, ${msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
        }}>{msg.text}</div>
      )}

      {/* Client key */}
      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title">Shared secret key</div>
        <p style={{ fontSize:'0.78rem', color:'var(--text-3)', marginBottom:'0.75rem' }}>
          This key authenticates the RPi client. Set the same value in the client's <code>.env</code> as <code>CLIENT_KEY</code>.
        </p>
        <div style={{ display:'flex', gap:'0.5rem', marginBottom:'0.75rem' }}>
          <div style={{ position:'relative', flex:1 }}>
            <input className="pm-input" type={show ? 'text' : 'password'}
              value={key} onChange={e => setKey(e.target.value)}
              placeholder="Paste or generate a key…"
              style={{ fontFamily:'monospace', paddingRight:'2.5rem' }} />
            <button onClick={() => setShow(s => !s)} style={{
              position:'absolute', right:'0.5rem', top:'50%', transform:'translateY(-50%)',
              background:'none', border:'none', cursor:'pointer', color:'var(--text-3)' }}>
              {show ? <EyeOff size={14}/> : <Eye size={14}/>}
            </button>
          </div>
          <button className="pm-btn" onClick={copy} title="Copy key" style={{ flexShrink:0 }}>
            {copied ? <CheckCircle size={13} style={{ color:'var(--accent-green)' }}/> : <Copy size={13}/>}
          </button>
          <button className="pm-btn" onClick={() => setKey(generateKey())} title="Generate new key" style={{ flexShrink:0 }}>
            <RefreshCw size={13}/> Generate
          </button>
        </div>
        <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving || !key.trim()}>
          <Save size={13}/> {saving ? 'Saving…' : 'Save key'}
        </button>
      </div>

      {/* Client .env config */}
      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title">RPi client configuration</div>
        <p style={{ fontSize:'0.78rem', color:'var(--text-3)', marginBottom:'0.75rem' }}>
          Put this in <code>~/pagermonitor-client/.env</code> on the Raspberry Pi:
        </p>
        <pre style={{ background:'var(--bg-0)', border:'1px solid var(--border)', borderRadius:'0.4rem',
          padding:'0.75rem 1rem', fontSize:'0.75rem', fontFamily:'monospace', overflowX:'auto',
          color:'var(--text-1)', margin:0, lineHeight:1.7 }}>
{`SERVER_URL=${serverUrl}
CLIENT_KEY=${key || '<your-key-here>'}
CLIENT_ID=rpi-1

RTL_FM_FREQ=173.250M
RTL_FM_GAIN=40
RTL_FM_DEVICE_INDEX=0
MULTIMON_PROTOCOLS=POCSAG1200
MULTIMON_QUIET=1`}
        </pre>
      </div>

      {/* Install steps */}
      <div className="pm-card">
        <div className="pm-section-title">RPi install steps</div>
        <div style={{ fontSize:'0.8rem', color:'var(--text-2)', lineHeight:2, fontFamily:'monospace' }}>
          {[
            '# On the Raspberry Pi:',
            'mkdir ~/pagermonitor-client && cd ~/pagermonitor-client',
            '# Copy client/ folder from the PagerMonitor archive',
            'npm install',
            'cp .env.example .env && nano .env',
            '',
            '# Install as a systemd service:',
            'bash install.sh',
            '',
            '# Or manually:',
            'sudo cp systemd/pagermonitor-client.service /etc/systemd/system/',
            'sudo systemctl daemon-reload',
            'sudo systemctl enable --now pagermonitor-client',
            'sudo journalctl -u pagermonitor-client -f',
          ].map((line, i) => (
            <div key={i} style={{ color: line.startsWith('#') ? 'var(--text-3)' : 'var(--accent-green)' }}>
              {line || '\u00A0'}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

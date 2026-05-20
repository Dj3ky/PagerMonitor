import { useState, useEffect } from 'react';
import { Mail, Save, Play, Eye, EyeOff } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m, p, b) => fetch(`${BASE}${p}`, {
  method: m, headers: { 'Content-Type':'application/json', Authorization:`Bearer ${tok()}` },
  body: b ? JSON.stringify(b) : undefined,
}).then(r => r.json());

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return <div style={{ padding:'0.4rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem',
    fontFamily:'monospace', marginBottom:'0.75rem',
    color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
    background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,
    border:`1px solid color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 30%,transparent)`,
  }}>{msg.text}</div>;
}

const DEFAULTS = { enabled:false, host:'', port:587, secure:false, user:'', password:'', from:'' };

export default function EmailConfig() {
  const [cfg, setCfg]         = useState(DEFAULTS);
  const [saving, setSaving]   = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo]   = useState('');
  const [showPw, setShowPw]   = useState(false);
  const [msg, setMsg]         = useState(null);

  const flash = (type, text) => { setMsg({type,text}); setTimeout(() => setMsg(null), 4000); };

  useEffect(() => {
    api('GET', '/admin/email/config').then(d => setCfg({ ...DEFAULTS, ...d })).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    try { await api('PUT', '/admin/email/config', cfg); flash('ok', 'Email settings saved'); }
    catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const test = async () => {
    if (!testTo) return flash('err', 'Enter a test email address');
    setTesting(true);
    try {
      const r = await api('POST', '/admin/email/test', { to: testTo });
      if (r.ok) flash('ok', `Test email sent to ${testTo}`);
      else flash('err', r.error || 'Failed');
    } catch (e) { flash('err', e.message); }
    finally { setTesting(false); }
  };

  return (
    <div style={{ maxWidth:'540px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem',
        display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Mail size={16} style={{ color:'var(--accent-blue)' }}/> Email (SMTP)
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem', lineHeight:1.6 }}>
        Configure SMTP to send email notifications and password reset links.
        Each user can set their own notification filter in their profile.
      </p>

      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <Flash msg={msg} />

        <label style={{ display:'flex', alignItems:'center', gap:'0.6rem', marginBottom:'1rem',
          fontSize:'0.9rem', cursor:'pointer', color:'var(--text-1)' }}>
          <input type="checkbox" checked={cfg.enabled}
            onChange={e => setCfg(c => ({ ...c, enabled: e.target.checked }))} />
          Enable email notifications
        </label>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.75rem',
          opacity: cfg.enabled ? 1 : 0.45, transition:'opacity 0.2s' }}>

          <div style={{ gridColumn:'1/-1' }}>
            <label className="pm-label">SMTP Host</label>
            <input className="pm-input" value={cfg.host} placeholder="smtp.gmail.com"
              onChange={e => setCfg(c => ({ ...c, host: e.target.value }))} />
          </div>

          <div>
            <label className="pm-label">Port</label>
            <input className="pm-input" type="number" value={cfg.port} placeholder="587"
              onChange={e => setCfg(c => ({ ...c, port: parseInt(e.target.value) || 587 }))} />
          </div>

          <div style={{ display:'flex', alignItems:'flex-end', paddingBottom:'0.25rem' }}>
            <label style={{ display:'flex', alignItems:'center', gap:'0.5rem', fontSize:'0.82rem', cursor:'pointer', color:'var(--text-1)' }}>
              <input type="checkbox" checked={cfg.secure}
                onChange={e => {
                  const secure = e.target.checked;
                  setCfg(c => ({
                    ...c,
                    secure,
                    // Auto-switch port: 465 for SSL, 587 for STARTTLS
                    // Only auto-switch if port is still at a default value
                    port: (c.port === 465 || c.port === 587)
                      ? (secure ? 465 : 587)
                      : c.port,
                  }));
                }} />
              <div>
                SSL/TLS (port 465)
                <div style={{ fontSize:'0.65rem', color:'var(--text-3)' }}>Uncheck for STARTTLS (port 587)</div>
              </div>
            </label>
          </div>

          <div>
            <label className="pm-label">Username</label>
            <input className="pm-input" value={cfg.user} placeholder="alerts@example.com"
              onChange={e => setCfg(c => ({ ...c, user: e.target.value }))} />
          </div>

          <div>
            <label className="pm-label">Password</label>
            <div style={{ position:'relative' }}>
              <input className="pm-input" type={showPw ? 'text' : 'password'}
                value={cfg.password} placeholder="app password or SMTP password"
                onChange={e => setCfg(c => ({ ...c, password: e.target.value }))}
                style={{ paddingRight:'2.2rem' }} />
              <button onClick={() => setShowPw(s => !s)}
                style={{ position:'absolute', right:'0.4rem', top:'50%', transform:'translateY(-50%)',
                  background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:'0.1rem' }}>
                {showPw ? <EyeOff size={14}/> : <Eye size={14}/>}
              </button>
            </div>
          </div>

          <div style={{ gridColumn:'1/-1' }}>
            <label className="pm-label">From address</label>
            <input className="pm-input" value={cfg.from}
              placeholder='PagerMonitor <alerts@example.com>'
              onChange={e => setCfg(c => ({ ...c, from: e.target.value }))} />
            <div style={{ fontSize:'0.65rem', color:'var(--text-3)', marginTop:'0.2rem' }}>
              Leave empty to use the username as from address.
            </div>
          </div>
        </div>

        <div style={{ marginTop:'0.75rem', display:'flex', gap:'0.5rem', flexWrap:'wrap' }}>
          <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
            <Save size={13}/> {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>

      {/* Test email */}
      <div className="pm-card">
        <div className="pm-section-title"><Play size={13}/> Send test email</div>
        <div style={{ display:'flex', gap:'0.5rem' }}>
          <input className="pm-input" style={{ flex:1 }} type="email" value={testTo}
            onChange={e => setTestTo(e.target.value)} placeholder="recipient@example.com"
            onKeyDown={e => e.key === 'Enter' && test()} />
          <button className="pm-btn pm-btn-primary" onClick={test} disabled={testing || !cfg.enabled}>
            <Play size={13}/> {testing ? 'Sending…' : 'Send test'}
          </button>
        </div>
        {!cfg.enabled && <div style={{ fontSize:'0.72rem', color:'var(--accent-amber)', marginTop:'0.4rem' }}>Enable email first</div>}
      </div>

      {/* Tips */}
      <div className="pm-card" style={{ marginTop:'1rem', fontSize:'0.78rem', color:'var(--text-3)', lineHeight:1.7 }}>
        <div className="pm-section-title">Provider settings</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem' }}>
          {[
            { name:'Gmail',       host:'smtp.gmail.com',       port:'587', note:'Use App Password (2FA required)' },
            { name:'Outlook/365', host:'smtp.office365.com',   port:'587', note:'Use your Microsoft password' },
            { name:'SendGrid',    host:'smtp.sendgrid.net',    port:'587', note:'API key as password, user=apikey' },
            { name:'Mailgun',     host:'smtp.mailgun.org',     port:'587', note:'SMTP credentials from Mailgun' },
          ].map(p => (
            <div key={p.name} style={{ background:'var(--bg-0)', padding:'0.5rem', borderRadius:'0.35rem', border:'1px solid var(--border-soft)' }}>
              <div style={{ fontWeight:600, color:'var(--text-1)', marginBottom:'0.15rem' }}>{p.name}</div>
              <div style={{ fontFamily:'monospace', fontSize:'0.68rem' }}>{p.host}:{p.port}</div>
              <div style={{ fontSize:'0.65rem', color:'var(--text-3)', marginTop:'0.1rem' }}>{p.note}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

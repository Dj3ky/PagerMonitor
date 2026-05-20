import { useState } from 'react';
import { Lock } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';

export default function PasswordResetPage({ token }) {
  const [pw, setPw]       = useState({ next:'', confirm:'' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]     = useState(null);
  const [done, setDone]   = useState(false);

  const submit = async () => {
    if (pw.next.length < 6) return setMsg({ type:'err', text:'Password must be at least 6 characters' });
    if (pw.next !== pw.confirm) return setMsg({ type:'err', text:'Passwords do not match' });
    setSaving(true);
    try {
      const r = await fetch(`${BASE}/auth/reset-password`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token, password: pw.next }),
      });
      const d = await r.json();
      if (r.ok) {
        setDone(true);
        // Clear token from URL
        window.history.replaceState({}, '', '/');
      } else {
        setMsg({ type:'err', text: d.error || 'Reset failed' });
      }
    } catch (e) { setMsg({ type:'err', text: e.message }); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'var(--bg-0)', padding:'1rem' }}>
      <div style={{ width:'100%', maxWidth:'360px' }}>
        <div style={{ textAlign:'center', marginBottom:'1.5rem' }}>
          <Lock size={32} style={{ color:'var(--accent-green)', marginBottom:'0.5rem' }} />
          <div style={{ fontSize:'1.3rem', fontWeight:700, color:'var(--text-1)' }}>Set new password</div>
        </div>

        {done ? (
          <div style={{ textAlign:'center', color:'var(--accent-green)', lineHeight:1.7 }}>
            ✓ Password changed successfully!<br/>
            <a href="/" style={{ color:'var(--accent-blue)', fontSize:'0.85rem' }}>Go to login →</a>
          </div>
        ) : (
          <>
            {[{ label:'New password', key:'next' }, { label:'Confirm password', key:'confirm' }].map(f => (
              <div key={f.key} style={{ marginBottom:'0.75rem' }}>
                <label style={{ fontSize:'0.8rem', color:'var(--text-2)', display:'block', marginBottom:'0.2rem' }}>{f.label}</label>
                <input type="password" value={pw[f.key]} onChange={e => setPw(p => ({ ...p, [f.key]: e.target.value }))}
                  className="pm-input" style={{ width:'100%', boxSizing:'border-box' }}
                  onKeyDown={e => e.key === 'Enter' && submit()} />
              </div>
            ))}
            {msg && <div style={{ color: msg.type==='ok'?'var(--accent-green)':'var(--accent-red)',
              fontSize:'0.78rem', marginBottom:'0.5rem' }}>{msg.text}</div>}
            <button onClick={submit} disabled={saving} style={{ width:'100%', padding:'0.6rem',
              borderRadius:'0.5rem', fontWeight:600, cursor:'pointer',
              background:'color-mix(in srgb,var(--accent-green) 18%,transparent)',
              border:'1px solid color-mix(in srgb,var(--accent-green) 40%,transparent)',
              color:'var(--accent-green)' }}>
              {saving ? 'Saving…' : 'Set new password'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

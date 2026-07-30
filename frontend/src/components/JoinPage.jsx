import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { authJoin } from '../utils/api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Reached via an invite link (?invite=CODE) generated from an org's Users panel —
// joining puts the new account straight into that org, seeing its existing groups/
// aliases/feed filter immediately (a live-shared workspace, not a one-time copy).
export default function JoinPage({ code }) {
  const { login } = useAuth();
  const [form, setForm]     = useState({ username:'', password:'', email:'' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState(null);

  const submit = async () => {
    if (!form.username || form.password.length < 6) {
      setMsg({ type:'err', text:'Username required, password must be at least 6 characters' });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const d = await authJoin(code, form.username, form.password, form.email || undefined);
      localStorage.setItem('pm_token', d.token);
      window.history.replaceState({}, '', '/');
      window.location.reload(); // simplest way to pick up the new session everywhere (WS, AuthContext)
    } catch (e) {
      setMsg({ type:'err', text: e.message });
      setSaving(false);
    }
  };

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'var(--bg-0)', padding:'1rem' }}>
      <div style={{ width:'100%', maxWidth:'360px' }}>
        <div style={{ textAlign:'center', marginBottom:'1.5rem' }}>
          <UserPlus size={32} style={{ color:'var(--accent-green)', marginBottom:'0.5rem' }} />
          <div style={{ fontSize:'1.3rem', fontWeight:700, color:'var(--text-1)' }}>Join organization</div>
          <div style={{ fontSize:'0.8rem', color:'var(--text-3)', marginTop:'0.25rem' }}>
            You've been invited — create your account to get instant access.
          </div>
        </div>

        <div style={{ marginBottom:'0.75rem' }}>
          <label style={{ fontSize:'0.8rem', color:'var(--text-2)', display:'block', marginBottom:'0.2rem' }}>Username</label>
          <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            className="pm-input" style={{ width:'100%', boxSizing:'border-box' }} />
        </div>
        <div style={{ marginBottom:'0.75rem' }}>
          <label style={{ fontSize:'0.8rem', color:'var(--text-2)', display:'block', marginBottom:'0.2rem' }}>Password (min 6 characters)</label>
          <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            className="pm-input" style={{ width:'100%', boxSizing:'border-box' }}
            onKeyDown={e => e.key === 'Enter' && submit()} />
        </div>
        <div style={{ marginBottom:'0.75rem' }}>
          <label style={{ fontSize:'0.8rem', color:'var(--text-2)', display:'block', marginBottom:'0.2rem' }}>Email (optional)</label>
          <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            className="pm-input" style={{ width:'100%', boxSizing:'border-box' }} />
        </div>

        {msg && <div style={{ color: 'var(--accent-red)', fontSize:'0.78rem', marginBottom:'0.5rem' }}>{msg.text}</div>}

        <button onClick={submit} disabled={saving} style={{ width:'100%', padding:'0.6rem',
          borderRadius:'0.5rem', fontWeight:600, cursor:'pointer',
          background:'color-mix(in srgb,var(--accent-green) 18%,transparent)',
          border:'1px solid color-mix(in srgb,var(--accent-green) 40%,transparent)',
          color:'var(--accent-green)' }}>
          {saving ? 'Joining…' : 'Create account & join'}
        </button>
      </div>
    </div>
  );
}

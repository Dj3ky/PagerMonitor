import { useState, useEffect } from 'react';
import { Archive, Save, Play, RefreshCw } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m, p, b) => fetch(`${BASE}${p}`, {
  method: m,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok()}` },
  body: b ? JSON.stringify(b) : undefined,
}).then(r => r.json());

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div style={{ padding:'0.4rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem',
      fontFamily:'monospace', marginBottom:'0.75rem',
      color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
      background: `color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
    }}>{msg.text}</div>
  );
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('sl-SI', { day:'numeric', month:'numeric', year:'numeric' });
}

export default function ArchiveConfig() {
  const [cfg, setCfg]       = useState({ enabled: false, afterDays: 30 });
  const [stats, setStats]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg]       = useState(null);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  const loadStats = () =>
    api('GET', '/admin/archive/stats').then(d => setStats(d)).catch(() => {});

  useEffect(() => {
    api('GET', '/admin/archive/config').then(d => setCfg(d)).catch(() => {});
    loadStats();
  }, []);

  const save = async () => {
    setSaving(true);
    try { await api('PUT', '/admin/archive/config', cfg); flash('ok', 'Saved'); }
    catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const runNow = async () => {
    if (!confirm(`Archive all messages older than ${cfg.afterDays} days now?`)) return;
    setRunning(true);
    try {
      const r = await api('POST', '/admin/archive/run', { days: cfg.afterDays });
      flash('ok', `Archived ${r.archived} messages`);
      loadStats();
    } catch (e) { flash('err', e.message); }
    finally { setRunning(false); }
  };

  return (
    <div style={{ maxWidth: '520px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem',
        display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Archive size={16} style={{ color:'var(--accent-blue)' }}/> Message Archiving
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem', lineHeight:1.6 }}>
        Automatically move old messages to a separate <code>archive.db</code> instead of deleting them.
        Archived messages remain searchable via the Archive section.
      </p>

      {/* Archive stats */}
      {stats && (
        <div className="pm-card" style={{ marginBottom:'1rem', display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'0.75rem' }}>
          {[
            { label: 'Archived messages', value: stats.total.toLocaleString(), color: 'var(--accent-blue)' },
            { label: 'Oldest archived',   value: fmtDate(stats.oldest),        color: 'var(--text-2)' },
            { label: 'Newest archived',   value: fmtDate(stats.newest),        color: 'var(--text-2)' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ textAlign:'center' }}>
              <div style={{ fontSize:'1.2rem', fontWeight:700, color, fontFamily:'monospace' }}>{value}</div>
              <div style={{ fontSize:'0.65rem', color:'var(--text-3)', marginTop:'0.2rem' }}>{label}</div>
            </div>
          ))}
          <div style={{ gridColumn:'1/-1', fontSize:'0.68rem', color:'var(--text-3)', fontFamily:'monospace',
            borderTop:'1px solid var(--border-soft)', paddingTop:'0.5rem', marginTop:'0.25rem' }}>
            📁 {stats.path}
          </div>
        </div>
      )}

      {/* Config */}
      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title"><Archive size={13}/> Auto-archive settings</div>
        <Flash msg={msg} />

        <div style={{ marginBottom:'1rem' }}>
          <label style={{ display:'flex', alignItems:'center', gap:'0.6rem',
            fontSize:'0.9rem', cursor:'pointer', color:'var(--text-1)', marginBottom:'0.5rem' }}>
            <input type="checkbox" checked={cfg.enabled}
              onChange={e => setCfg(c => ({ ...c, enabled: e.target.checked }))} />
            Enable automatic archiving
          </label>
          <div style={{ fontSize:'0.72rem', color:'var(--text-3)', marginLeft:'1.4rem' }}>
            Runs every 6 hours. Messages older than the threshold are moved to archive.db.
          </div>
        </div>

        <div style={{ marginBottom:'1.25rem', opacity: cfg.enabled ? 1 : 0.45, transition:'opacity 0.2s' }}>
          <label className="pm-label">Archive messages older than</label>
          <div style={{ display:'flex', alignItems:'center', gap:'0.75rem' }}>
            <input type="range" min="1" max="365" step="1" value={cfg.afterDays}
              onChange={e => setCfg(c => ({ ...c, afterDays: parseInt(e.target.value, 10) }))}
              disabled={!cfg.enabled}
              style={{ flex:1, accentColor:'var(--accent-blue)' }} />
            <span style={{ fontFamily:'monospace', fontSize:'1rem', fontWeight:700,
              color:'var(--accent-blue)', minWidth:'50px', textAlign:'right' }}>
              {cfg.afterDays}d
            </span>
          </div>
          <div style={{ fontSize:'0.72rem', color:'var(--text-3)', marginTop:'0.3rem' }}>
            Messages older than {cfg.afterDays} days are moved to archive.db. Range: 1–365 days.
          </div>
        </div>

        <div style={{ display:'flex', gap:'0.5rem', flexWrap:'wrap' }}>
          <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
            <Save size={13}/> {saving ? 'Saving…' : 'Save settings'}
          </button>
          <button className="pm-btn" onClick={runNow} disabled={running}
            title={`Move all messages older than ${cfg.afterDays} days to archive now`}>
            <Play size={13}/> {running ? 'Archiving…' : 'Run now'}
          </button>
          <button className="pm-btn" onClick={loadStats} title="Refresh stats">
            <RefreshCw size={13}/> Refresh stats
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="pm-card" style={{ fontSize:'0.78rem', color:'var(--text-3)', lineHeight:1.7 }}>
        <div className="pm-section-title">How it works</div>
        <ul style={{ margin:0, paddingLeft:'1.2rem' }}>
          <li>Messages are <strong style={{ color:'var(--text-1)' }}>moved</strong>, not deleted — archive.db grows over time</li>
          <li>Archived messages are searchable via the <strong style={{ color:'var(--text-1)' }}>Archive</strong> tab in the main feed</li>
          <li>The archive DB is stored alongside the main DB</li>
          <li>Set <code style={{ color:'var(--accent-amber)' }}>ARCHIVE_PATH</code> in .env to change location</li>
          <li>"Run now" archives immediately regardless of schedule</li>
        </ul>
      </div>
    </div>
  );
}

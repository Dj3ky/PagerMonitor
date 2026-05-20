import { useState, useEffect } from 'react';
import { Copy, Save } from 'lucide-react';
import { adminFetchDedup, adminSaveDedup } from '../../utils/api.js';

const DEFAULTS = { enabled: true, windowSeconds: 30 };

function sanitise(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  return {
    enabled:       typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    windowSeconds: typeof raw.windowSeconds === 'number' && raw.windowSeconds > 0
                     ? raw.windowSeconds : DEFAULTS.windowSeconds,
  };
}

export default function DedupConfig() {
  const [cfg, setCfg]       = useState(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState(null);

  useEffect(() => {
    adminFetchDedup()
      .then(raw => setCfg(sanitise(raw)))
      .catch(console.warn);
  }, []);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const save = async () => {
    setSaving(true);
    try { await adminSaveDedup(cfg); flash('ok', 'Dedup config saved'); }
    catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ maxWidth: '480px' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Copy size={16} style={{ color: 'var(--accent-green)' }} /> Duplicate Message Suppression
      </h2>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginBottom: '1rem' }}>
        If the same capcode sends the same message within the window, later copies are silently dropped.
        Useful for pager networks that repeat transmissions.
      </p>

      <div className="pm-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <span style={{ fontSize: '0.88rem', color: 'var(--text-1)' }}>Enable deduplication</span>
          <div onClick={() => setCfg(c => ({ ...sanitise(c), enabled: !c.enabled }))} style={{
            width: '40px', height: '22px', borderRadius: '11px', cursor: 'pointer', position: 'relative', transition: 'background 0.2s',
            background: cfg.enabled ? 'var(--accent-green)' : 'var(--bg-4)',
          }}>
            <div style={{
              position: 'absolute', top: '3px', left: cfg.enabled ? '21px' : '3px', width: '16px', height: '16px',
              borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            }} />
          </div>
        </div>

        {cfg.enabled && (
          <div style={{ marginBottom: '1rem' }}>
            <label className="pm-label">Suppression window (seconds)</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <input type="range" min="5" max="300" step="5" value={cfg.windowSeconds}
                onChange={e => setCfg(c => ({ ...sanitise(c), windowSeconds: parseInt(e.target.value) }))}
                style={{ flex: 1, accentColor: 'var(--accent-green)' }} />
              <span style={{ fontFamily: 'monospace', fontSize: '1rem', fontWeight: 700, color: 'var(--accent-green)', minWidth: '40px' }}>
                {cfg.windowSeconds}s
              </span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginTop: '0.25rem' }}>
              {cfg.windowSeconds < 10 ? 'Very short — catches rapid retransmits only'
               : cfg.windowSeconds < 60 ? 'Short window — good for most networks'
               : cfg.windowSeconds < 120 ? 'Medium window — recommended for noisy networks'
               : 'Long window — use if same message is sent many minutes apart'}
            </div>
          </div>
        )}

        {msg && (
          <div style={{
            marginBottom: '0.75rem', padding: '0.45rem 0.75rem', borderRadius: '0.4rem', fontSize: '0.78rem', fontFamily: 'monospace',
            color: msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)',
            background: `color-mix(in srgb, ${msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
            border: `1px solid color-mix(in srgb, ${msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
          }}>{msg.text}</div>
        )}

        <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
          <Save size={13} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

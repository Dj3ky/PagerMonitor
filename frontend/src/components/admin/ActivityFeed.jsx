import { useState, useEffect } from 'react';
import { Activity, RefreshCw } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';

const ACTION_META = {
  'alias.save':     { label:'Alias saved',    color:'var(--accent-green)' },
  'alias.delete':   { label:'Alias deleted',  color:'var(--accent-red)'   },
  'group.create':   { label:'Group created',  color:'var(--accent-green)' },
  'group.update':   { label:'Group updated',  color:'var(--accent-blue)'  },
  'group.delete':   { label:'Group deleted',  color:'var(--accent-red)'   },
  'rule.save':      { label:'Rule saved',     color:'var(--accent-green)' },
  'rule.delete':    { label:'Rule deleted',   color:'var(--accent-red)'   },
  'keyword.save':   { label:'Keyword saved',  color:'var(--accent-green)' },
  'keyword.delete': { label:'Keyword deleted',color:'var(--accent-red)'   },
  'sdr.start':      { label:'SDR started',    color:'var(--accent-green)' },
  'sdr.stop':       { label:'SDR stopped',    color:'var(--accent-amber)' },
  'sdr.restart':    { label:'SDR restarted',  color:'var(--accent-amber)' },
  'sdr.config':     { label:'SDR config',     color:'var(--accent-blue)'  },
  'db.purge':       { label:'DB purged',      color:'var(--accent-red)'   },
  'db.purge_all':   { label:'DB cleared',     color:'var(--accent-red)'   },
  'user.create':    { label:'User created',   color:'var(--accent-green)' },
  'user.delete':    { label:'User deleted',   color:'var(--accent-red)'   },
  'user.role_change':{ label:'Role changed',  color:'var(--accent-amber)' },
  'site.settings':  { label:'Settings saved', color:'var(--accent-blue)'  },
  'backup.download':{ label:'Backup downloaded', color:'var(--accent-blue)' },
  'backup.restore': { label:'Backup restored', color:'var(--accent-amber)' },
};

function fmtAge(ts) {
  const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
  return new Date(ts).toLocaleDateString('sl-SI', { day:'2-digit', month:'2-digit' });
}

/**
 * ActivityFeed — embeddable recent activity panel
 * @param {string}   filter   - comma-separated action prefixes, e.g. "alias,group"
 * @param {number}   limit    - max entries to show (default 10)
 * @param {boolean}  compact  - if true, show as a slim list without title
 */
export default function ActivityFeed({ filter = '', limit = 10, compact = false }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(limit) });
    if (filter) params.set('filter', filter);
    fetch(`${BASE}/admin/audit-log?${params}`, { headers: { Authorization: `Bearer ${tok()}` } })
      .then(r => r.json())
      .then(d => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filter, limit]);

  if (compact) return (
    <div style={{ fontSize:'0.75rem' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
        marginBottom:'0.4rem', color:'var(--text-3)' }}>
        <span style={{ display:'flex', alignItems:'center', gap:'0.3rem' }}>
          <Activity size={11}/> Recent activity
        </span>
        <button onClick={load} style={{ background:'none', border:'none', cursor:'pointer',
          color:'var(--text-3)', padding:0 }}>
          <RefreshCw size={10}/>
        </button>
      </div>
      {loading && <div style={{ color:'var(--text-3)', fontFamily:'monospace' }}>Loading…</div>}
      {!loading && rows.length === 0 && (
        <div style={{ color:'var(--text-3)', fontStyle:'italic' }}>No recent activity</div>
      )}
      {rows.map(r => {
        const meta = ACTION_META[r.action] || { label: r.action, color:'var(--text-3)' };
        return (
          <div key={r.id} style={{ display:'flex', alignItems:'baseline', gap:'0.4rem',
            padding:'0.2rem 0', borderBottom:'1px solid var(--border-soft)' }}>
            <span style={{ width:'6px', height:'6px', borderRadius:'50%', flexShrink:0,
              background: meta.color, marginTop:'3px', display:'inline-block' }}/>
            <span style={{ color: meta.color, fontWeight:600, flexShrink:0 }}>{meta.label}</span>
            {r.detail && (
              <span style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.7rem',
                overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>
                {r.detail}
              </span>
            )}
            <span style={{ color:'var(--text-3)', flexShrink:0, fontSize:'0.68rem',
              fontFamily:'monospace', marginLeft:'auto' }}>
              {r.username} · {fmtAge(r.timestamp)}
            </span>
          </div>
        );
      })}
    </div>
  );

  // Full mode
  return (
    <div style={{ maxWidth:'680px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'1rem',
        display:'flex', alignItems:'center', gap:'0.5rem', justifyContent:'space-between' }}>
        <span style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
          <Activity size={16} style={{ color:'var(--accent-blue)' }}/> Activity Feed
        </span>
        <button className="pm-btn" onClick={load}><RefreshCw size={12}/> Refresh</button>
      </h2>

      {loading && <div style={{ color:'var(--text-3)', fontFamily:'monospace' }}>Loading…</div>}
      {!loading && rows.length === 0 && (
        <div className="pm-card" style={{ color:'var(--text-3)', fontSize:'0.85rem' }}>
          No activity recorded yet.
        </div>
      )}
      {!loading && rows.length > 0 && (
        <div className="pm-card" style={{ padding:0, overflow:'hidden' }}>
          {rows.map((r, i) => {
            const meta = ACTION_META[r.action] || { label: r.action, color:'var(--text-3)' };
            return (
              <div key={r.id} style={{ display:'flex', alignItems:'center', gap:'0.75rem',
                padding:'0.55rem 0.75rem',
                borderBottom: i < rows.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                {/* Color dot */}
                <span style={{ width:'8px', height:'8px', borderRadius:'50%', flexShrink:0,
                  background: meta.color }}/>
                {/* Action label */}
                <span style={{ fontWeight:600, fontSize:'0.8rem', color: meta.color,
                  flexShrink:0, minWidth:'110px' }}>
                  {meta.label}
                </span>
                {/* Detail */}
                <span style={{ flex:1, fontFamily:'monospace', fontSize:'0.75rem',
                  color:'var(--text-2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {r.detail || '—'}
                </span>
                {/* User + time */}
                <div style={{ flexShrink:0, textAlign:'right' }}>
                  <span style={{ fontFamily:'monospace', fontSize:'0.72rem',
                    color:'var(--accent-blue)', fontWeight:600 }}>
                    {r.username}
                  </span>
                  <span style={{ fontFamily:'monospace', fontSize:'0.68rem',
                    color:'var(--text-3)', marginLeft:'0.4rem' }}>
                    {fmtAge(r.timestamp)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Database, Trash2, Download, RefreshCw } from 'lucide-react';
import { adminFetchDbStats, adminPurgeDb, adminPurgeAll, adminExportMessagesCsv } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';

function fmtBytes(b) {
  if (!b || isNaN(b)) return '—';
  if (b > 1e6) return `${(b/1e6).toFixed(2)} MB`;
  return `${(b/1e3).toFixed(1)} KB`;
}

export default function DbTools() {
  const { data: stats, loading, reload } = useAdminFetch(adminFetchDbStats, null);
  const [purgeDays, setPurgeDays] = useState('30');
  const [purging, setPurging]     = useState(false);
  const [msg, setMsg]             = useState(null);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  const doDelete = async (type) => {
    if (type === 'all') {
      if (!confirm('Delete ALL messages permanently? This cannot be undone.')) return;
      setPurging(true);
      try { await adminPurgeAll(); flash('ok', 'All messages deleted'); reload(); }
      catch (e) { flash('err', e.message); }
      finally { setPurging(false); }
    } else {
      const days = parseInt(purgeDays, 10);
      if (!days || days < 1) return;
      if (!confirm(`Delete all messages older than ${days} days? This cannot be undone.`)) return;
      setPurging(true);
      try { const r = await adminPurgeDb(days); flash('ok', `Deleted ${r.deleted ?? 0} messages`); reload(); }
      catch (e) { flash('err', e.message); }
      finally { setPurging(false); }
    }
  };

  const protocols = Array.isArray(stats?.protocols) ? stats.protocols : [];
  const topCodes  = Array.isArray(stats?.topCodes)  ? stats.topCodes  : [];

  return (
    <div style={{ maxWidth:'640px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'1rem' }}>
        <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', display:'flex', alignItems:'center', gap:'0.5rem', margin:0 }}>
          <Database size={16} style={{ color:'var(--accent-purple)' }} /> Database Tools
        </h2>
        <button className="pm-btn" onClick={reload}><RefreshCw size={12} /> Refresh</button>
      </div>

      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title">Statistics</div>
        {loading
          ? <div style={{ color:'var(--text-3)', fontSize:'0.82rem' }}>Loading…</div>
          : stats ? (
            <>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))', gap:'0.75rem', marginBottom:'1rem' }}>
                {[
                  { label:'Total',     value: stats.total?.toLocaleString() },
                  { label:'Today',     value: stats.today?.toLocaleString() },
                  { label:'Last hour', value: stats.lastHour?.toLocaleString() },
                  { label:'DB size',   value: fmtBytes(stats.dbSize) },
                ].map(s => (
                  <div key={s.label} style={{ background:'var(--bg-3)', borderRadius:'0.4rem', padding:'0.6rem 0.75rem' }}>
                    <div style={{ fontSize:'0.65rem', color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:'0.2rem' }}>{s.label}</div>
                    <div style={{ fontFamily:'monospace', fontSize:'1.1rem', fontWeight:700, color:'var(--text-1)' }}>{s.value ?? '—'}</div>
                  </div>
                ))}
              </div>
              {protocols.length > 0 && (
                <>
                  <div className="pm-label">By protocol</div>
                  <div style={{ display:'flex', gap:'0.5rem', flexWrap:'wrap', marginBottom:'1rem' }}>
                    {protocols.map(p => (
                      <span key={p.protocol} style={{ padding:'0.2rem 0.6rem', borderRadius:'1rem', fontSize:'0.75rem', background:'var(--bg-4)', color:'var(--text-2)', fontFamily:'monospace' }}>
                        {p.protocol}: {p.n?.toLocaleString()}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {topCodes.length > 0 && (
                <>
                  <div className="pm-label">Top capcodes</div>
                  <div style={{ display:'grid', gap:'0.2rem' }}>
                    {topCodes.map(c => (
                      <div key={c.capcode} style={{ display:'flex', justifyContent:'space-between', padding:'0.3rem 0.5rem', borderRadius:'0.3rem', background:'var(--bg-3)' }}>
                        <span style={{ fontFamily:'monospace', fontSize:'0.78rem', color:'var(--accent-amber)' }}>{c.capcode}</span>
                        <span style={{ fontFamily:'monospace', fontSize:'0.78rem', color:'var(--text-2)' }}>{c.n?.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : null
        }
      </div>

      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title">Purge old messages</div>
        <div style={{ display:'flex', gap:'0.5rem', alignItems:'flex-end', marginBottom:'0.75rem' }}>
          <div style={{ flex:1 }}>
            <label className="pm-label">Delete messages older than (days)</label>
            <input className="pm-input" type="number" min="1" value={purgeDays} onChange={e => setPurgeDays(e.target.value)} />
          </div>
          <button className="pm-btn pm-btn-danger" onClick={() => doDelete('days')} disabled={purging}>
            <Trash2 size={13} /> {purging ? 'Purging…' : 'Purge old'}
          </button>
        </div>
        <div style={{ borderTop:'1px solid var(--border-soft)', paddingTop:'0.75rem' }}>
          <label className="pm-label" style={{ color:'var(--accent-red)' }}>Danger zone</label>
          <button className="pm-btn pm-btn-danger" onClick={() => doDelete('all')} disabled={purging}
            style={{ width:'100%', justifyContent:'center' }}>
            <Trash2 size={13} /> Delete ALL messages permanently
          </button>
        </div>
      </div>

      {msg && (
        <div style={{ marginBottom:'0.75rem', padding:'0.5rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.8rem', fontFamily:'monospace',
          color: msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)',
          background: `color-mix(in srgb, ${msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
        }}>{msg.text}</div>
      )}

      <div className="pm-card">
        <div className="pm-section-title">Export messages</div>
        <button className="pm-btn pm-btn-primary" onClick={adminExportMessagesCsv} style={{ display:'inline-flex' }}>
          <Download size={13} /> Download CSV
        </button>
      </div>
    </div>
  );
}

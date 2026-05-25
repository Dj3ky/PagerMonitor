import { useState, useEffect } from 'react';
import { RefreshCw, Server, HardDrive, Power, Loader } from 'lucide-react';
import { adminFetchSystem } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';

function fmtBytes(b) {
  if (!b || isNaN(b)) return '—';
  if (b > 1e12) return `${(b/1e12).toFixed(1)} TB`;
  if (b > 1e9)  return `${(b/1e9).toFixed(1)} GB`;
  if (b > 1e6)  return `${(b/1e6).toFixed(0)} MB`;
  return `${(b/1e3).toFixed(0)} KB`;
}
function fmtUptime(s) {
  if (!s||isNaN(s)) return '—';
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

function StatRow({ label, value, mono }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline',
      padding:'0.4rem 0', borderBottom:'1px solid var(--border-soft)' }}>
      <span style={{ fontSize:'0.8rem', color:'var(--text-2)' }}>{label}</span>
      <span style={{ fontSize:'0.8rem', color:'var(--text-1)', fontFamily: mono?'monospace':'inherit' }}>{value ?? '—'}</span>
    </div>
  );
}

function BarMeter({ used, total, label, color }) {
  const pct = (total > 0 && used >= 0) ? Math.min(100, Math.round((used/total)*100)) : 0;
  const col  = color || (pct > 85 ? 'var(--accent-red)' : pct > 65 ? 'var(--accent-amber)' : 'var(--accent-green)');
  return (
    <div style={{ marginBottom:'0.75rem' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'0.3rem' }}>
        <span style={{ fontSize:'0.78rem', color:'var(--text-2)' }}>{label}</span>
        <span style={{ fontSize:'0.78rem', color:col, fontFamily:'monospace' }}>{pct}%</span>
      </div>
      <div style={{ height:'4px', background:'var(--bg-4)', borderRadius:'2px', overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${pct}%`, background:col, borderRadius:'2px', transition:'width 0.4s' }} />
      </div>
      <div style={{ fontSize:'0.7rem', color:'var(--text-3)', marginTop:'0.2rem' }}>
        {fmtBytes(used)} used / {fmtBytes(total)} total
      </div>
    </div>
  );
}

export default function SystemStats() {
  const { data, loading, reload } = useAdminFetch(adminFetchSystem, null);

  const [restartPhase, setRestartPhase] = useState('idle'); // idle | waiting | polling

  useEffect(() => {
    if (restartPhase !== 'polling') return;
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) { clearInterval(poll); window.location.reload(); }
      } catch (_) {}
      if (tries > 60) { clearInterval(poll); setRestartPhase('idle'); }
    }, 2000);
    return () => clearInterval(poll);
  }, [restartPhase]);

  const restartService = async () => {
    if (!confirm('⚠️ Restart the service now?\n\nThe server will go offline briefly. The page will reload automatically when it comes back up.')) return;
    setRestartPhase('waiting');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      await fetch(`${BASE}/admin/backup/restart`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok()}` },
        signal: ctrl.signal,
      });
    } catch (_) {}
    finally { clearTimeout(timer); }
    setRestartPhase('polling');
  };

  return (
    <div style={{ maxWidth:'680px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'1rem' }}>
        <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', display:'flex', alignItems:'center', gap:'0.5rem', margin:0 }}>
          <Server size={16} style={{ color:'var(--accent-blue)' }} /> System
        </h2>
        <button className="pm-btn" onClick={reload}><RefreshCw size={12} /> Refresh</button>
      </div>

      {loading && <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.85rem' }}>Loading…</div>}

      {!loading && data && (
        <div style={{ display:'grid', gap:'1rem', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))' }}>

          <div className="pm-card">
            <div className="pm-section-title">Server</div>
            <StatRow label="Hostname"   value={data.hostname} mono />
            <StatRow label="Platform"   value={`${data.platform||'?'} (${data.arch||'?'})`} />
            <StatRow label="CPUs"       value={data.cpus} />
            <StatRow label="Node.js"    value={data.nodeVer} mono />
            <StatRow label="Mode"       value={data.mode} />
            <StatRow label="Version"    value={data.version} mono />
            <StatRow label="Uptime"     value={fmtUptime(data.uptime)} />
            <StatRow label="WS clients" value={data.wsClients} />
          </div>

          <div className="pm-card">
            <div className="pm-section-title">RAM</div>
            <BarMeter label="System RAM" used={(data.totalMem||0)-(data.freeMem||0)} total={data.totalMem||0} />
            <BarMeter label="Node.js RSS" used={data.memory?.rss||0} total={data.totalMem||0} />
            <StatRow label="Heap used"  value={fmtBytes(data.memory?.heapUsed)} mono />
            <StatRow label="Heap total" value={fmtBytes(data.memory?.heapTotal)} mono />
          </div>

          <div className="pm-card">
            <div className="pm-section-title" style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
              <HardDrive size={13} /> Disk (/)
            </div>
            {data.disk ? (
              <BarMeter label="Disk usage" used={data.disk.used} total={data.disk.total} />
            ) : (
              <div style={{ color:'var(--text-3)', fontSize:'0.82rem' }}>Unavailable</div>
            )}
            {data.disk && <StatRow label="Free" value={fmtBytes(data.disk.avail)} mono />}
          </div>

          <div className="pm-card">
            <div className="pm-section-title">CPU Load avg</div>
            {Array.isArray(data.loadAvg) && data.loadAvg.map((v, i) => (
              <StatRow key={i} label={['1 min','5 min','15 min'][i]} value={v?.toFixed(2)} mono />
            ))}
          </div>

          <div className="pm-card">
            <div className="pm-section-title">Messages</div>
            <StatRow label="Total"     value={data.stats?.total?.toLocaleString()} />
            <StatRow label="Today"     value={data.stats?.today?.toLocaleString()} />
            <StatRow label="Last hour" value={data.stats?.lastHour?.toLocaleString()} />
          </div>

          <div className="pm-card" style={{ borderColor:'color-mix(in srgb, var(--accent-amber) 25%, var(--border))' }}>
            <div className="pm-section-title">Service Control</div>
            <p style={{ fontSize:'0.78rem', color:'var(--text-3)', marginBottom:'0.75rem', lineHeight:1.5 }}>
              Restart the service process. The page will reload automatically when it comes back up.
            </p>
            <button className="pm-btn" onClick={restartService}
              disabled={restartPhase !== 'idle'}
              style={{ display:'flex', alignItems:'center', gap:'0.4rem',
                color:'var(--accent-amber)',
                borderColor:'color-mix(in srgb, var(--accent-amber) 40%, var(--border))' }}>
              <Power size={13}/> Restart Service
            </button>
            {restartPhase !== 'idle' && (
              <div style={{ display:'flex', alignItems:'center', gap:'0.5rem',
                marginTop:'0.75rem', fontSize:'0.82rem', color:'var(--accent-amber)' }}>
                <Loader size={13} style={{ animation:'spin 1s linear infinite', flexShrink:0 }}/>
                {restartPhase === 'waiting'
                  ? 'Sending restart signal…'
                  : 'Service restarting — page will reload automatically…'}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}

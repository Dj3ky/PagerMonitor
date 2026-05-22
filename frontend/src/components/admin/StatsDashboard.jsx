import { useState, useEffect } from 'react';
import { BarChart2, RefreshCw } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (p) => fetch(`${BASE}${p}`,{headers:{'Authorization':`Bearer ${tok()}`}}).then(r=>r.json());

function Bar({ value, max, color='var(--accent-green)', label, sublabel, labelWidth='80px' }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{display:'flex',alignItems:'center',gap:'0.5rem',marginBottom:'0.2rem'}}>
      <div style={{width:labelWidth,fontSize:'0.65rem',color:'var(--text-3)',fontFamily:'monospace',textAlign:'right',flexShrink:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={label}>{label}</div>
      <div style={{flex:1,height:'14px',background:'var(--bg-3)',borderRadius:'2px',overflow:'hidden'}}>
        <div style={{width:`${pct}%`,height:'100%',background:color,borderRadius:'2px',transition:'width 0.4s'}}/>
      </div>
      <div style={{width:'36px',fontSize:'0.7rem',fontFamily:'monospace',color:'var(--text-2)',flexShrink:0,textAlign:'right'}}>{value}</div>
    </div>
  );
}

export default function StatsDashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api('/admin/stats').then(d=>setStats(d)).catch(()=>{}).finally(()=>setLoading(false));
  };
  useEffect(()=>{ load(); },[]);

  if (loading) return <div style={{color:'var(--text-3)',fontFamily:'monospace',padding:'1rem'}}>Loading stats…</div>;
  if (!stats)  return <div style={{color:'var(--accent-red)',fontFamily:'monospace',padding:'1rem'}}>Failed to load stats</div>;

  const maxHourly = Math.max(...(stats.hourly||[]).map(r=>r.n), 1);
  const maxDaily  = Math.max(...(stats.daily||[]).map(r=>r.n), 1);
  const maxCode   = Math.max(...(stats.topCodes||[]).map(r=>r.n), 1);

  return (
    <div style={{maxWidth:'680px'}}>
      <h2 style={{fontSize:'1rem',fontWeight:700,color:'var(--text-1)',marginBottom:'1rem',display:'flex',alignItems:'center',gap:'0.5rem',justifyContent:'space-between'}}>
        <span style={{display:'flex',alignItems:'center',gap:'0.5rem'}}><BarChart2 size={16} style={{color:'var(--accent-blue)'}}/> Statistics</span>
        <button className="pm-btn" onClick={load}><RefreshCw size={12}/> Refresh</button>
      </h2>

      {/* Messages per hour — last 24h */}
      <div className="pm-card" style={{marginBottom:'1rem'}}>
        <div className="pm-section-title">Messages per hour — last 24h</div>
        {stats.hourly.length === 0
          ? <div style={{color:'var(--text-3)',fontSize:'0.8rem'}}>No messages in last 24 hours</div>
          : stats.hourly.map(r=>(
            <Bar key={r.hour} value={r.n} max={maxHourly}
              label={new Date(r.hour).toLocaleTimeString('sl-SI',{hour:'2-digit',minute:'2-digit'})}
              color='var(--accent-blue)'/>
          ))}
      </div>

      {/* Messages per day — last 30d */}
      <div className="pm-card" style={{marginBottom:'1rem'}}>
        <div className="pm-section-title">Messages per day — last 30 days</div>
        {stats.daily.length === 0
          ? <div style={{color:'var(--text-3)',fontSize:'0.8rem'}}>No messages in last 30 days</div>
          : stats.daily.map(r=>(
            <Bar key={r.day} value={r.n} max={maxDaily}
              label={new Date(r.day + 'T12:00:00').toLocaleDateString('sl-SI',{day:'numeric',month:'numeric'})}
              color='var(--accent-green)'/>
          ))}
      </div>

      {/* Top capcodes */}
      <div className="pm-card" style={{marginBottom:'1rem'}}>
        <div className="pm-section-title">Top capcodes</div>
        {stats.topCodes.length === 0
          ? <div style={{color:'var(--text-3)',fontSize:'0.8rem'}}>No data</div>
          : stats.topCodes.map(r=>(
            <Bar key={r.capcode} value={r.n} max={maxCode}
              label={r.name ? `${r.capcode} — ${r.name}` : r.capcode}
              labelWidth='200px'
              color='var(--accent-amber)'/>
          ))}
      </div>

      {/* Protocol breakdown */}
      <div className="pm-card">
        <div className="pm-section-title">By protocol</div>
        {stats.byProtocol.length === 0
          ? <div style={{color:'var(--text-3)',fontSize:'0.8rem'}}>No data</div>
          : stats.byProtocol.map(r=>(
            <Bar key={r.protocol} value={r.n} max={stats.byProtocol[0].n} label={r.protocol||'unknown'} color='var(--accent-blue)'/>
          ))}
      </div>
    </div>
  );
}

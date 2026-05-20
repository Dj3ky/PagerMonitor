import { useState, useEffect } from 'react';
import { ClipboardList, RefreshCw } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';

function fmtTime(ts) {
  return new Date(ts).toLocaleString('sl-SI',{hour12:false,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

export default function AuditLog() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetch(`${BASE}/admin/audit-log?limit=200`,{headers:{Authorization:`Bearer ${tok()}`}})
      .then(r=>r.json()).then(d=>setRows(Array.isArray(d)?d:[])).catch(()=>{}).finally(()=>setLoading(false));
  };
  useEffect(()=>{ load(); },[]);

  return (
    <div style={{maxWidth:'720px'}}>
      <h2 style={{fontSize:'1rem',fontWeight:700,color:'var(--text-1)',marginBottom:'1rem',display:'flex',alignItems:'center',gap:'0.5rem',justifyContent:'space-between'}}>
        <span style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
          <ClipboardList size={16} style={{color:'var(--accent-blue)'}}/> Audit Log
        </span>
        <button className="pm-btn" onClick={load}><RefreshCw size={12}/> Refresh</button>
      </h2>

      {loading && <div style={{color:'var(--text-3)',fontFamily:'monospace',padding:'1rem'}}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div className="pm-card" style={{color:'var(--text-3)',fontSize:'0.85rem'}}>No audit log entries yet. Admin actions are recorded here.</div>
      )}

      {!loading && rows.length > 0 && (
        <div className="pm-card" style={{padding:0,overflow:'hidden'}}>
          {rows.map(r=>(
            <div key={r.id} style={{display:'flex',gap:'0.75rem',padding:'0.5rem 0.75rem',
              borderBottom:'1px solid var(--border-soft)',flexWrap:'wrap',alignItems:'flex-start'}}>
              <span style={{fontFamily:'monospace',fontSize:'0.68rem',color:'var(--text-3)',flexShrink:0,whiteSpace:'nowrap'}}>
                {fmtTime(r.timestamp)}
              </span>
              <span style={{fontFamily:'monospace',fontSize:'0.75rem',color:'var(--accent-blue)',flexShrink:0,fontWeight:600}}>
                {r.username}
              </span>
              <span style={{fontFamily:'monospace',fontSize:'0.75rem',color:'var(--text-1)',flexShrink:0}}>
                {r.action}
              </span>
              {r.detail && (
                <span style={{fontFamily:'monospace',fontSize:'0.72rem',color:'var(--text-3)',wordBreak:'break-all'}}>
                  {r.detail}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

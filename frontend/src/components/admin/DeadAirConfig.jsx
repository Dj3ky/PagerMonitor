import { useState, useEffect } from 'react';
import { Radio, Save } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m,p,b) => fetch(`${BASE}${p}`,{method:m,headers:{'Content-Type':'application/json','Authorization':`Bearer ${tok()}`},body:b?JSON.stringify(b):undefined}).then(r=>r.json());

function Flash({msg}){ if(!msg)return null; const ok=msg.type==='ok'; return <div style={{padding:'0.4rem 0.75rem',borderRadius:'0.4rem',fontSize:'0.78rem',fontFamily:'monospace',marginBottom:'0.75rem',color:ok?'var(--accent-green)':'var(--accent-red)',background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,border:`1px solid color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 30%,transparent)`}}>{msg.text}</div>; }

export default function DeadAirConfig() {
  const [cfg, setCfg] = useState({ enabled: false, thresholdHours: 6 });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const flash = (type,text) => { setMsg({type,text}); setTimeout(()=>setMsg(null),3500); };
  useEffect(()=>{ api('GET','/admin/dead-air').then(d=>setCfg(d||{enabled:false,thresholdHours:6})).catch(()=>{}); },[]);

  const save = async () => {
    setSaving(true);
    try { await api('PUT','/admin/dead-air',cfg); flash('ok','Saved'); }
    catch(e){ flash('err',e.message); }
    finally { setSaving(false); }
  };

  const hrs = cfg.thresholdHours || 6;

  return (
    <div style={{maxWidth:'480px'}}>
      <h2 style={{fontSize:'1rem',fontWeight:700,color:'var(--text-1)',marginBottom:'0.5rem',display:'flex',alignItems:'center',gap:'0.5rem'}}>
        <Radio size={16} style={{color:'var(--accent-red)'}}/> Dead Air Detection
      </h2>
      <p style={{fontSize:'0.82rem',color:'var(--text-3)',marginBottom:'1rem',lineHeight:1.6}}>
        Alert when no messages have been received from a source for a configurable period.
        Monitors each local dongle and remote client independently — shows which specific
        source went silent. Useful to detect a failed SDR, antenna issue, or offline Pi.
      </p>

      <div className="pm-card">
        <Flash msg={msg}/>

        <div style={{marginBottom:'1rem'}}>
          <label style={{display:'flex',alignItems:'center',gap:'0.6rem',fontSize:'0.9rem',cursor:'pointer',color:'var(--text-1)'}}>
            <input type="checkbox" checked={!!cfg.enabled}
              onChange={e=>setCfg(c=>({...c,enabled:e.target.checked}))}/>
            Enable dead air detection
          </label>
          <div style={{fontSize:'0.72rem',color:'var(--text-3)',marginTop:'0.3rem',marginLeft:'1.4rem'}}>
            A browser notification and status bar warning are shown when threshold is reached.
          </div>
        </div>

        <div style={{marginBottom:'1.25rem',opacity:cfg.enabled?1:0.45,transition:'opacity 0.2s'}}>
          <label className="pm-label">Alert threshold</label>
          <div style={{display:'flex',alignItems:'center',gap:'0.75rem'}}>
            <input type="range" min="1" max="168" step="1" value={hrs}
              onChange={e=>setCfg(c=>({...c,thresholdHours:parseInt(e.target.value,10)}))}
              style={{flex:1,accentColor:'var(--accent-red)'}}
              disabled={!cfg.enabled}/>
            <span style={{fontFamily:'monospace',fontSize:'1rem',fontWeight:700,
              color:'var(--accent-red)',minWidth:'60px',textAlign:'right'}}>
              {hrs >= 24 ? `${Math.round(hrs/24*10)/10}d` : `${hrs}h`}
            </span>
          </div>
          <div style={{fontSize:'0.72rem',color:'var(--text-3)',marginTop:'0.3rem'}}>
            {hrs === 1 ? '1 hour' : hrs < 24 ? `${hrs} hours` : `${Math.round(hrs/24*10)/10} days`} of silence before alerting. Range: 1h – 7 days.
          </div>
        </div>

        <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
          <Save size={13}/> {saving?'Saving…':'Save'}
        </button>
      </div>
    </div>
  );
}

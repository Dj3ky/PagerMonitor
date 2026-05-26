import { useState, useEffect } from 'react';
import { Radio, Save } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m,p,b) => fetch(`${BASE}${p}`,{method:m,headers:{'Content-Type':'application/json','Authorization':`Bearer ${tok()}`},body:b?JSON.stringify(b):undefined}).then(r=>r.json());

function Flash({msg}){ if(!msg)return null; const ok=msg.type==='ok'; return <div style={{padding:'0.4rem 0.75rem',borderRadius:'0.4rem',fontSize:'0.78rem',fontFamily:'monospace',marginBottom:'0.75rem',color:ok?'var(--accent-green)':'var(--accent-red)',background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,border:`1px solid color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 30%,transparent)`}}>{msg.text}</div>; }

// Fixed snap points (hours). Slider index maps 1-to-1 to these values.
const SNAP     = [1, 2, 3, 6, 12, 18, 24, 48, 72, 96, 120, 144, 168];
const snapIdx  = h => SNAP.reduce((best, v, i) => Math.abs(v - h) < Math.abs(SNAP[best] - h) ? i : best, 0);
const fmtHours = h => h < 24 ? `${h}h` : `${h / 24}d`;
const descHours = h => h < 24 ? `${h} hour${h !== 1 ? 's' : ''}` : h === 24 ? '1 day' : `${h / 24} days`;

function SnapSlider({ value, onChange, accentColor, disabled }) {
  const idx = snapIdx(value);
  return (
    <div style={{ flex: 1 }}>
      <input
        type="range" min="0" max={SNAP.length - 1} step="1" value={idx}
        onChange={e => onChange(SNAP[parseInt(e.target.value, 10)])}
        style={{ width: '100%', accentColor, display: 'block' }}
        disabled={disabled}
      />
      {/* Labels — margin matches browser track inset (~7px) so positions align */}
      <div style={{ position: 'relative', height: '14px', margin: '2px 7px 0' }}>
        {SNAP.map((v, i) => (
          <span key={i} style={{
            position: 'absolute',
            left: `${(i / (SNAP.length - 1)) * 100}%`,
            transform: 'translateX(-50%)',
            fontSize: '0.6rem',
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
            color:      i === idx ? accentColor : 'var(--text-3)',
            fontWeight: i === idx ? 700 : undefined,
          }}>{fmtHours(v)}</span>
        ))}
      </div>
    </div>
  );
}

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
          <div style={{display:'flex',alignItems:'flex-start',gap:'0.75rem'}}>
            <SnapSlider
              value={hrs}
              onChange={v => setCfg(c => ({...c, thresholdHours: v}))}
              accentColor="var(--accent-red)"
              disabled={!cfg.enabled}
            />
            <span style={{fontFamily:'monospace',fontSize:'1rem',fontWeight:700,
              color:'var(--accent-red)',minWidth:'42px',textAlign:'right',paddingTop:'2px'}}>
              {fmtHours(hrs)}
            </span>
          </div>
          <div style={{fontSize:'0.72rem',color:'var(--text-3)',marginTop:'0.4rem'}}>
            {descHours(hrs)} of silence before alerting.
          </div>
        </div>

        <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
          <Save size={13}/> {saving?'Saving…':'Save'}
        </button>
      </div>
    </div>
  );
}

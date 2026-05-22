import { useState, useEffect } from 'react';
import { Bell, Trash2, Plus, Save, Play } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m,p,b) => fetch(`${BASE}${p}`,{method:m,headers:{'Content-Type':'application/json','Authorization':`Bearer ${tok()}`},body:b?JSON.stringify(b):undefined}).then(r=>r.json());

const SOUNDS = ['alert','urgent','info','chime'];
const EMPTY  = { name:'', pattern:'', is_regex:0, sound:'alert', enabled:1, sort_order:0 };

function Flash({msg}){ if(!msg)return null; const ok=msg.type==='ok'; return <div style={{padding:'0.4rem 0.75rem',borderRadius:'0.4rem',fontSize:'0.78rem',fontFamily:'monospace',marginBottom:'0.75rem',color:ok?'var(--accent-green)':'var(--accent-red)',background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,border:`1px solid color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 30%,transparent)`}}>{msg.text}</div>; }

export default function KeywordAlerts() {
  const [alerts, setAlerts] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState(null);

  const flash = (type,text) => { setMsg({type,text}); setTimeout(()=>setMsg(null),3500); };
  const load  = () => api('GET','/admin/keyword-alerts').then(d=>setAlerts(Array.isArray(d)?d:[]));
  useEffect(()=>{ load(); },[]);

  const edit = (a) => { setEditing(a.id); setForm({...a}); };
  const cancel = () => { setEditing(null); setForm(EMPTY); };

  const save = async () => {
    if (!form.pattern) { flash('err', 'Pattern is required'); return; }
    if (form.is_regex) {
      try { new RegExp(form.pattern); } catch { flash('err', 'Invalid regular expression'); return; }
    }
    try {
      await api('PUT','/admin/keyword-alerts', form);
      await load(); cancel(); flash('ok','Saved');
    } catch(e){ flash('err',e.message); }
  };

  const del = async (id) => {
    if (!confirm('Delete this alert?')) return;
    await api('DELETE',`/admin/keyword-alerts/${id}`);
    await load(); flash('ok','Deleted');
  };

  const testSound = (sound) => playAlertSound(sound);

  return (
    <div style={{maxWidth:'560px'}}>
      <h2 style={{fontSize:'1rem',fontWeight:700,color:'var(--text-1)',marginBottom:'0.5rem',display:'flex',alignItems:'center',gap:'0.5rem'}}>
        <Bell size={16} style={{color:'var(--accent-amber)'}}/> Keyword Alerts
      </h2>
      <p style={{fontSize:'0.82rem',color:'var(--text-3)',marginBottom:'1rem',lineHeight:1.6}}>
        When a message matches a keyword, the browser plays a special sound and the message row blinks.
      </p>
      <Flash msg={msg}/>

      {/* Existing alerts */}
      {alerts.map(a=>(
        <div key={a.id} className="pm-card" style={{marginBottom:'0.5rem',display:'flex',alignItems:'center',gap:'0.75rem',flexWrap:'wrap'}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:600,color:'var(--text-1)',fontSize:'0.85rem'}}>{a.name}</div>
            <div style={{fontFamily:'monospace',fontSize:'0.75rem',color:'var(--text-3)'}}>
              {a.is_regex?'regex':'text'}: <span style={{color:'var(--accent-amber)'}}>{a.pattern}</span>
              {' · '}<span style={{color:'var(--accent-blue)'}}>{a.sound}</span>
            </div>
          </div>
          <div style={{display:'flex',gap:'0.4rem',alignItems:'center'}}>
            <span style={{fontSize:'0.7rem',padding:'0.1rem 0.4rem',borderRadius:'0.3rem',
              background:a.enabled?'color-mix(in srgb,var(--accent-green) 15%,transparent)':'var(--bg-3)',
              color:a.enabled?'var(--accent-green)':'var(--text-3)'}}>
              {a.enabled?'ON':'OFF'}
            </span>
            <button className="pm-btn" onClick={()=>playAlertSound(a.sound)} title="Test sound"><Play size={12}/></button>
            <button className="pm-btn" onClick={()=>edit(a)}><Save size={12}/> Edit</button>
            <button className="pm-btn pm-btn-danger" onClick={()=>del(a.id)}><Trash2 size={12}/></button>
          </div>
        </div>
      ))}

      {/* Add / Edit form */}
      <div className="pm-card" style={{marginTop:'1rem'}}>
        <div className="pm-section-title"><Plus size={13}/> {editing?'Edit alert':'New alert'}</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0.5rem',marginBottom:'0.75rem'}}>
          <div>
            <label className="pm-label">Name</label>
            <input className="pm-input" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Fire alert"/>
          </div>
          <div>
            <label className="pm-label">Sound</label>
            <select className="pm-input" value={form.sound} onChange={e=>setForm(f=>({...f,sound:e.target.value}))}>
              {SOUNDS.map(s=><option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div style={{marginBottom:'0.75rem'}}>
          <label className="pm-label">Pattern</label>
          <input className="pm-input" value={form.pattern} onChange={e=>setForm(f=>({...f,pattern:e.target.value}))} placeholder="požar, nujna, urgent..."/>
          <div style={{display:'flex',alignItems:'center',gap:'0.75rem',marginTop:'0.4rem'}}>
            <label style={{display:'flex',alignItems:'center',gap:'0.4rem',fontSize:'0.8rem',cursor:'pointer'}}>
              <input type="checkbox" checked={!!form.is_regex} onChange={e=>setForm(f=>({...f,is_regex:e.target.checked?1:0}))}/>
              Use regex
            </label>
            <label style={{display:'flex',alignItems:'center',gap:'0.4rem',fontSize:'0.8rem',cursor:'pointer'}}>
              <input type="checkbox" checked={!!form.enabled} onChange={e=>setForm(f=>({...f,enabled:e.target.checked?1:0}))}/>
              Enabled
            </label>
          </div>
        </div>
        <div style={{display:'flex',gap:'0.5rem'}}>
          <button className="pm-btn pm-btn-primary" onClick={save} disabled={!form.name||!form.pattern}><Save size={13}/> Save</button>
          <button className="pm-btn" onClick={()=>playAlertSound(form.sound||'alert')}><Play size={13}/> Test sound</button>
          {editing && <button className="pm-btn" onClick={cancel}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}

// Make playAlertSound globally accessible for the hook too
export function playAlertSound(sound='alert') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const patterns = {
      alert:  [[880,0.1],[0,0.05],[880,0.1],[0,0.05],[880,0.2]],
      urgent: [[1200,0.08],[900,0.08],[1200,0.08],[900,0.08],[1200,0.15],[900,0.15]],
      info:   [[660,0.15],[880,0.25]],
      chime:  [[523,0.1],[659,0.1],[784,0.1],[1047,0.3]],
    };
    let t = ctx.currentTime;
    for (const [freq, dur] of (patterns[sound] || patterns.alert)) {
      if (freq === 0) { t += dur; continue; }
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = freq;
      o.type = 'sine';
      g.gain.setValueAtTime(0.4, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t); o.stop(t + dur + 0.01);
      t += dur + 0.01;
    }
  } catch(_){}
}

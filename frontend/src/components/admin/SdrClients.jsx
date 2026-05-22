import { useState, useEffect, useRef } from 'react';
import { Wifi, WifiOff, Trash2, RefreshCw, Activity, Settings2, ChevronDown, ChevronUp, Save } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m, p, b) => fetch(`${BASE}${p}`, {
  method: m,
  headers: { 'Content-Type':'application/json', Authorization:`Bearer ${tok()}` },
  body: b ? JSON.stringify(b) : undefined,
}).then(r => r.json());

const CFG_FIELDS = [
  { key:'freq',       label:'Frequency',    placeholder:'173.250M', hint:'Use : to scan multiple: 173.250M:152.240M' },
  { key:'gain',       label:'Gain (dB)',     placeholder:'40',       hint:'0 = auto AGC' },
  { key:'ppm',        label:'PPM',           placeholder:'0',        hint:'Frequency correction' },
  { key:'squelch',    label:'Squelch',       placeholder:'0',        hint:'0 = disabled' },
  { key:'protocols',  label:'Protocols',     placeholder:'POCSAG1200', hint:'Space-separated: POCSAG512 POCSAG1200 POCSAG2400 FLEX' },
  { key:'charset',    label:'Charset (-C)',  placeholder:'',         hint:'Possible values: US,FR,DE,DK,SE,SI' },
];

function fmtTime(ts) {
  if (!ts) return '—';
  // SQLite datetime('now') is UTC with no timezone suffix — append Z so JS parses it as UTC
  const normalized = (ts.includes('T') || ts.endsWith('Z')) ? ts : ts.replace(' ', 'T') + 'Z';
  return new Date(normalized).toLocaleString('sl-SI', {
    hour12:false, day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit',
  });
}
function fmtSilent(sec) {
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
  return `${Math.floor(sec/86400)}d ago`;
}

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return <div style={{ padding:'0.4rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem',
    fontFamily:'monospace', marginBottom:'0.5rem',
    color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
    background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,
    border:`1px solid color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 30%,transparent)`,
  }}>{msg.text}</div>;
}

function ClientCard({ client, configs, onRemove, onSaveConfig, flash }) {
  const [expanded, setExpanded] = useState(false);
  const existingCfg = configs.find(c => c.clientId === client.id);
  const [form, setForm] = useState(existingCfg?.config || {});
  const [saving, setSaving] = useState(false);
  const [cfgMsg, setCfgMsg] = useState(null);

  const flashCfg = (type, text) => { setCfgMsg({type,text}); setTimeout(()=>setCfgMsg(null),3500); };

  const save = async () => {
    setSaving(true);
    try {
      const r = await onSaveConfig(client.id, form);
      flashCfg('ok', `Config saved (v${r.version}) — client will pick up in ≤60s`);
    } catch (e) { flashCfg('err', e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="pm-card" style={{ borderLeft:`3px solid ${client.online ? 'var(--accent-green)' : 'var(--border)'}`, marginBottom:'0.75rem' }}>

      {/* Header row */}
      <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', flexWrap:'wrap' }}>
        {client.online
          ? <Wifi size={16} style={{ color:'var(--accent-green)', flexShrink:0 }}/>
          : <WifiOff size={16} style={{ color:'var(--text-3)', flexShrink:0 }}/>}

        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:700, fontSize:'0.9rem', color:'var(--text-1)' }}>{client.id}</div>
          {client.ip && <div style={{ fontSize:'0.7rem', color:'var(--text-3)', fontFamily:'monospace' }}>{client.ip}</div>}
        </div>

        <span style={{ fontSize:'0.72rem', fontWeight:700, padding:'0.2rem 0.6rem', borderRadius:'0.75rem',
          color: client.online ? 'var(--accent-green)' : 'var(--text-3)',
          background: client.online ? 'color-mix(in srgb,var(--accent-green) 15%,transparent)' : 'var(--bg-3)',
          border:`1px solid ${client.online ? 'color-mix(in srgb,var(--accent-green) 30%,transparent)' : 'var(--border)'}`,
        }}>
          {client.online ? '● ONLINE' : '○ OFFLINE'}
        </span>

        <button className="pm-btn" onClick={() => setExpanded(e => !e)} title="Remote config">
          <Settings2 size={12}/> Config {expanded ? <ChevronUp size={11}/> : <ChevronDown size={11}/>}
        </button>
        <button className="pm-btn pm-btn-danger" onClick={() => onRemove(client.id)} title="Remove">
          <Trash2 size={12}/>
        </button>
      </div>

      {/* Stats grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))', gap:'0.4rem', marginTop:'0.6rem' }}>
        {[
          { label:'Total messages', value: client.messageCount.toLocaleString(), color:'var(--accent-blue)' },
          { label:'Today',          value: client.messagesToday.toLocaleString(), color:'var(--accent-green)' },
          { label:'Last seen',      value: fmtSilent(client.silentSec), color: client.online ? 'var(--accent-green)' : 'var(--accent-amber)' },
          { label:'Frequency',      value: client.freq || '—', color:'var(--text-2)' },
          { label:'Protocols',      value: client.protocols || '—', color:'var(--text-2)' },
          { label:'First seen',     value: fmtTime(client.firstSeen), color:'var(--text-3)' },
        ].map(({label, value, color}) => (
          <div key={label} style={{ background:'var(--bg-0)', padding:'0.4rem 0.5rem',
            borderRadius:'0.4rem', border:'1px solid var(--border-soft)' }}>
            <div style={{ fontSize:'0.6rem', color:'var(--text-3)', marginBottom:'0.15rem', textTransform:'uppercase', letterSpacing:'0.05em' }}>{label}</div>
            <div style={{ fontFamily:'monospace', fontSize:'0.78rem', fontWeight:600, color, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={value}>{value}</div>
          </div>
        ))}
      </div>

      {/* Last message */}
      {client.lastMessage && (
        <div style={{ marginTop:'0.5rem', padding:'0.4rem 0.6rem', background:'var(--bg-0)',
          borderRadius:'0.4rem', border:'1px solid var(--border-soft)' }}>
          <span style={{ fontSize:'0.6rem', color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.05em', marginRight:'0.5rem' }}>Last message</span>
          <span style={{ fontFamily:'monospace', fontSize:'0.75rem', color:'var(--text-1)' }}>{client.lastMessage}</span>
          {client.lastMessageTs && (
            <span style={{ fontFamily:'monospace', fontSize:'0.65rem', color:'var(--text-3)', marginLeft:'0.5rem' }}>
              · {fmtTime(client.lastMessageTs)}
            </span>
          )}
        </div>
      )}

      {/* Remote config panel */}
      {expanded && (
        <div style={{ marginTop:'0.75rem', paddingTop:'0.75rem', borderTop:'1px solid var(--border-soft)' }}>
          <div className="pm-section-title"><Settings2 size={12}/> Remote SDR config for {client.id}</div>
          <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.75rem', lineHeight:1.5 }}>
            Set below to override the Pi's local .env settings. The client polls every 60 seconds and restarts the SDR pipeline automatically if the config changes. Leave fields empty to keep the Pi's local .env value.
          </p>
          <Flash msg={cfgMsg}/>
          {existingCfg?.version && (
            <div style={{ fontSize:'0.7rem', color:'var(--text-3)', fontFamily:'monospace', marginBottom:'0.5rem' }}>
              Config version: <span style={{ color:'var(--accent-blue)' }}>{existingCfg.version}</span>
              {' · '}Updated: {fmtTime(existingCfg.updatedAt)}
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem', marginBottom:'0.75rem' }}>
            {CFG_FIELDS.map(f => (
              <div key={f.key}>
                <label className="pm-label">{f.label}</label>
                <input className="pm-input" value={form[f.key] || ''}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}/>
                <div style={{ fontSize:'0.62rem', color:'var(--text-3)', marginTop:'0.15rem' }}>{f.hint}</div>
              </div>
            ))}
          </div>
          <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
            <Save size={13}/> {saving ? 'Saving…' : 'Save & push to client'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function SdrClients() {
  const [clients, setClients]   = useState([]);
  const [configs, setConfigs]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [msg, setMsg]           = useState(null);
  const timerRef                = useRef(null);

  const flash = (type, text) => { setMsg({type,text}); setTimeout(()=>setMsg(null),3500); };

  const load = () => {
    Promise.all([
      api('GET', '/admin/sdr-clients'),
      api('GET', '/admin/sdr-clients/configs'),
    ]).then(([c, cfgs]) => {
      setClients(Array.isArray(c) ? c : []);
      setConfigs(Array.isArray(cfgs) ? cfgs : []);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 15_000);
    return () => clearInterval(timerRef.current);
  }, []);

  const remove = async (id) => {
    if (!confirm(`Remove client "${id}"? This clears its history and config.`)) return;
    await api('DELETE', `/admin/sdr-clients/${encodeURIComponent(id)}`);
    flash('ok', `Client "${id}" removed`);
    load();
  };

  const saveConfig = async (id, config) => {
    const r = await api('PUT', `/admin/sdr-clients/${encodeURIComponent(id)}/config`, config);
    if (!r.ok) throw new Error(r.error || 'Save failed');
    load();
    return r;
  };

  return (
    <div style={{ maxWidth:'720px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem',
        display:'flex', alignItems:'center', gap:'0.5rem', justifyContent:'space-between' }}>
        <span style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
          <Activity size={16} style={{ color:'var(--accent-blue)' }}/> SDR Clients
        </span>
        <button className="pm-btn" onClick={load}><RefreshCw size={12}/> Refresh</button>
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem', lineHeight:1.6 }}>
        Remote Raspberry Pi clients. Online = seen within 5 minutes. Use <strong>Config</strong> to push SDR settings remotely without SSH.
      </p>

      <Flash msg={msg}/>

      {loading && <div style={{ color:'var(--text-3)', fontFamily:'monospace', padding:'1rem' }}>Loading…</div>}

      {!loading && clients.length === 0 && (
        <div className="pm-card" style={{ color:'var(--text-3)', fontSize:'0.85rem', lineHeight:1.6 }}>
          No SDR clients have connected yet. Set up a Raspberry Pi client using the <strong>SDR Client Key</strong> tab.
        </div>
      )}

      {!loading && clients.map(c => (
        <ClientCard key={c.id} client={c} configs={configs}
          onRemove={remove} onSaveConfig={saveConfig} flash={flash} />
      ))}

      <div style={{ fontSize:'0.72rem', color:'var(--text-3)', fontFamily:'monospace', marginTop:'0.75rem' }}>
        Auto-refreshes every 15 seconds · Online = seen within 5 minutes
      </div>
    </div>
  );
}

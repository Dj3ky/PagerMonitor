import { useState, useEffect, useRef } from 'react';
import { Wifi, WifiOff, Trash2, RefreshCw, Activity, Settings2, ChevronDown, ChevronUp, Save, Download, GitCommit, Pencil, Check, X } from 'lucide-react';
import { useSite } from '../../context/SiteContext.jsx';
import { normTs } from '../../utils/time.js';

const GITHUB_REPO = 'Dj3ky/PagerMonitor';
const GITHUB_API  = `https://api.github.com/repos/${GITHUB_REPO}/commits/main`;

function FieldLabel({ text }) {
  const m = text.match(/^(.*?)(\s*\(-[a-zA-Z]+\))$/);
  if (!m) return text;
  return <>{m[1]}<span style={{ textTransform: 'none', letterSpacing: 'normal', fontFamily: 'monospace' }}>{m[2]}</span></>;
}

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m, p, b) => fetch(`${BASE}${p}`, {
  method: m,
  headers: { 'Content-Type':'application/json', Authorization:`Bearer ${tok()}` },
  body: b ? JSON.stringify(b) : undefined,
}).then(r => r.json());

const CFG_FIELDS = [
  { key:'freq',           label:'Frequency (-f)',      placeholder:'173.250M', hint:'Use : to scan multiple: 173.250M:152.240M',         group:'rtl' },
  { key:'modulation',     label:'Modulation (-M)',     placeholder:'fm',       hint:'fm | am | usb | lsb | wbfm | raw',                  group:'rtl' },
  { key:'sampleRate',     label:'Sample rate (-s)',    placeholder:'22050',    hint:'Hz — 22050 recommended for POCSAG',                 group:'rtl' },
  { key:'gain',           label:'Gain (-g)',           placeholder:'40',       hint:'dB — 0 = auto AGC, 40 = typical',                  group:'rtl' },
  { key:'device',         label:'Device index (-d)',   placeholder:'0',        hint:'0 = first dongle, 1 = second, …',                  group:'rtl' },
  { key:'ppm',            label:'PPM (-p)',            placeholder:'0',        hint:'Frequency correction (run rtl_test -p)',             group:'rtl' },
  { key:'squelch',        label:'Squelch (-l)',        placeholder:'0',        hint:'0 = disabled',                                      group:'rtl' },
  { key:'resampleRate',   label:'Resample rate (-r)',   placeholder:'',         hint:'Hz — leave empty to skip',                               group:'rtl' },
  { key:'lowpass',        label:'Post-process (-E)',    placeholder:'',         hint:'dc | deemp | edge | direct | offset (leave empty to disable)', group:'rtl' },
  { key:'tunerBandwidth', label:'Tuner bandwidth (-T)', placeholder:'',         hint:'Hz — 0 = auto, leave empty to skip',                     group:'rtl' },
  { key:'directSampling', label:'Direct sampling (-D)', placeholder:'0',        hint:'0 = off, 1 = I-ADC, 2 = Q-ADC (HF <28 MHz)',             group:'rtl' },
  { key:'offsetTuning',   label:'Offset tuning (-O)',   placeholder:'0',        hint:'0 = off, 1 = on',                                        group:'rtl' },
  { key:'protocols',      label:'Protocols (-a)',       placeholder:'POCSAG1200', hint:'Space-separated: POCSAG512 POCSAG1200 POCSAG2400 FLEX', group:'mmon' },
  { key:'verbosity',      label:'Verbosity (-v)',       placeholder:'',         hint:'0 = quiet, 1 = errors, 2 = info, 3 = verbose, 4 = debug', group:'mmon' },
  { key:'quiet',          label:'Quiet mode (-q)',      placeholder:'1',        hint:'1 = on (suppress banner), 0 = off',                      group:'mmon' },
  { key:'inputFormat',    label:'Input format (-t)',    placeholder:'raw',      hint:'raw | wav | au | aiff (always raw with rtl_fm)',          group:'mmon' },
  { key:'pocsagSpecial',  label:'POCSAG special (-s)',  placeholder:'0',        hint:'1 = on (special char decoding for numeric msgs), 0 = off', group:'mmon' },
  { key:'charset',        label:'Charset (-C)',         placeholder:'',         hint:'Set charset: US (default), FR, DE, SE, DK, SI',          group:'mmon' },
];

function fmtTime(ts, locale, hour12) {
  if (!ts) return '—';
  return new Date(normTs(ts)).toLocaleString(locale, {
    hour12, day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit',
  });
}
function fmtSilent(sec) {
  if (sec < 60)         return `${sec}s ago`;
  if (sec < 3600)       return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400)      return `${Math.floor(sec/3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec/86400)}d ago`;
  return 'offline';
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

function ClientCard({ client, configs, latestSha, onRemove, onSaveConfig, onSendCommand, onRename, flash }) {
  const { locale, hour12 } = useSite();
  const live = client.liveConfig || {};
  const [expanded, setExpanded] = useState(false);
  const existingCfg = configs.find(c => c.clientId === client.id);
  const [form, setForm] = useState(existingCfg?.config || {});
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [cfgMsg, setCfgMsg] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(client.displayName || '');

  const flashCfg = (type, text) => { setCfgMsg({type,text}); setTimeout(()=>setCfgMsg(null),4000); };

  const startRename = () => { setNameDraft(client.displayName || ''); setRenaming(true); };
  const cancelRename = () => setRenaming(false);
  const saveRename = async () => {
    try {
      await onRename(client.id, nameDraft.trim());
      setRenaming(false);
    } catch (e) { flashCfg('err', e.message); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await onSaveConfig(client.id, form);
      flashCfg('ok', `Config saved (v${r.version}) — client will pick up in ≤60s`);
    } catch (e) { flashCfg('err', e.message); }
    finally { setSaving(false); }
  };

  const sendUpdate = async () => {
    if (!confirm(`Send remote update command to "${client.id}"?\n\nThis will run update.sh on the client (git pull + npm install + service restart). The client will update within 60 seconds.`)) return;
    setUpdating(true);
    try {
      await onSendCommand(client.id, 'update');
      flashCfg('ok', '✓ Update queued — client will run update.sh within 60s');
    } catch (e) { flashCfg('err', e.message); }
    finally { setUpdating(false); }
  };

  return (
    <div className="pm-card" style={{ borderLeft:`3px solid ${client.online ? 'var(--accent-green)' : 'var(--border)'}`, marginBottom:'0.75rem' }}>

      {/* Identity row — icon, name, IP, actions */}
      <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', flexWrap:'wrap' }}>
        {client.online
          ? <Wifi size={16} style={{ color:'var(--accent-green)', flexShrink:0 }}/>
          : <WifiOff size={16} style={{ color:'var(--text-3)', flexShrink:0 }}/>}

        <div style={{ flex:1, minWidth:0 }}>
          {renaming ? (
            <div style={{ display:'flex', alignItems:'center', gap:'0.35rem' }}>
              <input className="pm-input" autoFocus value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') cancelRename(); }}
                placeholder={client.id}
                style={{ fontSize:'0.85rem', padding:'0.2rem 0.5rem', height:'auto', maxWidth:'220px' }} />
              <button className="pm-btn" onClick={saveRename} title="Save name"><Check size={12}/></button>
              <button className="pm-btn" onClick={cancelRename} title="Cancel"><X size={12}/></button>
            </div>
          ) : (
            <div style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
              <div style={{ fontWeight:700, fontSize:'0.9rem', color:'var(--text-1)' }}>
                {client.displayName || client.id}
              </div>
              {client.displayName && (
                <span style={{ fontSize:'0.68rem', color:'var(--text-3)', fontFamily:'monospace' }}>({client.id})</span>
              )}
              <button className="pm-btn" onClick={startRename} title="Rename"
                style={{ padding:'0.15rem 0.35rem' }}>
                <Pencil size={11}/>
              </button>
            </div>
          )}
          {client.ip && <div style={{ fontSize:'0.7rem', color:'var(--text-3)', fontFamily:'monospace' }}>{client.ip}</div>}
        </div>

        <button className="pm-btn" onClick={() => setExpanded(e => !e)} title="Remote config">
          <Settings2 size={12}/> Config {expanded ? <ChevronUp size={11}/> : <ChevronDown size={11}/>}
        </button>
        <button className="pm-btn" onClick={sendUpdate} disabled={updating}
          title="Send remote update command — runs update.sh on the client"
          style={{ color: client.pendingCommand === 'update' ? 'var(--accent-amber)' : undefined }}>
          <Download size={12}/> {updating ? 'Queuing…' : client.pendingCommand === 'update' ? 'Update pending…' : 'Update'}
        </button>
        <button className="pm-btn pm-btn-danger" onClick={() => onRemove(client.id)} title="Remove">
          <Trash2 size={12}/>
        </button>
      </div>

      {/* Status row — badges on their own line */}
      <div style={{ display:'flex', alignItems:'center', gap:'0.4rem', flexWrap:'wrap', marginTop:'0.5rem' }}>
        <span style={{ fontSize:'0.72rem', fontWeight:700, padding:'0.2rem 0.6rem', borderRadius:'0.75rem',
          color: client.online ? 'var(--accent-green)' : 'var(--text-3)',
          background: client.online ? 'color-mix(in srgb,var(--accent-green) 15%,transparent)' : 'var(--bg-3)',
          border:`1px solid ${client.online ? 'color-mix(in srgb,var(--accent-green) 30%,transparent)' : 'var(--border)'}`,
        }}>
          {client.online ? '● ONLINE' : '○ OFFLINE'}
        </span>

        {/* SDR dongle status badge — same pill style as the ONLINE/OFFLINE badge */}
        {(() => {
          const sdrOk = client.online && client.sdrRunning !== false;
          const tip   = client.online
            ? (sdrOk ? `${client.freq || ''}${client.protocols ? ` · ${client.protocols}` : ''} · dongle active`.trim()
                     : 'Client online but SDR pipeline is not running')
            : 'Client offline — last known SDR state unavailable';
          return (
            <span title={tip} style={{ fontSize:'0.72rem', fontWeight:700, padding:'0.2rem 0.6rem', borderRadius:'0.75rem',
              color: sdrOk ? 'var(--accent-green)' : 'var(--text-3)',
              background: sdrOk ? 'color-mix(in srgb,var(--accent-green) 15%,transparent)' : 'var(--bg-3)',
              border:`1px solid ${sdrOk ? 'color-mix(in srgb,var(--accent-green) 30%,transparent)' : 'var(--border)'}`,
            }}>
              {sdrOk ? '● SDR ACTIVE' : '○ SDR OFFLINE'}
            </span>
          );
        })()}

        {/* Update availability badge */}
        {latestSha && client.gitHash && latestSha !== client.gitHash && (
          <span title={`Client: ${client.gitHash.slice(0,7)} · GitHub: ${latestSha.slice(0,7)}`}
            style={{ fontSize:'0.7rem', fontWeight:700, padding:'0.2rem 0.55rem', borderRadius:'0.75rem',
              color:'var(--accent-amber)',
              background:'color-mix(in srgb,var(--accent-amber) 15%,transparent)',
              border:'1px solid color-mix(in srgb,var(--accent-amber) 35%,transparent)',
              display:'flex', alignItems:'center', gap:'0.3rem', whiteSpace:'nowrap',
          }}>
            <GitCommit size={10}/> Update available
          </span>
        )}
        {latestSha && client.gitHash && latestSha === client.gitHash && (
          <span title={`Up to date · ${client.gitHash.slice(0,7)}`}
            style={{ fontSize:'0.7rem', color:'var(--text-3)', display:'flex', alignItems:'center', gap:'0.3rem' }}>
            <GitCommit size={10}/> Up to date
          </span>
        )}
      </div>

      {/* Stats grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))', gap:'0.4rem', marginTop:'0.6rem' }}>
        {[
          { label:'Total messages', value: client.messageCount.toLocaleString(), color:'var(--accent-blue)' },
          { label:'Today',          value: client.messagesToday.toLocaleString(), color:'var(--accent-green)' },
          { label:'Last seen',      value: fmtSilent(client.silentSec), color: client.online ? 'var(--accent-green)' : 'var(--accent-amber)' },
          { label:'Frequency',      value: client.freq || '—', color:'var(--text-2)' },
          { label:'Protocols',      value: client.protocols || '—', color:'var(--text-2)' },
          { label:'First seen',     value: fmtTime(client.firstSeen, locale, hour12), color:'var(--text-3)', span: 2 },
        ].map(({label, value, color, span}) => (
          <div key={label} style={{ background:'var(--bg-0)', padding:'0.4rem 0.5rem',
            borderRadius:'0.4rem', border:'1px solid var(--border-soft)',
            gridColumn: span ? `span ${span}` : undefined }}>
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
              · {fmtTime(client.lastMessageTs, locale, hour12)}
            </span>
          )}
        </div>
      )}

      {/* Inline feedback — shown for both update and config actions */}
      {cfgMsg && <div style={{ marginTop:'0.5rem' }}><Flash msg={cfgMsg}/></div>}

      {/* Remote config panel */}
      {expanded && (
        <div style={{ marginTop:'0.75rem', paddingTop:'0.75rem', borderTop:'1px solid var(--border-soft)' }}>
          <div className="pm-section-title"><Settings2 size={12}/> Remote SDR config for {client.id}</div>
          <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.75rem', lineHeight:1.5 }}>
            Set below to override the Pi's local .env settings. The client polls every 60 seconds and restarts the SDR pipeline automatically if the config changes. Leave fields empty to keep the Pi's local .env value.
          </p>
          {existingCfg?.version && (
            <div style={{ fontSize:'0.7rem', color:'var(--text-3)', fontFamily:'monospace', marginBottom:'0.5rem' }}>
              Config version: <span style={{ color:'var(--accent-blue)' }}>{existingCfg.version}</span>
              {' · '}Updated: {fmtTime(existingCfg.updatedAt, locale, hour12)}
            </div>
          )}
          {/* rtl_fm settings */}
          <div style={{ fontSize:'0.68rem', fontWeight:600, color:'var(--text-3)',
            textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.35rem' }}>
            rtl_fm settings
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem', marginBottom:'0.65rem' }}>
            {CFG_FIELDS.filter(f => f.group === 'rtl').map(f => (
              <div key={f.key}>
                <label className="pm-label"><FieldLabel text={f.label} /></label>
                <input className="pm-input" value={form[f.key] || ''}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={live[f.key] || f.placeholder}/>
                <div style={{ fontSize:'0.62rem', color:'var(--text-3)', marginTop:'0.15rem' }}>{f.hint}</div>
              </div>
            ))}
          </div>

          {/* divider */}
          <div style={{ height:'1px', background:'var(--border-soft)', margin:'0.5rem 0 0.65rem' }}/>

          {/* multimon-ng settings */}
          <div style={{ fontSize:'0.68rem', fontWeight:600, color:'var(--text-3)',
            textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.35rem' }}>
            multimon-ng settings
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem', marginBottom:'0.75rem' }}>
            {CFG_FIELDS.filter(f => f.group === 'mmon').map(f => (
              <div key={f.key}>
                <label className="pm-label"><FieldLabel text={f.label} /></label>
                <input className="pm-input" value={form[f.key] || ''}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={live[f.key] || f.placeholder}/>
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
  const [clients, setClients]     = useState([]);
  const [configs, setConfigs]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [msg, setMsg]             = useState(null);
  const [latestSha, setLatestSha] = useState(null); // latest GitHub commit SHA
  const timerRef                  = useRef(null);

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

  // Fetch latest GitHub commit once on mount (no need to poll frequently)
  useEffect(() => {
    fetch(GITHUB_API)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.sha) setLatestSha(data.sha); })
      .catch(() => {});
  }, []);

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

  const rename = async (id, name) => {
    const r = await api('PUT', `/admin/sdr-clients/${encodeURIComponent(id)}/name`, { name });
    if (!r.ok) throw new Error(r.error || 'Rename failed');
    load();
    return r;
  };

  const sendCommand = async (id, command) => {
    const r = await api('POST', `/admin/sdr-clients/${encodeURIComponent(id)}/command`, { command });
    if (!r.ok) throw new Error(r.error || 'Command failed');
    load(); // refresh to show pending state
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
        Remote Raspberry Pi clients. Online = seen within 90 seconds. Use <strong>Config</strong> to push SDR settings remotely without SSH.
      </p>

      <Flash msg={msg}/>

      {loading && <div style={{ color:'var(--text-3)', fontFamily:'monospace', padding:'1rem' }}>Loading…</div>}

      {!loading && clients.length === 0 && (
        <div className="pm-card" style={{ color:'var(--text-3)', fontSize:'0.85rem', lineHeight:1.6 }}>
          No SDR clients have connected yet. Set up a Raspberry Pi client using the <strong>SDR Client Key</strong> tab.
        </div>
      )}

      {!loading && clients.map(c => (
        <ClientCard key={c.id} client={c} configs={configs} latestSha={latestSha}
          onRemove={remove} onSaveConfig={saveConfig} onSendCommand={sendCommand} onRename={rename} flash={flash} />
      ))}

      <div style={{ fontSize:'0.72rem', color:'var(--text-3)', fontFamily:'monospace', marginTop:'0.75rem' }}>
        Auto-refreshes every 15 seconds · Online = seen within 90 seconds
      </div>
    </div>
  );
}

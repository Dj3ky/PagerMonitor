import { useState, useEffect } from 'react';
import { Play, Square, RotateCcw, Save, ChevronDown, ChevronUp, Terminal, Plus, Trash2 } from 'lucide-react';
import { adminSdrStart, adminSdrStop, adminSdrRestart, adminFetchSdrConfig, adminSdrSetConfig } from '../../utils/api.js';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m, p, b) => fetch(`${BASE}${p}`, {
  method: m, headers: { 'Content-Type':'application/json', Authorization:`Bearer ${tok()}` },
  body: b ? JSON.stringify(b) : undefined,
}).then(r => r.json());

const DONGLE_DEFAULTS = { device:'0', freq:'173.250M', gain:'40', ppm:'0', squelch:'0', protocols:'POCSAG1200', charset:'' };
const DONGLE_FIELDS = [
  { key:'device',    label:'Device index', hint:'0 = first dongle, 1 = second, …', group:'rtl' },
  { key:'freq',      label:'Frequency',    hint:'e.g. 173.250M or 173.250M:152.240M', group:'rtl' },
  { key:'gain',      label:'Gain (dB)',    hint:'0 = auto AGC, 40 = typical', group:'rtl' },
  { key:'ppm',       label:'PPM',          hint:'Frequency correction (run rtl_test -p)', group:'rtl' },
  { key:'squelch',   label:'Squelch',      hint:'0 = disabled', group:'rtl' },
  { key:'protocols', label:'Protocols',    hint:'POCSAG512 POCSAG1200 POCSAG2400 FLEX', group:'mmon' },
  { key:'charset',   label:'Charset',      hint:'Possible values: US,FR,DE,DK,SE,SI', group:'mmon' },
];

const FIELD_GROUPS = [
  {
    title: 'rtl_fm settings',
    color: 'var(--accent-blue)',
    fields: [
      { key: 'RTL_FM_FREQ',            label: 'Frequency (-f)',          hint: 'e.g. 152.240M  or  152.240M:157.450M for multiple' },
      { key: 'RTL_FM_MODULATION',      label: 'Modulation (-M)',         hint: 'fm | am | usb | lsb | wbfm | raw' },
      { key: 'RTL_FM_SAMPLE_RATE',     label: 'Sample rate (-s)',        hint: 'Hz — 22050 recommended for POCSAG' },
      { key: 'RTL_FM_GAIN',            label: 'Gain (-g)',               hint: 'dB — 0 = auto AGC' },
      { key: 'RTL_FM_DEVICE_INDEX',    label: 'Device index (-d)',       hint: '0 = first dongle' },
      { key: 'RTL_FM_PPM',             label: 'PPM correction (-p)',     hint: 'Find with rtl_test -p' },
      { key: 'RTL_FM_SQUELCH',         label: 'Squelch (-l)',            hint: '0 = disabled' },
      { key: 'RTL_FM_RESAMPLE_RATE',   label: 'Resample rate (-r)',      hint: 'Leave empty to skip -r flag' },
      { key: 'RTL_FM_LOWPASS',         label: 'Post-process (-E)',       hint: 'dc | deemp | comma-separated' },
      { key: 'RTL_FM_TUNER_BANDWIDTH', label: 'Tuner bandwidth (-T)',    hint: 'Hz — 0=auto, leave empty for default' },
      { key: 'RTL_FM_DIRECT_SAMPLING', label: 'Direct sampling (-D)',    hint: '0=off 1=I 2=Q (HF <28MHz)' },
      { key: 'RTL_FM_OFFSET_TUNING',   label: 'Offset tuning (-O)',      hint: '0=off 1=on' },
    ],
  },
  {
    title: 'multimon-ng settings',
    color: 'var(--accent-green)',
    fields: [
      { key: 'MULTIMON_PROTOCOLS',       label: 'Protocols (-a)',           hint: 'Space-separated: POCSAG512 POCSAG1200 POCSAG2400 FLEX …' },
      { key: 'MULTIMON_VERBOSITY',       label: 'Verbosity (-v)',           hint: '0=quiet 1=errors 2=info 3=verbose 4=debug' },
      { key: 'MULTIMON_QUIET',           label: 'Quiet mode (-q)',          hint: '1=on (suppress banner) 0=off' },
      { key: 'MULTIMON_INPUT_FORMAT',    label: 'Input format (-t)',        hint: 'raw | wav | au | aiff  (always raw with rtl_fm)' },
      { key: 'MULTIMON_POCSAG_SPECIAL',  label: 'POCSAG special (-s)',      hint: '1=decode numeric as special 0=off' },
      { key: 'MULTIMON_POCSAG_CHARSET',  label: 'POCSAG charset (-C)',      hint: 'Possible values: US,FR,DE,DK,SE,SI' },
    ],
  },
];

export default function SdrControl({ sdrStatus }) {
  const [config, setConfig]   = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState(null);
  const [open, setOpen]       = useState({ 0: true, 1: true });
  const [dongles, setDongles] = useState([]);   // [] = single dongle mode
  const [multiMode, setMultiMode] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      adminFetchSdrConfig(),
      api('GET', '/admin/sdr/dongles'),
    ]).then(([cfg, d]) => {
      setConfig(cfg && typeof cfg === 'object' ? cfg : {});
      const arr = Array.isArray(d) && d.length > 0 ? d : [];
      setDongles(arr);
      setMultiMode(arr.length > 1);
    }).catch(e => setMsg({ type:'err', text: e.message }))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const flash = (type, text) => { setMsg({type,text}); setTimeout(()=>setMsg(null), 4000); };

  const action = async (fn, label) => {
    try { await fn(); flash('ok', `${label} sent`); }
    catch (e) { flash('err', e.message); }
  };

  const saveAndRestart = async () => {
    setSaving(true);
    try {
      if (multiMode && dongles.length > 1) {
        // Save dongle configs then explicitly restart
        await api('PUT', '/admin/sdr/dongles', dongles);
        await adminSdrRestart();
        flash('ok', `${dongles.length} dongles configured — pipeline restarting…`);
      } else {
        // Clear dongle configs first, then save single config (which triggers restart)
        await api('PUT', '/admin/sdr/dongles', []);
        await adminSdrSetConfig(config);
        flash('ok', 'Config applied — pipeline restarting…');
      }
    } catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const addDongle = () => setDongles(d => {
    const nextDevice = d.length === 0 ? 0 : Math.max(...d.map(x => Number(x.device))) + 1;
    return [...d, { ...DONGLE_DEFAULTS, device: String(nextDevice) }];
  });
  const removeDongle = (i) => setDongles(d => d.filter((_, j) => j !== i));
  const updateDongle = (i, key, val) => setDongles(d => d.map((x, j) => j === i ? { ...x, [key]: val } : x));

  const running = sdrStatus?.running;

  return (
    <div style={{ maxWidth: '680px' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Terminal size={16} style={{ color: 'var(--accent-green)' }} /> SDR Pipeline Control
      </h2>

      {/* Status + controls */}
      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: running ? 'var(--accent-green)' : 'var(--accent-red)',
              boxShadow: running ? 'var(--glow-green)' : 'var(--glow-red)',
              animation: running ? 'blink 2s ease-in-out infinite' : 'none',
            }} />
            <span style={{ fontFamily: 'monospace', fontSize: '0.85rem', fontWeight: 600,
              color: running ? 'var(--accent-green)' : 'var(--accent-red)' }}>
              {running ? 'RUNNING' : 'STOPPED'}
            </span>
            {multiMode && dongles.length > 1 && (
              <span style={{ fontSize:'0.72rem', fontFamily:'monospace',
                color:'var(--accent-blue)',
                background:'color-mix(in srgb,var(--accent-blue) 12%,transparent)',
                border:'1px solid color-mix(in srgb,var(--accent-blue) 25%,transparent)',
                padding:'0.1rem 0.4rem', borderRadius:'0.3rem' }}>
                {dongles.length} dongles
              </span>
            )}
          </div>
          {sdrStatus?.freq && (
            <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--text-2)' }}>
              {sdrStatus.freq}
            </span>
          )}
          {sdrStatus?.restarts > 0 && (
            <span style={{ fontSize: '0.75rem', color: 'var(--accent-amber)' }}>
              ⚠ {sdrStatus.restarts} restart{sdrStatus.restarts !== 1 ? 's' : ''}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
            <button className="pm-btn pm-btn-primary" onClick={() => action(adminSdrStart,   'Start')}   disabled={running}>
              <Play size={12} /> Start
            </button>
            <button className="pm-btn pm-btn-danger"  onClick={() => action(adminSdrStop,    'Stop')}    disabled={!running}>
              <Square size={12} /> Stop
            </button>
            <button className="pm-btn" onClick={() => action(adminSdrRestart, 'Restart')}>
              <RotateCcw size={12} /> Restart
            </button>
          </div>
        </div>

        {sdrStatus?.error && (
          <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: 'color-mix(in srgb, var(--accent-red) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent-red) 30%, transparent)', borderRadius: '0.4rem',
            fontFamily: 'monospace', fontSize: '0.78rem', color: 'var(--accent-red)' }}>
            {sdrStatus.error}
          </div>
        )}
      </div>

      {/* Command preview */}
      {sdrStatus?.rtlArgs && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">Active command</div>
          <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--text-2)',
            background: 'var(--bg-3)', padding: '0.5rem 0.75rem', borderRadius: '0.4rem',
            overflowX: 'auto', whiteSpace: 'nowrap' }}>
            rtl_fm {sdrStatus.rtlArgs?.join(' ')} | multimon-ng {sdrStatus.mmonArgs?.join(' ')}
          </div>
        </div>
      )}

      {/* Config form */}
      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: '0.85rem', fontFamily: 'monospace' }}>Loading config…</div>
      ) : (
        <>
          {FIELD_GROUPS.map((group, gi) => (
            <div key={gi} className="pm-card" style={{ marginBottom: '1rem' }}>
              <button
                onClick={() => setOpen(o => ({ ...o, [gi]: !o[gi] }))}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
              >
                <div className="pm-section-title" style={{ color: group.color, marginBottom: 0 }}>
                  {group.title}
                </div>
                {open[gi] ? <ChevronUp size={14} style={{ color: 'var(--text-3)' }} /> : <ChevronDown size={14} style={{ color: 'var(--text-3)' }} />}
              </button>

              {open[gi] && (
                <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.6rem' }}>
                  {group.fields.map(f => (
                    <div key={f.key}>
                      <label className="pm-label">{f.label}</label>
                      <input
                        className="pm-input"
                        value={config[f.key] || ''}
                        onChange={e => setConfig(c => ({ ...(c && typeof c === 'object' ? c : {}), [f.key]: e.target.value }))}
                        placeholder={f.hint}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Multi-dongle toggle */}
          <div className="pm-card" style={{ marginBottom:'1rem' }}>
            <div className="pm-section-title">Multiple SDR dongles</div>
            <label style={{ display:'flex', alignItems:'center', gap:'0.6rem', fontSize:'0.85rem',
              cursor:'pointer', color:'var(--text-1)', marginBottom:'0.5rem' }}>
              <input type="checkbox" checked={multiMode}
                onChange={e => {
                  setMultiMode(e.target.checked);
                  if (e.target.checked && dongles.length < 2) {
                    setDongles([
                      { ...DONGLE_DEFAULTS, device:'0', freq: config.RTL_FM_FREQ || '173.250M' },
                      { ...DONGLE_DEFAULTS, device:'1', freq: '152.240M' },
                    ]);
                  }
                }} />
              Enable multiple dongle mode
            </label>
            <div style={{ fontSize:'0.72rem', color:'var(--text-3)' }}>
              When enabled, each dongle runs independently on its own frequency. The settings above are ignored.
            </div>

            {multiMode && (
              <div style={{ marginTop:'0.75rem' }}>
                {dongles.map((d, i) => (
                  <div key={i} style={{ marginBottom:'0.75rem', padding:'0.6rem 0.75rem',
                    background:'var(--bg-0)', borderRadius:'0.5rem',
                    border:'1px solid var(--border-soft)' }}>
                    {/* Card header */}
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                      marginBottom:'0.6rem' }}>
                      <span style={{ fontFamily:'monospace', fontSize:'0.78rem', fontWeight:700,
                        color:'var(--accent-blue)' }}>
                        Dongle {i} — device {d.device}
                      </span>
                      {dongles.length > 1 && (
                        <button className="pm-btn pm-btn-danger" onClick={() => removeDongle(i)}
                          style={{ padding:'0.15rem 0.4rem' }}>
                          <Trash2 size={11}/>
                        </button>
                      )}
                    </div>

                    {/* rtl_fm settings */}
                    <div style={{ fontSize:'0.68rem', fontWeight:600, color:'var(--text-3)',
                      textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.35rem' }}>
                      rtl_fm
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.4rem',
                      marginBottom:'0.65rem' }}>
                      {DONGLE_FIELDS.filter(f => f.group === 'rtl').map(f => (
                        <div key={f.key}>
                          <label className="pm-label">{f.label}</label>
                          <input className="pm-input" value={d[f.key] ?? ''}
                            onChange={e => updateDongle(i, f.key, e.target.value)}
                            placeholder={f.hint} />
                        </div>
                      ))}
                    </div>

                    {/* divider */}
                    <div style={{ height:'1px', background:'var(--border-soft)', margin:'0.5rem 0' }}/>

                    {/* multimon-ng settings */}
                    <div style={{ fontSize:'0.68rem', fontWeight:600, color:'var(--text-3)',
                      textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.35rem' }}>
                      multimon-ng
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.4rem' }}>
                      {DONGLE_FIELDS.filter(f => f.group === 'mmon').map(f => (
                        <div key={f.key}>
                          <label className="pm-label">{f.label}</label>
                          <input className="pm-input" value={d[f.key] ?? ''}
                            onChange={e => updateDongle(i, f.key, e.target.value)}
                            placeholder={f.hint} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <button className="pm-btn" onClick={addDongle}
                  style={{ display:'flex', alignItems:'center', gap:'0.4rem', fontSize:'0.8rem' }}>
                  <Plus size={13}/> Add dongle
                </button>
              </div>
            )}
          </div>

          {msg && (
            <div style={{ padding: '0.5rem 0.75rem', marginBottom: '0.75rem', borderRadius: '0.4rem', fontSize: '0.8rem', fontFamily: 'monospace',
              color: msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)',
              background: msg.type === 'ok' ? 'color-mix(in srgb, var(--accent-green) 10%, transparent)' : 'color-mix(in srgb, var(--accent-red) 10%, transparent)',
              border: `1px solid color-mix(in srgb, ${msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
            }}>{msg.text}</div>
          )}

          <button className="pm-btn pm-btn-primary" onClick={saveAndRestart} disabled={saving} style={{ gap: '0.5rem' }}>
            <Save size={13} /> {saving ? 'Applying…' : 'Apply & Restart Pipeline'}
          </button>
        </>
      )}
    </div>
  );
}

import { useState, useEffect } from 'react';
import { Bell, Send, Save } from 'lucide-react';
import { adminFetchNotifConfig, adminSetNotifConfig, adminTestNotif } from '../../utils/api.js';
import NotifFilter from './NotifFilter.jsx';

// Safe defaults — always a valid object even if backend returns garbage
const DEFAULTS = {
  discord:   { enabled: false, url: '' },
  telegram:  { enabled: false, token: '', chatId: '' },
  gotify:    { enabled: false, url: '', token: '', priority: 5 },
  pushover:  { enabled: false, token: '', userKey: '', priority: 0, sound: 'default' },
  mqtt:      { enabled: false, broker: '', topic: 'pagermonitor/messages' },
};

function sanitise(raw) {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULTS);
  const out = {};
  for (const svc of ['discord', 'telegram', 'gotify', 'pushover', 'mqtt']) {
    const src = (raw[svc] && typeof raw[svc] === 'object') ? raw[svc] : {};
    out[svc]  = { ...DEFAULTS[svc], ...src };
  }
  return out;
}

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div style={{
      marginBottom: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '0.4rem',
      fontSize: '0.8rem', fontFamily: 'monospace',
      color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
      background: `color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
    }}>{msg.text}</div>
  );
}

function Toggle({ on, color, onToggle }) {
  return (
    <div onClick={onToggle} style={{
      width: '36px', height: '20px', borderRadius: '10px', cursor: 'pointer',
      position: 'relative', transition: 'background 0.2s', flexShrink: 0,
      background: on ? color : 'var(--bg-4)',
    }}>
      <div style={{
        position: 'absolute', top: '2px', left: on ? '18px' : '2px',
        width: '16px', height: '16px', borderRadius: '50%', background: '#fff',
        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      }} />
    </div>
  );
}

function ServiceBlock({ title, icon, color, svc, cfg, onToggle, onChange, onTest, testing }) {
  const enabled = !!cfg?.enabled;
  return (
    <div className="pm-card" style={{
      marginBottom: '1rem',
      borderColor: enabled ? `color-mix(in srgb, ${color} 30%, transparent)` : 'var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: enabled ? '1rem' : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.1rem' }}>{icon}</span>
          <span style={{ fontWeight: 600, fontSize: '0.9rem', color: enabled ? color : 'var(--text-2)' }}>{title}</span>
          <span style={{
            fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: '1rem',
            background: enabled ? `color-mix(in srgb, ${color} 15%, transparent)` : 'var(--bg-4)',
            color: enabled ? color : 'var(--text-3)',
          }}>{enabled ? 'ENABLED' : 'DISABLED'}</span>
        </div>
        <Toggle on={enabled} color={color} onToggle={onToggle} />
      </div>

      {enabled && (
        <div style={{ display: 'grid', gap: '0.6rem' }}>
          {FIELDS[svc].map(f => (
            <div key={f.key}>
              <label className="pm-label">{f.label}</label>
              <input
                className="pm-input"
                type={f.secret ? 'password' : 'text'}
                value={cfg?.[f.key] ?? ''}
                onChange={e => onChange(f.key, e.target.value)}
                placeholder={f.hint}
              />
            </div>
          ))}
          <button className="pm-btn" onClick={onTest} disabled={testing} style={{ fontSize: '0.78rem', marginTop: '0.25rem' }}>
            <Send size={12} /> {testing ? 'Sending…' : 'Send test notification'}
          </button>
        </div>
      )}
    </div>
  );
}

const FIELDS = {
  discord:  [{ key: 'url',      label: 'Webhook URL',       hint: 'https://discord.com/api/webhooks/…', secret: false }],
  telegram: [
    { key: 'token',  label: 'Bot token', hint: 'From @BotFather',    secret: true  },
    { key: 'chatId', label: 'Chat ID',   hint: 'Group or user ID',   secret: false },
  ],
  gotify: [
    { key: 'url',      label: 'Gotify server URL', hint: 'http://192.168.1.50:8080',       secret: false },
    { key: 'token',    label: 'App token',          hint: 'From Gotify app settings',       secret: true  },
    { key: 'priority', label: 'Priority',            hint: '1=low  5=normal  8=high  10=urgent', secret: false },
  ],
  pushover: [
    { key: 'token',    label: 'API Token',  hint: 'App API token from pushover.net',           secret: true  },
    { key: 'userKey',  label: 'User Key',   hint: 'Your user/group key from pushover.net',     secret: true  },
    { key: 'priority', label: 'Priority',   hint: '-2 silent  -1 quiet  0 normal  1 high  2 emergency', secret: false },
    { key: 'sound',    label: 'Sound',      hint: 'pushover, bike, bugle, magic, none, … (leave empty for default)', secret: false },
  ],
  mqtt: [
    { key: 'broker', label: 'Broker URL', hint: 'mqtt://192.168.1.100:1883', secret: false },
    { key: 'topic',  label: 'Topic',      hint: 'pagermonitor/messages',     secret: false },
  ],
};

const SERVICE_META = [
  { svc: 'discord',  title: 'Discord',  icon: '💬', color: 'var(--accent-blue)'   },
  { svc: 'telegram', title: 'Telegram', icon: '✈️',  color: 'var(--accent-blue)'   },
  { svc: 'gotify',   title: 'Gotify',   icon: '🔔', color: 'var(--accent-green)'  },
  { svc: 'pushover', title: 'Pushover', icon: '📲', color: 'var(--accent-amber)'  },
  { svc: 'mqtt',     title: 'MQTT',     icon: '📡', color: 'var(--accent-green)'  },
];

export default function NotifConfig() {
  const [cfg, setCfg]         = useState(structuredClone(DEFAULTS));
  const [loaded, setLoaded]   = useState(false);
  const [saving, setSaving]   = useState(false);
  const [testing, setTesting] = useState({});
  const [msg, setMsg]         = useState(null);

  useEffect(() => {
    adminFetchNotifConfig()
      .then(raw => { setCfg(sanitise(raw)); setLoaded(true); })
      .catch(e  => { console.warn(e); setLoaded(true); });
  }, []);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  // Safe update — always operates on a validated object
  const update = (svc, key, value) =>
    setCfg(c => {
      const safe = sanitise(c);
      return { ...safe, [svc]: { ...safe[svc], [key]: value } };
    });

  const toggle = (svc) =>
    setCfg(c => {
      const safe = sanitise(c);
      return { ...safe, [svc]: { ...safe[svc], enabled: !safe[svc].enabled } };
    });

  const save = async () => {
    setSaving(true);
    try { await adminSetNotifConfig(cfg); flash('ok', 'Saved'); }
    catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const test = async (svc) => {
    setTesting(t => ({ ...t, [svc]: true }));
    try { await adminTestNotif(svc); flash('ok', `Test sent via ${svc}`); }
    catch (e) { flash('err', `${svc}: ${e.message}`); }
    finally { setTesting(t => ({ ...t, [svc]: false })); }
  };

  if (!loaded) return <div style={{ color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.85rem' }}>Loading…</div>;

  return (
    <div style={{ maxWidth: '580px' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Bell size={16} style={{ color: 'var(--accent-amber)' }} /> Notification Services
      </h2>

      {SERVICE_META.map(({ svc, title, icon, color }) => (
        <ServiceBlock key={svc}
          svc={svc} title={title} icon={icon} color={color}
          cfg={cfg[svc]}
          onToggle={() => toggle(svc)}
          onChange={(k, v) => update(svc, k, v)}
          onTest={() => test(svc)}
          testing={!!testing[svc]}
        />
      ))}

      <Flash msg={msg} />

      <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
        <Save size={13} /> {saving ? 'Saving…' : 'Save config'}
      </button>

      <div style={{ borderTop: '1px solid var(--border)', margin: '1.5rem 0' }} />

      <NotifFilter />
    </div>
  );
}

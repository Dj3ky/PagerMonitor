import { useState, useEffect, useCallback } from 'react';
import { Brain, Save, Play, RefreshCw, ExternalLink,
         CheckCircle, XCircle, AlertCircle, Info } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
// Throws on HTTP error so callers can catch failures properly
const api  = async (m, p, b) => {
  const r = await fetch(`${BASE}${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok()}` },
    body: b !== undefined ? JSON.stringify(b) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};

const DEFAULTS = {
  provider:       'none',
  // Keys are never returned from the server — inputs always start empty.
  // groqKeySaved / openaiKeySaved / hereKeySaved booleans come from the GET response.
  groqKey:        '',
  groqKeySaved:   false,
  groqKeySource:  'none',
  groqModel:      'llama-3.1-8b-instant',
  openaiKey:      '',
  openaiKeySaved: false,
  openaiKeySource:'none',
  openaiModel:    'gpt-4o-mini',
  ollamaUrl:      'http://localhost:11434',
  ollamaModel:    'llama3.2:1b',
  geocoder:       'nominatim',
  hereKey:        '',
  hereKeySaved:   false,
  hereKeySource:  'none',
};

// ── Small helpers ──────────────────────────────────────────────────────────────
function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div style={{
      padding: '0.4rem 0.75rem', borderRadius: '0.4rem', fontSize: '0.78rem',
      fontFamily: 'monospace', marginBottom: '0.75rem',
      color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
      background: `color-mix(in srgb,${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 10%,transparent)`,
      border: `1px solid color-mix(in srgb,${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 30%,transparent)`,
    }}>{msg.text}</div>
  );
}

function StatusBadge({ status, loading }) {
  if (loading) return (
    <span style={{ fontSize: '0.72rem', color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
      <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} /> Checking…
    </span>
  );
  if (!status || status.provider === 'none') return null;
  const ok = status.connected;
  const Icon = ok ? CheckCircle : XCircle;
  return (
    <span style={{
      fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.3rem',
      color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
    }}>
      <Icon size={12} />
      {ok ? 'Connected' : (status.error || 'Not reachable')}
      {ok && status.modelInstalled === false && (
        <span style={{ color: 'var(--accent-amber)', marginLeft: '0.4rem' }}>
          ⚠ model not installed
        </span>
      )}
    </span>
  );
}

function KeySourceBadge({ source }) {
  if (!source || source === 'none') return null;
  return (
    <span style={{
      fontSize: '0.62rem', padding: '0.1rem 0.35rem', borderRadius: '0.25rem',
      background: source === 'env'
        ? 'color-mix(in srgb,var(--accent-blue) 15%,transparent)'
        : 'color-mix(in srgb,var(--accent-green) 15%,transparent)',
      color: source === 'env' ? 'var(--accent-blue)' : 'var(--accent-green)',
      marginLeft: '0.4rem',
    }}>
      {source === 'env' ? 'from .env' : 'saved'}
    </span>
  );
}

function ProviderCard({ id, label, desc, active, onClick }) {
  return (
    <button onClick={() => onClick(id)} style={{
      padding: '0.55rem 0.75rem', borderRadius: '0.45rem', cursor: 'pointer',
      textAlign: 'left', border: '1px solid',
      borderColor: active ? 'var(--accent-green)' : 'var(--border)',
      background: active
        ? 'color-mix(in srgb,var(--accent-green) 10%,transparent)'
        : 'var(--bg-2)',
      color: active ? 'var(--text-1)' : 'var(--text-2)',
      transition: 'all 0.12s',
    }}>
      <div style={{ fontWeight: 600, fontSize: '0.82rem', marginBottom: '0.15rem' }}>{label}</div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-3)', lineHeight: 1.4 }}>{desc}</div>
    </button>
  );
}

function InfoCard({ children }) {
  return (
    <div style={{
      background: 'color-mix(in srgb,var(--accent-blue) 8%,transparent)',
      border: '1px solid color-mix(in srgb,var(--accent-blue) 25%,transparent)',
      borderRadius: '0.45rem', padding: '0.65rem 0.85rem',
      fontSize: '0.77rem', color: 'var(--text-2)', lineHeight: 1.65,
    }}>
      {children}
    </div>
  );
}

function ExtLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      color: 'var(--accent-blue)', textDecoration: 'none', display: 'inline-flex',
      alignItems: 'center', gap: '0.2rem',
    }}>
      {children} <ExternalLink size={10} />
    </a>
  );
}

// Model dropdown — shows live models fetched from the provider when available,
// falls back to hardcoded options otherwise.
function ModelSelect({ value, onChange, liveModels, fallbackOptions, note, liveNote }) {
  const useLive = Array.isArray(liveModels) && liveModels.length > 0;
  // Always include the currently-selected model so it never disappears from the list.
  const options = useLive
    ? Array.from(new Set([value, ...liveModels].filter(Boolean))).sort()
    : null;
  return (
    <>
      <label className="pm-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        Model
        {useLive && (
          <span style={{
            fontSize: '0.6rem', padding: '0.1rem 0.35rem', borderRadius: '0.25rem',
            background: 'color-mix(in srgb,var(--accent-green) 12%,transparent)',
            color: 'var(--accent-green)', fontWeight: 600,
          }}>
            ↻ {liveModels.length} live
          </span>
        )}
      </label>
      <select className="pm-input" style={{ marginBottom: '0.25rem' }}
        value={value} onChange={onChange}>
        {useLive
          ? options.map(id => <option key={id} value={id}>{id}</option>)
          : fallbackOptions}
      </select>
      <div style={{ fontSize: '0.65rem', color: 'var(--text-3)', marginBottom: '0.75rem' }}>
        {useLive ? liveNote : note}
      </div>
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function AiGeocodeConfig() {
  const [cfg,       setCfg]       = useState(DEFAULTS);
  const [status,    setStatus]    = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [saving,        setSaving]        = useState(false);
  const [savingGeocode, setSavingGeocode] = useState(false);
  const [testing,   setTesting]   = useState(false);
  const [testText,  setTestText]  = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [msg,       setMsg]       = useState(null);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4500); };

  const loadConfig = useCallback(() => {
    api('GET', '/admin/ai-geocode/config')
      .then(d => setCfg({ ...DEFAULTS, ...d }))
      .catch(e => flash('err', 'Could not load AI settings: ' + e.message));
  }, []);

  const loadStatus = useCallback(() => {
    setStatusLoading(true);
    api('GET', '/admin/ai-geocode/status')
      .then(s => setStatus(s))
      .catch(() => setStatus(null))
      .finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => { loadConfig(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (cfg.provider !== 'none') loadStatus(); }, [cfg.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveGeocode = async () => {
    setSavingGeocode(true);
    try {
      await api('PUT', '/admin/ai-geocode/config', { geocoder: cfg.geocoder, hereKey: cfg.hereKey });
      flash('ok', 'Geocoder settings saved');
      loadConfig();
      loadStatus();
    } catch (e) { flash('err', e.message); }
    finally { setSavingGeocode(false); }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api('PUT', '/admin/ai-geocode/config', cfg);
      flash('ok', 'Settings saved');
      // Reload config so the "Key saved ✓" badge updates and inputs reset to empty
      loadConfig();
      loadStatus();
    } catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const test = async () => {
    if (!testText.trim()) return flash('err', 'Enter a test message');
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api('POST', '/admin/ai-geocode/test', { text: testText });
      setTestResult(r);
    } catch (e) { flash('err', e.message); }
    finally { setTesting(false); }
  };

  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));

  return (
    <div style={{ maxWidth: '600px' }}>
      {/* Header */}
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)',
        marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Brain size={16} style={{ color: 'var(--accent-blue)' }} /> AI Address Extraction
      </h2>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginBottom: '1.25rem', lineHeight: 1.6 }}>
        When Nominatim cannot geocode a message, AI extracts the address from the raw text and retries.
        Works as a silent fallback — no change needed to existing setup.
      </p>

      <Flash msg={msg} />

      {/* ── Geocoder backend ───────────────────────────────────────────────── */}
      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        <div className="pm-section-title">Geocoder backend</div>
        <p style={{ fontSize: '0.77rem', color: 'var(--text-3)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
          Converts extracted addresses into GPS coordinates.
          HERE has significantly better house-number coverage than Nominatim, especially for NZ, AU, and other countries with sparse OSM data.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.85rem' }}>
          <ProviderCard id="nominatim" label="Nominatim" desc="Free · No key · OpenStreetMap data"
            active={cfg.geocoder === 'nominatim'} onClick={p => set('geocoder', p)} />
          <ProviderCard id="here"      label="HERE"      desc="Free 250k/month · Best house numbers"
            active={cfg.geocoder === 'here'}      onClick={p => set('geocoder', p)} />
        </div>

        {cfg.geocoder === 'here' && (
          <>
            <InfoCard>
              <strong>Free tier:</strong> 250,000 requests/month — enough for ~8,000 geocodes/day with no cost.<br />
              <strong>Setup:</strong> Create a free account at <ExtLink href="https://developer.here.com">developer.here.com</ExtLink>,
              go to <em>Projects → REST → API Keys</em> and generate a key. <br />
              <strong>Tip:</strong> You can also set <code>HERE_API_KEY=…</code> in your <code>.env</code> file instead of entering it here.
            </InfoCard>

            <div style={{ height: '0.75rem' }} />

            <label className="pm-label">
              HERE API Key
              <KeySourceBadge source={cfg.hereKeySource} />
              {cfg.hereKeySaved && cfg.hereKeySource !== 'env' && (
                <span style={{ fontSize: '0.65rem', color: 'var(--accent-green)',
                  marginLeft: '0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                  <CheckCircle size={10} /> Key saved
                </span>
              )}
            </label>
            <input className="pm-input"
              type="password"
              autoComplete="new-password"
              value={cfg.hereKey}
              placeholder={
                cfg.hereKeySource === 'env' ? 'Loaded from HERE_API_KEY env var' :
                cfg.hereKeySaved            ? 'Enter new key to replace the saved one' :
                                              'Paste your HERE API key…'
              }
              disabled={cfg.hereKeySource === 'env'}
              onChange={e => set('hereKey', e.target.value)}
              style={{ marginBottom: '0.5rem' }}
            />

            {/* HERE status */}
            {status?.geocoder === 'here' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
                fontSize: '0.72rem', marginTop: '0.25rem', marginBottom: '0.5rem' }}>
                {status.hereConnected
                  ? <><CheckCircle size={12} style={{ color: 'var(--accent-green)' }} /><span style={{ color: 'var(--accent-green)' }}>HERE connected</span></>
                  : <><XCircle size={12} style={{ color: 'var(--accent-red)' }} /><span style={{ color: 'var(--accent-red)' }}>{status.hereError || 'HERE not reachable'}</span></>
                }
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: '0.85rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-soft)' }}>
          <button className="pm-btn pm-btn-primary" onClick={saveGeocode} disabled={savingGeocode}>
            <Save size={13} /> {savingGeocode ? 'Saving…' : 'Save geocoder settings'}
          </button>
        </div>
      </div>

      {/* ── AI provider selection ───────────────────────────────────────────── */}
      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        <div className="pm-section-title">Provider</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.85rem' }}>
          <ProviderCard id="none"   label="Disabled"  desc="AI fallback off — Nominatim only"         active={cfg.provider === 'none'}   onClick={p => set('provider', p)} />
          <ProviderCard id="groq"   label="Groq"      desc="Free · 14 400 req/day · Llama models"     active={cfg.provider === 'groq'}   onClick={p => set('provider', p)} />
          <ProviderCard id="openai" label="OpenAI"    desc="Paid · GPT-4o mini · best accuracy"        active={cfg.provider === 'openai'} onClick={p => set('provider', p)} />
          <ProviderCard id="ollama" label="Ollama"    desc="Local · no login · RPi compatible"         active={cfg.provider === 'ollama'} onClick={p => set('provider', p)} />
        </div>

        {/* Status row */}
        {cfg.provider !== 'none' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem',
            padding: '0.4rem 0', borderTop: '1px solid var(--border-soft)' }}>
            <StatusBadge status={status} loading={statusLoading} />
            <button className="pm-btn" style={{ marginLeft: 'auto', fontSize: '0.72rem', padding: '0.2rem 0.5rem' }}
              onClick={loadStatus} disabled={statusLoading}>
              <RefreshCw size={11} /> Recheck
            </button>
          </div>
        )}
      </div>

      {/* ── Groq config ────────────────────────────────────────────────────── */}
      {cfg.provider === 'groq' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">Groq settings</div>

          <InfoCard>
            <strong>Free tier:</strong> 14,400 requests/day — enough for ~10 pager messages/minute 24/7.<br />
            <strong>Setup:</strong> Create a free account at <ExtLink href="https://console.groq.com">console.groq.com</ExtLink>,
            go to <em>API Keys</em> and create a key. No credit card required.<br />
            <strong>Tip:</strong> you can also set <code>GROQ_API_KEY=…</code> in your <code>.env</code> file
            instead of entering it here — it takes priority.
          </InfoCard>

          <div style={{
            marginTop: '0.6rem',
            padding: '0.5rem 0.75rem', borderRadius: '0.4rem',
            background: 'color-mix(in srgb,var(--accent-amber) 8%,transparent)',
            border: '1px solid color-mix(in srgb,var(--accent-amber) 30%,transparent)',
            fontSize: '0.75rem', color: 'var(--text-2)', lineHeight: 1.6,
          }}>
            ⚠ <strong>Privacy:</strong> The decoded text of every pager message is sent to <strong>Groq's cloud servers</strong> (USA) for processing.
            Do not enable if your messages contain sensitive personal data that must stay on-premises.
            For a fully local and private alternative, use <strong>Ollama</strong> instead.
          </div>

          <div style={{ height: '0.75rem' }} />

          <label className="pm-label">
            API Key
            <KeySourceBadge source={cfg.groqKeySource} />
            {cfg.groqKeySaved && cfg.groqKeySource !== 'env' && (
              <span style={{ fontSize: '0.65rem', color: 'var(--accent-green)',
                marginLeft: '0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                <CheckCircle size={10} /> Key saved
              </span>
            )}
          </label>
          <input className="pm-input"
            type="password"
            autoComplete="new-password"
            value={cfg.groqKey}
            placeholder={
              cfg.groqKeySource === 'env' ? 'Loaded from GROQ_API_KEY env var' :
              cfg.groqKeySaved            ? 'Enter new key to replace the saved one' :
                                            'gsk_…'
            }
            disabled={cfg.groqKeySource === 'env'}
            onChange={e => set('groqKey', e.target.value)}
            style={{ marginBottom: '0.75rem' }}
          />

          <ModelSelect
            value={cfg.groqModel}
            onChange={e => set('groqModel', e.target.value)}
            liveModels={status?.availableModels}
            fallbackOptions={<>
              <option value="llama-3.1-8b-instant">llama-3.1-8b-instant — fast, free, recommended</option>
              <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile — slower but smarter</option>
              <option value="mixtral-8x7b-32768">mixtral-8x7b-32768 — multilingual</option>
              <option value="gemma2-9b-it">gemma2-9b-it — Google Gemma</option>
            </>}
            note={<>All models are free on Groq. <ExtLink href="https://console.groq.com/docs/models">Full model list</ExtLink></>}
            liveNote={<>Model list fetched live from Groq. All are free. <ExtLink href="https://console.groq.com/docs/models">Docs</ExtLink></>}
          />
        </div>
      )}

      {/* ── OpenAI config ──────────────────────────────────────────────────── */}
      {cfg.provider === 'openai' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">OpenAI settings</div>

          <InfoCard>
            <strong>Cost:</strong> GPT-4o mini costs ~$0.15 per million tokens.
            One pager message ≈ 60 tokens → <strong>$5 lasts ~55,000 messages</strong>.<br />
            <strong>Setup:</strong> Go to <ExtLink href="https://platform.openai.com/api-keys">platform.openai.com/api-keys</ExtLink>,
            create a key and add a small credit ($5 minimum).<br />
            <strong>Tip:</strong> You can also set <code>OPENAI_API_KEY=…</code> in your <code>.env</code> file.
          </InfoCard>

          <div style={{
            marginTop: '0.6rem',
            padding: '0.5rem 0.75rem', borderRadius: '0.4rem',
            background: 'color-mix(in srgb,var(--accent-amber) 8%,transparent)',
            border: '1px solid color-mix(in srgb,var(--accent-amber) 30%,transparent)',
            fontSize: '0.75rem', color: 'var(--text-2)', lineHeight: 1.6,
          }}>
            ⚠ <strong>Privacy:</strong> The decoded text of every pager message is sent to <strong>OpenAI's cloud servers</strong> (USA) for processing.
            Do not enable if your messages contain sensitive personal data that must stay on-premises.
            For a fully local and private alternative, use <strong>Ollama</strong> instead.
          </div>

          <div style={{ height: '0.75rem' }} />

          <label className="pm-label">
            API Key
            <KeySourceBadge source={cfg.openaiKeySource} />
            {cfg.openaiKeySaved && cfg.openaiKeySource !== 'env' && (
              <span style={{ fontSize: '0.65rem', color: 'var(--accent-green)',
                marginLeft: '0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                <CheckCircle size={10} /> Key saved
              </span>
            )}
          </label>
          <input className="pm-input"
            type="password"
            autoComplete="new-password"
            value={cfg.openaiKey}
            placeholder={
              cfg.openaiKeySource === 'env' ? 'Loaded from OPENAI_API_KEY env var' :
              cfg.openaiKeySaved            ? 'Enter new key to replace the saved one' :
                                              'sk-…'
            }
            disabled={cfg.openaiKeySource === 'env'}
            onChange={e => set('openaiKey', e.target.value)}
            style={{ marginBottom: '0.75rem' }}
          />

          <ModelSelect
            value={cfg.openaiModel}
            onChange={e => set('openaiModel', e.target.value)}
            liveModels={status?.availableModels}
            fallbackOptions={<>
              <option value="gpt-4o-mini">gpt-4o-mini — cheapest, recommended</option>
              <option value="gpt-4o">gpt-4o — most accurate, higher cost</option>
              <option value="gpt-4.1-mini">gpt-4.1-mini — newer mini model</option>
              <option value="gpt-3.5-turbo">gpt-3.5-turbo — legacy, low cost</option>
            </>}
            note={<><ExtLink href="https://openai.com/pricing">OpenAI pricing</ExtLink>{' · '}<ExtLink href="https://platform.openai.com/usage">Usage dashboard</ExtLink></>}
            liveNote={<>Model list fetched live from OpenAI. <ExtLink href="https://openai.com/pricing">Pricing</ExtLink>{' · '}<ExtLink href="https://platform.openai.com/usage">Usage</ExtLink></>}
          />
        </div>
      )}

      {/* ── Ollama config ──────────────────────────────────────────────────── */}
      {cfg.provider === 'ollama' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">Ollama settings</div>

          <InfoCard>
            <strong>Local, free, no account needed.</strong> Ollama runs an LLM on your own machine.
            No data ever leaves your server — fully private.<br /><br />

            <strong>Install (Linux / Proxmox / RPi):</strong>
            <code style={{ fontSize: '0.72rem', display: 'block', margin: '0.3rem 0',
              background: 'var(--bg-0)', padding: '0.3rem 0.5rem', borderRadius: '0.3rem' }}>
              curl -fsSL https://ollama.com/install.sh | sh
            </code>

            <strong>Recommended model by hardware:</strong><br />
            <table style={{ width: '100%', borderCollapse: 'collapse', margin: '0.4rem 0', fontSize: '0.72rem' }}>
              <tbody>
                <tr>
                  <td style={{ paddingRight: '0.75rem', color: 'var(--text-3)', whiteSpace: 'nowrap', paddingBottom: '0.2rem' }}>Raspberry Pi (1–2 GB RAM)</td>
                  <td><code>ollama pull llama3.2:1b</code> — ~10 s/req</td>
                </tr>
                <tr>
                  <td style={{ paddingRight: '0.75rem', color: 'var(--text-3)', whiteSpace: 'nowrap', paddingBottom: '0.2rem' }}>Proxmox VM / server (2–4 GB RAM)</td>
                  <td><code>ollama pull llama3.2:3b</code> — ~4 s/req ✓ recommended</td>
                </tr>
                <tr>
                  <td style={{ paddingRight: '0.75rem', color: 'var(--text-3)', whiteSpace: 'nowrap', paddingBottom: '0.2rem' }}>Server with 6+ GB RAM</td>
                  <td><code>ollama pull llama3.1:8b</code> — ~12 s/req, best accuracy</td>
                </tr>
                <tr>
                  <td style={{ paddingRight: '0.75rem', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>Server with GPU passthrough</td>
                  <td><code>ollama pull llama3.1:8b</code> — &lt;2 s/req</td>
                </tr>
              </tbody>
            </table>

            <ExtLink href="https://ollama.com/library">Browse all Ollama models</ExtLink>
            {' · '}
            <ExtLink href="https://ollama.com">ollama.com</ExtLink>
          </InfoCard>

          <div style={{ height: '0.75rem' }} />

          <label className="pm-label">Ollama URL</label>
          <input className="pm-input" value={cfg.ollamaUrl}
            placeholder="http://localhost:11434"
            onChange={e => set('ollamaUrl', e.target.value)}
            style={{ marginBottom: '0.75rem' }}
          />

          <label className="pm-label">Model name</label>
          <input className="pm-input" value={cfg.ollamaModel}
            placeholder="llama3.2:1b"
            onChange={e => set('ollamaModel', e.target.value)}
            style={{ marginBottom: '0.25rem' }}
          />
          <div style={{ fontSize: '0.65rem', color: 'var(--text-3)', marginBottom: '0.5rem' }}>
            Must match exactly what you pulled with <code>ollama pull &lt;model&gt;</code>
          </div>

          {/* Installed models list */}
          {status?.ollamaModels?.length > 0 && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginTop: '0.4rem' }}>
              Installed: {status.ollamaModels.map(m => (
                <span key={m} style={{
                  display: 'inline-block', margin: '0.1rem 0.2rem',
                  padding: '0.1rem 0.35rem', borderRadius: '0.25rem',
                  background: m.startsWith(cfg.ollamaModel.split(':')[0])
                    ? 'color-mix(in srgb,var(--accent-green) 15%,transparent)'
                    : 'var(--bg-0)',
                  color: m.startsWith(cfg.ollamaModel.split(':')[0])
                    ? 'var(--accent-green)' : 'var(--text-3)',
                  border: '1px solid var(--border-soft)',
                  fontFamily: 'monospace', fontSize: '0.68rem',
                }}>{m}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── How it works ───────────────────────────────────────────────────── */}
      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        <div className="pm-section-title"><Info size={12} style={{ marginRight: '0.3rem' }} />How it works</div>
        <div style={{ fontSize: '0.77rem', color: 'var(--text-3)', lineHeight: 1.75 }}>

          {/* AI enabled path */}
          <div style={{ marginBottom: '0.5rem', fontWeight: 600, fontSize: '0.72rem',
            color: 'var(--accent-green)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            When AI is enabled
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.3rem' }}>
            <span style={{ color: 'var(--accent-green)', fontWeight: 700, flexShrink: 0 }}>1.</span>
            <span>Message arrives → <strong>AI reads the raw text</strong> and extracts street + house number + settlement directly</span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.3rem' }}>
            <span style={{ color: 'var(--accent-green)', fontWeight: 700, flexShrink: 0 }}>2.</span>
            <span>{cfg.geocoder === 'here' ? 'HERE' : 'Nominatim'} geocodes the AI-formed address → coordinates saved</span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <span style={{ color: 'var(--accent-amber)', fontWeight: 700, flexShrink: 0 }}>3.</span>
            <span>If AI is unreachable or returns nothing → falls back to regex pipeline → {cfg.geocoder === 'here' ? 'HERE' : 'Nominatim'}</span>
          </div>

          {/* Disabled path */}
          <div style={{ marginBottom: '0.5rem', fontWeight: 600, fontSize: '0.72rem',
            color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            When AI is disabled
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <span style={{ color: 'var(--text-3)', fontWeight: 700, flexShrink: 0 }}>1.</span>
            <span>Regex pipeline extracts address candidates → Nominatim geocodes — same as before</span>
          </div>

          <div style={{ marginTop: '0.75rem', padding: '0.4rem 0.6rem',
            background: 'var(--bg-0)', borderRadius: '0.35rem', fontFamily: 'monospace', fontSize: '0.7rem' }}>
            AI API calls happen once per message — only when a message has no explicit coordinates.
            Cached Nominatim results are reused; no duplicate API calls.
          </div>
        </div>
      </div>

      {/* ── Save button ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
        <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
          <Save size={13} /> {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      {/* ── Test section ───────────────────────────────────────────────────── */}
      <div className="pm-card">
        <div className="pm-section-title"><Play size={12} style={{ marginRight: '0.3rem' }} />Test extraction</div>
        <p style={{ fontSize: '0.77rem', color: 'var(--text-3)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
          Paste a pager message to see what address the AI extracts. Uses the currently <em>saved</em> settings.
        </p>
        <textarea
          className="pm-input"
          style={{ width: '100%', minHeight: '3.5rem', fontFamily: 'monospace',
            fontSize: '0.8rem', resize: 'vertical', marginBottom: '0.6rem', boxSizing: 'border-box' }}
          value={testText}
          onChange={e => setTestText(e.target.value)}
          placeholder="Paste a pager message…"
        />
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="pm-btn pm-btn-primary" onClick={test}
            disabled={testing || cfg.provider === 'none'}>
            <Play size={13} /> {testing ? 'Asking AI…' : 'Extract address'}
          </button>
          {cfg.provider === 'none' && (
            <span style={{ fontSize: '0.72rem', color: 'var(--accent-amber)' }}>
              <AlertCircle size={11} style={{ marginRight: '0.25rem' }} />
              Enable a provider first
            </span>
          )}
        </div>

        {/* Result display */}
        {testResult && (
          <div style={{ marginTop: '0.85rem' }}>
            {testResult.ok ? (
              <div>
                <div style={{ fontSize: '0.72rem', color: 'var(--accent-green)',
                  display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: '0.4rem' }}>
                  <CheckCircle size={12} /> Address extracted
                </div>
                <table style={{ fontSize: '0.78rem', borderCollapse: 'collapse', width: '100%' }}>
                  {[
                    ['Street',       testResult.extracted?.street],
                    ['House number', testResult.extracted?.houseNumber],
                    ['Settlement',   testResult.extracted?.settlement],
                  ].map(([label, val]) => (
                    <tr key={label}>
                      <td style={{ color: 'var(--text-3)', paddingRight: '1rem',
                        paddingBottom: '0.2rem', whiteSpace: 'nowrap' }}>{label}</td>
                      <td style={{ fontFamily: 'monospace', color: val ? 'var(--text-1)' : 'var(--text-3)',
                        fontStyle: val ? 'normal' : 'italic' }}>
                        {val || 'null'}
                      </td>
                    </tr>
                  ))}
                </table>
                <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-3)' }}>
                  Nominatim query would be:{' '}
                  <code style={{ color: 'var(--text-2)' }}>
                    {[testResult.extracted?.street, testResult.extracted?.houseNumber]
                      .filter(Boolean).join(' ')}
                    {testResult.extracted?.settlement ? `, ${testResult.extracted.settlement}` : ''}
                    , Slovenia
                  </code>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '0.77rem', color: 'var(--accent-red)',
                display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                <XCircle size={12} />
                {testResult.error || 'AI could not extract an address from this message'}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { Settings2, Save, Clock, Download } from 'lucide-react';
import { useSite } from '../../context/SiteContext.jsx';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const getToken = () => localStorage.getItem('pm_token') || '';

const DEFAULTS = { siteName: 'PagerMonitor', siteDescription: 'Real-time pager decoder', newBadgeSeconds: 10, mapDotColor: '#00ff9d', showMapButton: true, mapMaxAgeDays: 30, publicMode: false, geocodeCountry: 'si' };

async function fetchSettings() {
  const r = await fetch(`${BASE}/admin/site-settings`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function saveSettings(data) {
  const r = await fetch(`${BASE}/admin/site-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div style={{
      padding: '0.45rem 0.75rem', borderRadius: '0.4rem', fontSize: '0.78rem',
      fontFamily: 'monospace', marginBottom: '0.75rem',
      color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
      background: `color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
    }}>{msg.text}</div>
  );
}

export default function SiteSettings() {
  const { update: updateSite } = useSite();

  // Separate state for each block
  const [siteForm, setSiteForm]         = useState({ siteName: DEFAULTS.siteName, siteDescription: DEFAULTS.siteDescription });
  const [badgeSeconds, setBadgeSeconds] = useState(DEFAULTS.newBadgeSeconds);
  const [mapDotColor, setMapDotColor]       = useState(DEFAULTS.mapDotColor);
  const [showMapButton, setShowMapButton]   = useState(DEFAULTS.showMapButton);
  const [mapMaxAgeDays, setMapMaxAgeDays]   = useState(DEFAULTS.mapMaxAgeDays);
  const [geocodeCountry, setGeocodeCountry] = useState(DEFAULTS.geocodeCountry);
  const [publicMode, setPublicMode]         = useState(DEFAULTS.publicMode);
  const [savingMap, setSavingMap]       = useState(false);
  const [mapMsg, setMapMsg]             = useState(null);

  const [fetching,   setFetching]   = useState(false);
  const [fetchLog,   setFetchLog]   = useState([]);
  const [fetchError, setFetchError] = useState(false);
  const logRef = useRef(null);

  const [savingSite,  setSavingSite]  = useState(false);
  const [savingBadge, setSavingBadge] = useState(false);
  const [siteMsg,  setSiteMsg]  = useState(null);
  const [badgeMsg, setBadgeMsg] = useState(null);

  // Load everything once
  useEffect(() => {
    fetchSettings()
      .then(d => {
        setSiteForm({
          siteName:        d.siteName        || DEFAULTS.siteName,
          siteDescription: d.siteDescription || DEFAULTS.siteDescription,
        });
        setBadgeSeconds(d.newBadgeSeconds ?? DEFAULTS.newBadgeSeconds);
        setMapDotColor(d.mapDotColor || DEFAULTS.mapDotColor);
        setShowMapButton(d.showMapButton !== false);
        setMapMaxAgeDays(d.mapMaxAgeDays ?? DEFAULTS.mapMaxAgeDays);
        setGeocodeCountry(d.geocodeCountry || DEFAULTS.geocodeCountry);
        setPublicMode(!!d.publicMode);
      })
      .catch(console.warn);
  }, []);

  const flashSite  = (type, text) => { setSiteMsg({ type, text });  setTimeout(() => setSiteMsg(null),  3500); };
  const flashBadge = (type, text) => { setBadgeMsg({ type, text }); setTimeout(() => setBadgeMsg(null), 3500); };
  const flashMap   = (type, text) => { setMapMsg({ type, text });   setTimeout(() => setMapMsg(null),   3500); };

  const allSettings = () => ({ ...siteForm, newBadgeSeconds: badgeSeconds, mapDotColor, showMapButton, mapMaxAgeDays, geocodeCountry, publicMode });

  // Save site name/description only
  const saveSite = async () => {
    setSavingSite(true);
    try {
      await saveSettings(allSettings());
      updateSite(allSettings());
      flashSite('ok', 'Site name and description saved');
    } catch (e) { flashSite('err', e.message); }
    finally { setSavingSite(false); }
  };

  // Save badge duration only
  const saveBadge = async () => {
    setSavingBadge(true);
    try {
      await saveSettings(allSettings());
      updateSite(allSettings());
      flashBadge('ok', `NEW badge duration set to ${badgeSeconds}s`);
    } catch (e) { flashBadge('err', e.message); }
    finally { setSavingBadge(false); }
  };

  // Save map settings
  const saveMap = async () => {
    setSavingMap(true);
    try {
      await saveSettings(allSettings());
      updateSite(allSettings());
      flashMap('ok', 'Map settings saved');
    } catch (e) { flashMap('err', e.message); }
    finally { setSavingMap(false); }
  };

  const startFetch = async () => {
    setFetching(true);
    setFetchLog([]);
    setFetchError(false);
    const append = text => setFetchLog(l => {
      const updated = [...l, text];
      setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 0);
      return updated;
    });
    try {
      const res = await fetch(`${BASE}/admin/geo-data/fetch?cc=${encodeURIComponent(geocodeCountry)}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'log')   append(ev.text);
            if (ev.type === 'error') { setFetchError(true); append(`\n✗ ${ev.text}`); setFetching(false); return; }
            if (ev.type === 'done')  { append('\n✓ Done'); setFetching(false); }
          } catch (_) {}
        }
      }
    } catch (e) {
      setFetchError(true);
      append(`\n✗ ${e.message}`);
    } finally {
      setFetching(false);
    }
  };

  const nameParts = siteForm.siteName.trim().match(/^(.*?)(\S+)$/) || ['', '', siteForm.siteName];

  return (
    <div style={{ maxWidth: '480px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'1rem',
        display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Settings2 size={16} style={{ color:'var(--accent-blue)' }} /> Site Settings
      </h2>

      {/* ── Block 1: Site name & description ────────────────── */}
      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        <div className="pm-section-title">
          <Settings2 size={13} /> Page name &amp; description
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label className="pm-label">Site / page name</label>
          <input className="pm-input" value={siteForm.siteName}
            onChange={e => setSiteForm(f => ({ ...f, siteName: e.target.value }))}
            placeholder="PagerMonitor" />
          <div style={{ fontSize:'0.72rem', color:'var(--text-3)', marginTop:'0.3rem' }}>
            Shown in header logo and browser tab. Last word highlighted green.
          </div>
        </div>

        {/* Live preview */}
        <div style={{ marginBottom:'1rem', padding:'0.5rem 0.75rem', borderRadius:'0.5rem',
          background:'var(--bg-0)', border:'1px solid var(--border)',
          display:'flex', alignItems:'center', gap:'0.5rem' }}>
          <span style={{ fontSize:'0.7rem', color:'var(--text-3)' }}>Preview:</span>
          <span style={{ fontFamily:'"Space Grotesk"', fontWeight:700, fontSize:'0.95rem', color:'var(--text-1)' }}>
            {nameParts[1]}
            <span style={{ color:'var(--accent-green)', textShadow:'var(--glow-green)' }}>{nameParts[2]}</span>
          </span>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label className="pm-label">Description / subtitle</label>
          <input className="pm-input" value={siteForm.siteDescription}
            onChange={e => setSiteForm(f => ({ ...f, siteDescription: e.target.value }))}
            placeholder="Real-time pager decoder" />
          <div style={{ fontSize:'0.72rem', color:'var(--text-3)', marginTop:'0.3rem' }}>
            Shown below the name on the login page.
          </div>
        </div>

        <Flash msg={siteMsg} />

        <button className="pm-btn pm-btn-primary" onClick={saveSite}
          disabled={savingSite || !siteForm.siteName.trim()}>
          <Save size={13} /> {savingSite ? 'Saving…' : 'Save name & description'}
        </button>
      </div>

      {/* ── Block 2: NEW badge duration ──────────────────────── */}
      <div className="pm-card">
        <div className="pm-section-title">
          <Clock size={13} /> NEW badge duration
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', marginBottom:'0.5rem' }}>
            <input type="range" min="3" max="120" step="1" value={badgeSeconds}
              onChange={e => setBadgeSeconds(parseInt(e.target.value, 10))}
              style={{ flex:1, accentColor:'var(--accent-green)' }} />
            <span style={{ fontFamily:'monospace', fontSize:'1.1rem', fontWeight:700,
              color:'var(--accent-green)', minWidth:'46px', textAlign:'right' }}>
              {badgeSeconds}s
            </span>
          </div>

          {/* Visual preview of the badge */}
          <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', marginBottom:'0.5rem' }}>
            <span style={{ fontSize:'0.8rem', color:'var(--text-3)' }}>Preview:</span>
            <span style={{ fontSize:'0.65rem', fontWeight:800, color:'var(--accent-green)',
              background:'color-mix(in srgb, var(--accent-green) 15%, transparent)',
              padding:'0.15rem 0.5rem', borderRadius:'0.3rem', letterSpacing:'0.05em',
              animation:'new-pulse 2s ease-in-out infinite' }}>
              NEW
            </span>
            <span style={{ fontSize:'0.78rem', color:'var(--text-3)', fontFamily:'monospace' }}>
              visible for {badgeSeconds} second{badgeSeconds !== 1 ? 's' : ''} after message arrives
            </span>
          </div>
          <style>{`@keyframes new-pulse { 0%,100%{opacity:1} 50%{opacity:0.45} }`}</style>

          <div style={{ fontSize:'0.72rem', color:'var(--text-3)' }}>
            How long the <span style={{ color:'var(--accent-green)', fontWeight:700 }}>NEW</span> badge
            stays on a freshly received message in the feed. Range: 3–120 seconds.
          </div>
        </div>

        <Flash msg={badgeMsg} />

        <button className="pm-btn pm-btn-primary" onClick={saveBadge} disabled={savingBadge}>
          <Save size={13} /> {savingBadge ? 'Saving…' : 'Save badge duration'}
        </button>
      </div>

      {/* ── Block 3: Map settings ─────────────────────────────── */}
      <div className="pm-card" style={{ marginTop:'1rem' }}>
        <div className="pm-section-title">
          <span>🗺</span> Map settings
        </div>

        <div style={{ marginBottom:'1rem' }}>
          <label className="pm-label">Map marker dot color</label>
          <div style={{ display:'flex', alignItems:'center', gap:'0.75rem' }}>
            <input type="color" value={mapDotColor}
              onChange={e => setMapDotColor(e.target.value)}
              style={{ width:'40px', height:'40px', borderRadius:'0.4rem',
                border:'1px solid var(--border)', padding:'2px', cursor:'pointer',
                background:'var(--bg-3)' }} />
            {/* Preview dot */}
            <div style={{ width:'16px', height:'16px', borderRadius:'50%',
              background: mapDotColor, border:'2px solid #fff',
              boxShadow: `0 0 8px ${mapDotColor}` }} />
            <span style={{ fontFamily:'monospace', fontSize:'0.8rem', color:'var(--text-2)' }}>
              {mapDotColor}
            </span>
          </div>
          <div style={{ fontSize:'0.72rem', color:'var(--text-3)', marginTop:'0.3rem' }}>
            Color of location markers on the map. Default: green. Used when alias has no color set.
          </div>
        </div>

        <div style={{ marginBottom:'1rem' }}>
          <label className="pm-label">Show map button on messages with a location</label>
          <label style={{ display:'flex', alignItems:'center', gap:'0.6rem',
            cursor:'pointer', fontSize:'0.85rem', color:'var(--text-1)', marginTop:'0.3rem' }}>
            <input type="checkbox" checked={showMapButton}
              onChange={e => setShowMapButton(e.target.checked)} />
            Show 📍 button on messages that have confirmed coordinates
          </label>
        </div>

        <div style={{ marginBottom:'1rem' }}>
          <label className="pm-label">Geocoding country code</label>
          <div style={{ display:'flex', alignItems:'center', gap:'0.75rem' }}>
            <input className="pm-input" value={geocodeCountry}
              onChange={e => setGeocodeCountry(e.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 2))}
              placeholder="si" maxLength={2}
              style={{ width:'60px', textAlign:'center', fontFamily:'monospace', textTransform:'lowercase' }} />
            <span style={{ fontSize:'0.8rem', color:'var(--text-2)' }}>
              {geocodeCountry === 'si' ? 'Slovenia' : geocodeCountry === 'de' ? 'Germany' : geocodeCountry === 'at' ? 'Austria' : geocodeCountry === 'hr' ? 'Croatia' : geocodeCountry === 'it' ? 'Italy' : geocodeCountry === 'gb' ? 'United Kingdom' : geocodeCountry === 'us' ? 'United States' : geocodeCountry === 'fr' ? 'France' : geocodeCountry.toUpperCase()}
            </span>
          </div>
          <div style={{ fontSize:'0.72rem', color:'var(--text-3)', marginTop:'0.3rem' }}>
            2-letter ISO country code used when geocoding addresses from message text (e.g. <code>si</code>, <code>de</code>, <code>hr</code>, <code>at</code>).
          </div>
        </div>

        <div>
          <label className="pm-label">Show locations from last (days)</label>
          <div style={{ display:'flex', alignItems:'center', gap:'0.75rem' }}>
            <input type="range" min="1" max="365" step="1" value={mapMaxAgeDays}
              onChange={e => setMapMaxAgeDays(parseInt(e.target.value, 10))}
              style={{ flex:1, accentColor:'var(--accent-green)' }} />
            <span style={{ fontFamily:'monospace', fontSize:'1rem', fontWeight:700,
              color:'var(--accent-green)', minWidth:'60px', textAlign:'right' }}>
              {mapMaxAgeDays === 365 ? '1 year' : `${mapMaxAgeDays}d`}
            </span>
          </div>
          <div style={{ fontSize:'0.72rem', color:'var(--text-3)', marginTop:'0.3rem' }}>
            Only show locations from the last {mapMaxAgeDays} day{mapMaxAgeDays !== 1 ? 's' : ''} on the map.
            Older locations are hidden but not deleted. Range: 1–365 days.
          </div>
        </div>

        {/* ── Geo data download ──────────────────────────────── */}
        <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
          <label className="pm-label">Street &amp; place data</label>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginBottom: '0.6rem' }}>
            Download OSM streets and settlements for <code style={{ color: 'var(--accent-blue)' }}>{geocodeCountry}</code> to
            improve address geocoding accuracy. Runs <code>fetchStreets</code> then <code>fetchPlaces</code> — takes 1–3 min.
          </div>
          <button className="pm-btn" onClick={startFetch} disabled={fetching}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Download size={13} />
            {fetching ? 'Downloading…' : `Update geo data (${geocodeCountry.toUpperCase()})`}
          </button>
          {fetchLog.length > 0 && (
            <pre ref={logRef} style={{
              marginTop: '0.6rem', padding: '0.5rem 0.75rem',
              background: 'var(--bg-0)', border: `1px solid ${fetchError ? 'color-mix(in srgb, var(--accent-red) 40%, var(--border))' : 'var(--border)'}`,
              borderRadius: '0.4rem', fontSize: '0.70rem', fontFamily: 'monospace',
              maxHeight: '160px', overflowY: 'auto',
              color: fetchError ? 'var(--accent-red)' : 'var(--text-2)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0,
            }}>
              {fetchLog.join('')}
            </pre>
          )}
        </div>

        <Flash msg={mapMsg} />

        <button className="pm-btn pm-btn-primary" onClick={saveMap} disabled={savingMap}
          style={{ marginTop: '1rem' }}>
          <Save size={13}/> {savingMap ? 'Saving…' : 'Save map settings'}
        </button>

      </div>{/* end map card */}

      {/* ── Block 4: Public read-only mode ───────────────────── */}
      <div className="pm-card" style={{ marginTop:'1rem', borderColor: publicMode ? 'color-mix(in srgb, var(--accent-amber) 40%, var(--border))' : 'var(--border)' }}>
        <div className="pm-section-title">
          <span>🌐</span> Public read-only mode
        </div>

        <div style={{ marginBottom:'1rem' }}>
          <label style={{ display:'flex', alignItems:'flex-start', gap:'0.6rem',
            cursor:'pointer', fontSize:'0.85rem', color:'var(--text-1)' }}>
            <input type="checkbox" checked={publicMode}
              onChange={e => setPublicMode(e.target.checked)}
              style={{ marginTop:'3px' }} />
            <div>
              Allow anyone to view the feed, map, and search without logging in
              {publicMode && (
                <div style={{ marginTop:'0.35rem', padding:'0.4rem 0.6rem', borderRadius:'0.4rem',
                  background:'color-mix(in srgb, var(--accent-amber) 12%, transparent)',
                  border:'1px solid color-mix(in srgb, var(--accent-amber) 30%, transparent)',
                  fontSize:'0.75rem', color:'var(--accent-amber)', fontFamily:'monospace' }}>
                  ⚠ Public mode is ON — anyone with the URL can view messages
                </div>
              )}
            </div>
          </label>
          <div style={{ fontSize:'0.72rem', color:'var(--text-3)', marginTop:'0.5rem', marginLeft:'1.4rem', lineHeight:1.6 }}>
            When enabled: the live feed, map, and search are visible without login.
            Settings panel, user management, and notification settings remain protected.
            Visitors see a <span style={{ color:'var(--accent-blue)' }}>Log in</span> button to access full features.
          </div>
        </div>

        <button className="pm-btn pm-btn-primary" onClick={saveMap} disabled={savingMap}>
          <Save size={13}/> {savingMap ? 'Saving…' : 'Save access settings'}
        </button>
      </div>
    </div>
  );
}

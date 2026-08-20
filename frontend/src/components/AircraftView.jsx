import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader, Plane, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { getJson, BASEMAPS, useBasemap, BasemapSwitcher, LastUpdated } from './weatherMapShared.jsx';
import { fetchTrackedAircraft, addTrackedAircraft, setTrackedAircraftEnabled, deleteTrackedAircraft } from '../utils/api.js';
import { useAuth } from '../context/AuthContext.jsx';

// This just re-reads our own backend's in-memory cache (no OpenSky cost), so we
// poll much faster than the backend's own 1-5 min OpenSky cycle — otherwise the
// two independent timers drift out of phase and a new position can sit unseen
// for almost a full extra backend cycle before this catches it.
const REFRESH_MS = 15 * 1000;
const BASEMAP_STORAGE_KEY = 'pm_aircraft_basemap';

function fmtAge(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'pravkar';
  if (mins < 60) return `pred ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `pred ${hours}h`;
  return `pred ${Math.floor(hours / 24)}d`;
}

function statusColor(a) {
  if (a.live && !a.onGround) return '#3fb950'; // airborne
  if (a.live && a.onGround) return '#d29922';  // on ground, broadcasting
  return '#8b949e'; // last known position only
}

function statusLabel(a) {
  if (a.live && !a.onGround) return 'V zraku';
  if (a.live && a.onGround) return 'Na tleh';
  if (a.lastSeen) return `Nazadnje zaznano ${fmtAge(a.lastSeen)}`;
  return 'Ni bilo zaznano v zadnjem času';
}

function buildPopupHtml(a) {
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.78rem;min-width:190px;color:var(--text-1)">
      <div style="font-weight:700;font-size:0.9rem">${a.reg}</div>
      <div style="color:var(--text-3);font-size:0.68rem;margin-bottom:0.45rem">${statusLabel(a)}</div>
      <div style="display:flex;flex-direction:column;gap:0.15rem;font-size:0.72rem">
        <div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">Višina</span><span style="color:var(--text-1)">${a.altitude != null ? `${Math.round(a.altitude)} m` : '—'}</span></div>
        <div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">Hitrost</span><span style="color:var(--text-1)">${a.velocity != null ? `${Math.round(a.velocity * 3.6)} km/h` : '—'}</span></div>
        <div style="display:flex;justify-content:space-between;gap:0.75rem"><span style="color:var(--text-3)">Smer</span><span style="color:var(--text-1)">${a.heading != null ? `${Math.round(a.heading)}°` : '—'}</span></div>
      </div>
      ${a.track && a.track.length > 1 ? `<div style="color:var(--text-3);font-size:0.65rem;margin-top:0.45rem">Klikni oznako za prikaz poti leta</div>` : ''}
    </div>
  `;
}

// Top-down plane silhouette, drawn pointing north — rotated per-marker to match heading.
const PLANE_SVG_PATH = 'M12 2c.6 0 1 .4 1 1v6.5l7.5 4.5c.5.3.5 1.7 0 2l-7.5-2.5V18l3 2v1l-4-1-4 1v-1l3-2v-4.5L3.5 16c-.5-.3-.5-1.7 0-2L11 9.5V3c0-.6.4-1 1-1Z';

function planeIcon(L, a) {
  const color = statusColor(a);
  const opacity = a.live ? 1 : 0.45;
  const rotation = a.heading != null ? a.heading : 0;
  const html = `
    <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;transform:rotate(${rotation}deg);opacity:${opacity}">
      <svg width="36" height="36" viewBox="0 0 24 24"><path d="${PLANE_SVG_PATH}" fill="${color}" stroke="#fff" stroke-width="0.8"/></svg>
    </div>`;
  return L.divIcon({ html, className: 'pm-aircraft-icon', iconSize: [40, 40], iconAnchor: [20, 20] });
}

// ── Airborne-now strip ───────────────────────────────────────────────────────
function StatusStrip({ aircraft }) {
  const airborne = aircraft.filter(a => a.live && !a.onGround);
  if (!airborne.length) return null;
  return (
    <div style={{
      flexShrink: 0, borderBottom: '1px solid var(--border)', padding: '0.5rem 0.75rem',
      display: 'flex', alignItems: 'center', gap: '0.5rem',
      background: 'color-mix(in srgb, #3fb950 14%, transparent)',
      color: '#3fb950', fontSize: '0.8rem', fontWeight: 600,
    }}>
      <Plane size={14} />
      {airborne.length} letal v zraku — {airborne.map(a => a.reg).join(', ')}
    </div>
  );
}

// ── Aircraft map ─────────────────────────────────────────────────────────────
function AircraftMap({ aircraft, visible, updatedAt }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const tileLayerRef = useRef(null);
  const trackLayerRef = useRef(null);
  const [basemap, setBasemap] = useBasemap(BASEMAP_STORAGE_KEY, 'streets');
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    if (mapRef.current || !divRef.current || !window.L) return;
    const L = window.L;
    const map = L.map(divRef.current, { center: [45.85, 14.2], zoom: 8 }); // Slovenian coast — usual scooping grounds
    map.on('click', () => setSelectedId(null));
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; tileLayerRef.current = null; trackLayerRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    const style = BASEMAPS[basemap] || BASEMAPS.streets;
    if (tileLayerRef.current) map.removeLayer(tileLayerRef.current);
    tileLayerRef.current = L.tileLayer(style.url, { attribution: style.attr, maxZoom: 19, detectRetina: true }).addTo(map);
    localStorage.setItem(BASEMAP_STORAGE_KEY, basemap);
  }, [basemap]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => mapRef.current?.invalidateSize());
  }, [visible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    markersRef.current.forEach(m => map.removeLayer(m));
    markersRef.current = aircraft
      .filter(a => a.lat != null && a.lon != null)
      .map(a => {
        const marker = L.marker([a.lat, a.lon], { icon: planeIcon(L, a) }).addTo(map);
        marker.bindPopup(buildPopupHtml(a), { minWidth: 210 });
        marker.on('click', () => setSelectedId(prev => (prev === a.id ? null : a.id)));
        return marker;
      });
  }, [aircraft]);

  // Flight path for the selected aircraft — cleared on deselect or when it goes out of range.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    if (trackLayerRef.current) { map.removeLayer(trackLayerRef.current); trackLayerRef.current = null; }
    const selected = aircraft.find(a => a.id === selectedId);
    if (selected?.track?.length > 1) {
      trackLayerRef.current = L.polyline(selected.track.map(p => [p.lat, p.lon]), {
        color: '#ffd700', weight: 3, opacity: 0.9,
      }).addTo(map);
    }
  }, [aircraft, selectedId]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <LastUpdated updatedAt={updatedAt} />
      <BasemapSwitcher basemap={basemap} onChange={setBasemap} />
      <div ref={divRef} style={{ height: '100%' }} />
    </div>
  );
}

// ── Tracked planes — add/remove/toggle which registrations OpenSky is polled for ─────────
function TrackedPlanesPanel({ aircraft }) {
  const { user } = useAuth();
  const [tracked, setTracked] = useState([]);
  const [open, setOpen] = useState(false);
  const [reg, setReg] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => { fetchTrackedAircraft().then(setTracked).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  // Guests (no user.id) get a read-only list; anyone with a real account can add their
  // own, and admins/editors can manage every row (including the seeded defaults).
  const canManage = (row) => !!user && (user.role === 'admin' || user.role === 'editor' || (user.id != null && row.added_by_user_id === user.id));
  const canAdd = !!user && user.id != null;

  const handleAdd = async (e) => {
    e.preventDefault();
    const registration = reg.trim();
    if (!registration) return;
    setBusy(true); setMsg(null);
    try {
      const res = await addTrackedAircraft(registration);
      setReg('');
      load();
      setMsg(res.lookupFailed
        ? { type: 'warn', text: `${registration} dodano, a podatkov o letalu ni bilo mogoče najti — sledenje morda ne bo delovalo.` }
        : { type: 'ok', text: `${registration} dodano.` });
    } catch (err) {
      setMsg({ type: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (row) => {
    try { await setTrackedAircraftEnabled(row.id, !row.enabled); load(); } catch (err) { setMsg({ type: 'err', text: err.message }); }
  };

  const handleDelete = async (row) => {
    if (!confirm(`Odstranim ${row.registration} s seznama?`)) return;
    try { await deleteTrackedAircraft(row.id); load(); } catch (err) { setMsg({ type: 'err', text: err.message }); }
  };

  const liveById = new Map(aircraft.map(a => [a.id, a]));
  const msgColor = msg?.type === 'ok' ? 'var(--accent-green)' : msg?.type === 'warn' ? 'var(--accent-amber)' : 'var(--accent-red)';

  return (
    <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border)' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%', padding: '0.45rem 0.75rem',
        background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-2)', fontSize: '0.78rem', fontWeight: 600,
      }}>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        Sledena letala ({tracked.length})
      </button>
      {open && (
        <div style={{ padding: '0 0.75rem 0.75rem' }}>
          {msg && (
            <div style={{ padding: '0.35rem 0.6rem', borderRadius: '0.35rem', fontSize: '0.72rem', marginBottom: '0.5rem',
              color: msgColor, background: `color-mix(in srgb, ${msgColor} 10%, transparent)` }}>
              {msg.text}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.6rem' }}>
            {tracked.map(row => {
              const live = liveById.get(row.id);
              const color = live?.live && !live.onGround ? '#3fb950' : live?.live && live.onGround ? '#d29922' : '#8b949e';
              return (
                <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.78rem' }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, color: 'var(--text-1)', minWidth: '68px' }}>{row.registration}</span>
                  <span style={{ color: 'var(--text-3)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.aircraft_type || (!row.icao24 ? 'ni podatkov o letalu' : '')}
                    {row.added_by_username ? ` · dodal ${row.added_by_username}` : ''}
                  </span>
                  {canManage(row) && (
                    <>
                      <input type="checkbox" checked={!!row.enabled} onChange={() => handleToggle(row)}
                        title={row.enabled ? 'Onemogoči sledenje' : 'Omogoči sledenje'} style={{ cursor: 'pointer' }} />
                      <button onClick={() => handleDelete(row)} title="Odstrani" style={{
                        display: 'flex', alignItems: 'center', background: 'transparent', border: 'none',
                        color: 'var(--accent-red)', cursor: 'pointer', padding: '0.15rem' }}>
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
            {!tracked.length && <div style={{ color: 'var(--text-3)', fontSize: '0.78rem' }}>Ni sledenih letal.</div>}
          </div>
          {canAdd && (
            <form onSubmit={handleAdd} style={{ display: 'flex', gap: '0.4rem' }}>
              <input className="pm-input" value={reg} onChange={e => setReg(e.target.value)}
                placeholder="Registracija (npr. S5-ABC)" style={{ flex: 1, fontSize: '0.78rem' }} disabled={busy} />
              <button className="pm-btn pm-btn-primary" type="submit" disabled={busy || !reg.trim()}>
                <Plus size={13} /> Dodaj
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────
export default function AircraftView({ visible }) {
  const [data, setData] = useState({ aircraft: [], updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await getJson('/api/aircraft'));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      loadedOnce.current = true;
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, REFRESH_MS);
    return () => clearInterval(iv);
  }, [load]);

  if (!visible) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <StatusStrip aircraft={data.aircraft} />
      <TrackedPlanesPanel aircraft={data.aircraft} />
      {loading && !loadedOnce.current ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '0.6rem', color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
          <Loader size={20} style={{ animation: 'spin 0.8s linear infinite' }} />
          Nalaganje podatkov o letalih…
        </div>
      ) : error && !data.aircraft.length ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent-red)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
          Nalaganje podatkov o letalih ni uspelo: {error}
        </div>
      ) : (
        <AircraftMap aircraft={data.aircraft} visible={visible} updatedAt={data.updatedAt} />
      )}
    </div>
  );
}

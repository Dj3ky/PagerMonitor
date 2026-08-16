import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, X, Loader, Flame, Car, Wrench, Waves, Skull, Biohazard, MapPin, Filter, History } from 'lucide-react';
import { getJson, BASEMAPS, useBasemap, BasemapSwitcher, LastUpdated } from './weatherMapShared.jsx';

// Slovenia's national public-safety intervention feed (fires, traffic accidents,
// technical assistance, etc) — see backend/src/services/interventions.js for the
// source and polling details. Live view + filterable/searchable archive.
const REFRESH_MS = 60 * 1000;
const BASEMAP_STORAGE_KEY = 'pm_interventions_basemap';

function typeStyle(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('požar') || t.includes('eksplozij'))       return { color: '#ef4444', Icon: Flame,     label: 'Fire' };
  if (t.includes('prometna'))                                return { color: '#f97316', Icon: Car,       label: 'Traffic' };
  if (t.includes('vod'))                                     return { color: '#14b8a6', Icon: Waves,     label: 'Water' };
  if (t.includes('nevarn') || t.includes('onesnaž'))         return { color: '#a855f7', Icon: Biohazard, label: 'Hazmat' };
  if (t.includes('nus'))                                     return { color: '#eab308', Icon: Skull,     label: 'UXO' };
  if (t.includes('tehnič'))                                  return { color: '#0ea5e9', Icon: Wrench,    label: 'Technical' };
  return { color: '#8b949e', Icon: MapPin, label: 'Other' };
}

function fmtWhen(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return iso; }
}

function markerIcon(L, color) {
  return L.divIcon({
    className: '',
    html: `<div style="width:15px;height:15px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 6px ${color}"></div>`,
    iconSize: [15, 15], iconAnchor: [7, 7], popupAnchor: [0, -7],
  });
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function popupHtml(row) {
  const { color, label } = typeStyle(row.intervention_type);
  const where = row.address || row.municipality || 'Location unknown';
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.8rem;min-width:220px;max-width:300px;color:var(--text-1)">
      <div style="font-weight:700;color:${color}">${escHtml(row.event_type || label)}</div>
      <div style="color:var(--text-3);font-size:0.68rem;margin-top:0.15rem">${escHtml(where)}</div>
      ${row.description ? `<div style="margin-top:0.4rem;line-height:1.4">${escHtml(row.description)}</div>` : ''}
      ${row.occurred_at ? `<div style="color:var(--text-3);font-size:0.65rem;margin-top:0.4rem">${fmtWhen(row.occurred_at)}</div>` : ''}
    </div>`;
}

// ── Map ──────────────────────────────────────────────────────────────────────
function InterventionsMap({ rows, visible, updatedAt, flyTo }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const tileLayerRef = useRef(null);
  const [basemap, setBasemap] = useBasemap(BASEMAP_STORAGE_KEY, 'dark');

  useEffect(() => {
    if (mapRef.current || !divRef.current || !window.L) return;
    const map = window.L.map(divRef.current, { center: [46.12, 14.80], zoom: 8 }); // Slovenia
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; tileLayerRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const style = BASEMAPS[basemap] || BASEMAPS.dark;
    if (tileLayerRef.current) map.removeLayer(tileLayerRef.current);
    tileLayerRef.current = window.L.tileLayer(style.url, { attribution: style.attr, maxZoom: 19, detectRetina: true }).addTo(map);
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
    markersRef.current = new Map();
    rows.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng)).forEach(r => {
      const { color } = typeStyle(r.intervention_type);
      const marker = L.marker([r.lat, r.lng], { icon: markerIcon(L, color) }).addTo(map);
      marker.bindPopup(popupHtml(r), { maxWidth: 320 });
      markersRef.current.set(r.id, marker);
    });
  }, [rows]);

  useEffect(() => {
    if (!flyTo) return;
    const map = mapRef.current;
    const marker = markersRef.current.get(flyTo);
    if (!map || !marker) return;
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 12), { duration: 0.6 });
    marker.openPopup();
  }, [flyTo]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <LastUpdated updatedAt={updatedAt} />
      <BasemapSwitcher basemap={basemap} onChange={setBasemap} />
      <div ref={divRef} style={{ height: '100%' }} />
    </div>
  );
}

// ── Filter toolbar ───────────────────────────────────────────────────────────
function Toolbar({ filters, setFilters, municipalities, types, archiveMode, setArchiveMode }) {
  const [qInput, setQInput] = useState(filters.q);
  useEffect(() => {
    const t = setTimeout(() => setFilters(f => ({ ...f, q: qInput })), 350);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const selStyle = {
    padding: '0.3rem 0.5rem', borderRadius: '0.4rem', fontSize: '0.78rem',
    background: 'var(--bg-3)', border: '1px solid var(--border)', color: 'var(--text-2)',
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
      padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)', flexShrink: 0,
    }}>
      <div style={{ position: 'relative', flex: '1 1 180px', minWidth: '140px' }}>
        <Search size={13} style={{ position: 'absolute', left: '0.5rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
        <input value={qInput} onChange={e => setQInput(e.target.value)} placeholder="Search description, place…"
          style={{ ...selStyle, width: '100%', paddingLeft: '1.7rem', boxSizing: 'border-box' }} />
        {qInput && (
          <button onClick={() => setQInput('')} title="Clear" style={{
            position: 'absolute', right: '0.35rem', top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', display: 'flex' }}>
            <X size={13} />
          </button>
        )}
      </div>

      <select value={filters.municipality} onChange={e => setFilters(f => ({ ...f, municipality: e.target.value }))} style={selStyle}>
        <option value="">All municipalities</option>
        {municipalities.map(m => <option key={m} value={m}>{m}</option>)}
      </select>

      <select value={filters.type} onChange={e => setFilters(f => ({ ...f, type: e.target.value }))} style={selStyle}>
        <option value="">All types</option>
        {types.map(t => <option key={t} value={t}>{t}</option>)}
      </select>

      <button onClick={() => setArchiveMode(v => !v)} title="Search full history instead of the recent live feed" style={{
        display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.6rem', borderRadius: '0.4rem',
        fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
        border: archiveMode ? '1px solid color-mix(in srgb, var(--accent-blue) 35%, transparent)' : '1px solid var(--border)',
        background: archiveMode ? 'color-mix(in srgb, var(--accent-blue) 12%, transparent)' : 'var(--bg-3)',
        color: archiveMode ? 'var(--accent-blue)' : 'var(--text-2)',
      }}>
        <History size={13} /> Archive
      </button>

      {archiveMode && (
        <>
          <input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} style={selStyle} />
          <span style={{ color: 'var(--text-3)', fontSize: '0.75rem' }}>–</span>
          <input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} style={selStyle} />
        </>
      )}

      {(filters.q || filters.municipality || filters.type || filters.from || filters.to) && (
        <button onClick={() => { setQInput(''); setFilters({ q: '', municipality: '', type: '', from: '', to: '' }); }}
          title="Clear all filters" style={{
            display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.5rem', borderRadius: '0.4rem',
            fontSize: '0.75rem', color: 'var(--text-3)', background: 'none', border: '1px solid var(--border)', cursor: 'pointer' }}>
          <Filter size={12} /> Reset
        </button>
      )}
    </div>
  );
}

// ── Result list ──────────────────────────────────────────────────────────────
function ResultList({ rows, selected, onSelect }) {
  if (!rows.length) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-3)', fontSize: '0.8rem', textAlign: 'center', padding: '1rem' }}>
        No interventions match these filters.
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {rows.map(r => {
        const { color, Icon, label } = typeStyle(r.intervention_type);
        const active = r.id === selected;
        return (
          <button key={r.id} onClick={() => onSelect(r.id)} style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '0.55rem 0.75rem',
            borderBottom: '1px solid var(--border-soft)', cursor: 'pointer',
            background: active ? 'color-mix(in srgb, var(--accent-green) 10%, transparent)' : 'transparent',
            borderLeft: active ? '3px solid var(--accent-green)' : '3px solid transparent',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Icon size={13} style={{ color, flexShrink: 0 }} />
              <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-1)' }}>
                {r.event_type || label}
              </span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginTop: '0.15rem' }}>
              {r.address || r.municipality || '—'} · {fmtWhen(r.occurred_at || r.reported_at)}
            </div>
            {r.description && (
              <div style={{ fontSize: '0.74rem', color: 'var(--text-2)', marginTop: '0.3rem', lineHeight: 1.4,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {r.description}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────
export default function InterventionsView({ visible }) {
  const [rows, setRows]           = useState([]);
  const [municipalities, setMunicipalities] = useState([]);
  const [types, setTypes]         = useState([]);
  const [filters, setFilters]     = useState({ q: '', municipality: '', type: '', from: '', to: '' });
  const [archiveMode, setArchiveMode] = useState(false);
  const [selected, setSelected]   = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const loadedOnce = useRef(false);

  const activeFilters = filters.q || filters.municipality || filters.type || filters.from || filters.to;

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: archiveMode ? '200' : '100' });
      if (filters.q)            params.set('q', filters.q);
      if (filters.municipality) params.set('municipality', filters.municipality);
      if (filters.type)         params.set('type', filters.type);
      if (archiveMode && filters.from) params.set('from', filters.from);
      if (archiveMode && filters.to)   params.set('to', filters.to + 'T23:59:59');
      const data = await getJson(`/api/interventions?${params}`);
      setRows(data);
      setUpdatedAt(new Date().toISOString());
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); loadedOnce.current = true; }
  }, [filters, archiveMode]);

  useEffect(() => {
    load();
    if (archiveMode) return; // archive browsing doesn't auto-refresh out from under you
    const iv = setInterval(load, REFRESH_MS);
    return () => clearInterval(iv);
  }, [load, archiveMode]);

  useEffect(() => {
    getJson('/api/interventions/municipalities').then(setMunicipalities).catch(() => {});
    getJson('/api/interventions/types').then(setTypes).catch(() => {});
  }, []);

  const mapRows = useMemo(() => rows.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng)), [rows]);

  if (!visible) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Toolbar filters={filters} setFilters={setFilters} municipalities={municipalities} types={types}
        archiveMode={archiveMode} setArchiveMode={setArchiveMode} />
      {loading && !loadedOnce.current ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '0.6rem', color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
          <Loader size={20} style={{ animation: 'spin 0.8s linear infinite' }} />
          Loading interventions…
        </div>
      ) : error && !rows.length ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent-red)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
          Failed to load interventions: {error}
        </div>
      ) : (
        <div className="pm-interventions-body" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <InterventionsMap rows={mapRows} visible={visible} updatedAt={updatedAt} flyTo={selected} />
          <div className="pm-interventions-list" style={{
            width: '340px', flexShrink: 0, borderLeft: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', minHeight: 0 }}>
            <div style={{ padding: '0.5rem 0.75rem', fontSize: '0.72rem', color: 'var(--text-3)',
              borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
              {rows.length} {archiveMode ? 'archived' : 'recent'} {rows.length === 1 ? 'result' : 'results'}
              {activeFilters ? ' (filtered)' : ''}
            </div>
            <ResultList rows={rows} selected={selected} onSelect={setSelected} />
          </div>
        </div>
      )}
      <style>{`
        @media (max-width: 720px) {
          .pm-interventions-body { flex-direction: column; }
          .pm-interventions-list { width: 100%; border-left: none; border-top: 1px solid var(--border); max-height: 45%; }
        }
      `}</style>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Search, X, Loader, Flame, Car, Wrench, Waves, Skull, Biohazard, MapPin, Filter, History, BarChart2, Ungroup, ChevronLeft, ChevronRight } from 'lucide-react';
import { getJson, BASEMAPS, useBasemap, BasemapSwitcher, LastUpdated } from './weatherMapShared.jsx';

// Slovenia's national public-safety intervention feed (fires, traffic accidents,
// technical assistance, etc) — see backend/src/services/interventions.js for the
// source and polling details. Live view + filterable/searchable archive.
const REFRESH_MS = 60 * 1000;
const LIVE_WINDOW_HOURS = 48; // "Live" = last N hours, not just "most recent N rows" — anything
                                // older is only reachable via Archive, even if the feed's been quiet.
                                // Applies uniformly to confirmed and unconfirmed events alike.
const BASEMAP_STORAGE_KEY = 'pm_interventions_basemap';
const CLUSTER_STORAGE_KEY = 'pm_interventions_clustered';
const LIVE_MAX_ROWS = 400; // backend's hard cap (see query() in interventions.js) — comfortably
                             // above normal volume across the 48h LIVE_WINDOW_HOURS, even on a
                             // busy storm stretch.

// Icon + Slovenian label per intervention type — color no longer comes from here,
// it's driven by tierColor() instead (time elapsed / confirmed state).
function typeStyle(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('požar') || t.includes('eksplozij'))       return { Icon: Flame,     label: 'Požar' };
  if (t.includes('prometna'))                                return { Icon: Car,       label: 'Prometna nesreča' };
  if (t.includes('vod'))                                     return { Icon: Waves,     label: 'Nesreče na vodi' };
  if (t.includes('nevarn') || t.includes('onesnaž'))         return { Icon: Biohazard, label: 'Nevarne snovi' };
  if (t.includes('nus'))                                     return { Icon: Skull,     label: 'Najdbe NUS' };
  if (t.includes('tehnič'))                                  return { Icon: Wrench,    label: 'Tehnična pomoč' };
  return { Icon: MapPin, label: 'Drugo' };
}

const TYPE_LEGEND = [
  { Icon: Flame,     label: 'Požar' },
  { Icon: Car,       label: 'Prometna nesreča' },
  { Icon: Waves,     label: 'Nesreče na vodi' },
  { Icon: Biohazard, label: 'Nevarne snovi' },
  { Icon: Skull,     label: 'Najdbe NUS' },
  { Icon: Wrench,    label: 'Tehnična pomoč' },
  { Icon: MapPin,    label: 'Drugo' },
];

// Time-since-report tiers for confirmed (closed) events, fading from red (freshest)
// to gray (oldest still-live, out to LIVE_WINDOW_HOURS) — plus the special "still in
// progress" state for anything not yet confirmed, which sits outside this aging scale
// entirely (see tierColor()'s comment for why that's a separate axis, not a 5th step).
const TIME_LEGEND = [
  { color: '#ef4444', label: 'do 3 ure' },
  { color: '#f97316', label: 'do 6 ur' },
  { color: '#eab308', label: 'do 12 ur' },
  { color: '#6b7280', label: 'do 48 ur' },
  { color: '#3b82f6', label: 'dogodki v teku' },
];

// description_pending tracks whether SPIN has published the full narrative for
// this event yet — empirically, that's the same signal SPIN's own map uses for
// "confirmed" (an event with no narrative is always still in progress). Still
// pending → blue, and deliberately outside the red-to-gray aging scale below rather
// than treated as "0 hours old": it answers a different question (has this even been
// confirmed at all) than the aging tiers do (how stale is this since it was reported),
// and folding it into the gradient would misleadingly suggest it's "fresh" rather than
// "status unknown." Once narrative arrives, color fades from red through gray with
// time since report, out to LIVE_WINDOW_HOURS (older rows are excluded server-side).
function tierColor(row) {
  if (row.description_pending) return '#3b82f6';
  const hrs = (Date.now() - new Date(row.reported_at).getTime()) / 3600000;
  if (hrs <= 3) return '#ef4444';
  if (hrs <= 6) return '#f97316';
  if (hrs <= 12) return '#eab308';
  return '#6b7280';
}

function Legend() {
  const sectionStyle = { display: 'flex', flexDirection: 'column', gap: '0.25rem' };
  const rowStyle = { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.68rem', color: 'var(--text-2)' };
  return (
    <div style={{
      position: 'absolute', bottom: '0.5rem', right: '0.5rem', zIndex: 1000,
      padding: '0.4rem 0.55rem', borderRadius: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.45rem',
      background: 'var(--bg-1)', border: '1px solid var(--border)', boxShadow: '0 1px 6px rgba(0,0,0,0.3)',
    }}>
      <div style={sectionStyle}>
        {TYPE_LEGEND.map(({ Icon, label }) => (
          <div key={label} style={rowStyle}>
            <Icon size={11} style={{ color: 'var(--text-3)', flexShrink: 0 }} /> {label}
          </div>
        ))}
      </div>
      <div style={{ ...sectionStyle, borderTop: '1px solid var(--border-soft)', paddingTop: '0.4rem' }}>
        {TIME_LEGEND.map(({ color, label }) => (
          <div key={label} style={rowStyle}>
            <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: color, flexShrink: 0 }} /> {label}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtWhen(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return iso; }
}

function markerIcon(L, color, Icon) {
  const glyph = renderToStaticMarkup(<Icon size={17} color="#fff" strokeWidth={2.5} />);
  return L.divIcon({
    className: '',
    html: `<div style="width:28px;height:28px;border-radius:50%;background:${color};border:2px solid #fff;
      box-shadow:0 0 7px ${color};display:flex;align-items:center;justify-content:center">${glyph}</div>`,
    iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14],
  });
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function popupHtml(row) {
  const color = tierColor(row);
  const where = row.address || row.municipality || 'Neznana lokacija';
  const pendingBadge = row.description_pending
    ? `<span style="font-size:0.6rem;font-weight:600;padding:0.05rem 0.4rem;border-radius:1rem;margin-left:0.4rem;color:#d29922;background:rgba(210,153,34,0.15)">NEZAKLJUČENO</span>`
    : '';
  // Always the real Slovenian source text (event_type, then intervention_type) —
  // typeStyle's own label is only an internal English tag for keyword-matching,
  // never meant to be shown.
  const title = row.event_type || row.intervention_type || 'Neznano';
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.8rem;min-width:220px;max-width:300px;color:var(--text-1)">
      <div style="font-weight:700;color:${color}">${escHtml(title)}${pendingBadge}</div>
      <div style="color:var(--text-3);font-size:0.68rem;margin-top:0.15rem">${escHtml(where)}</div>
      ${row.description ? `<div style="margin-top:0.4rem;line-height:1.4">${escHtml(row.description)}</div>`
        : row.description_pending ? `<div style="margin-top:0.4rem;font-style:italic;color:var(--text-3)">Čakanje na podrobnosti…</div>` : ''}
      ${row.occurred_at ? `<div style="color:var(--text-3);font-size:0.65rem;margin-top:0.4rem">${fmtWhen(row.occurred_at)}</div>` : ''}
    </div>`;
}

// "Večji obseg" (major-scope) municipality overlay — a separate SPIN data type from
// the point interventions above (see backend/src/services/vecjiObseg.js). Messages are
// already sorted newest-first by the backend.
function obsegPopupHtml(area) {
  const msgs = (area.messages || []).map(m => `
    <div style="margin-top:0.4rem">
      <div style="color:var(--text-3);font-size:0.65rem">${fmtWhen(m.messageAt)}</div>
      <div style="margin-top:0.15rem;line-height:1.4">${escHtml(m.besedilo || '')}</div>
    </div>`).join('');
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:0.8rem;min-width:220px;max-width:320px;color:var(--text-1)">
      <div style="font-weight:700;color:#a855f7">Večji obseg</div>
      <div style="color:var(--text-3);font-size:0.72rem;margin-top:0.1rem">${escHtml(area.obcinaNaziv || '')}</div>
      ${msgs}
    </div>`;
}

// ── Map ──────────────────────────────────────────────────────────────────────
function InterventionsMap({ rows, visible, updatedAt, flyTo, onSelect }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const clusterRef = useRef(null); // L.markerClusterGroup — keeps dense areas (Ljubljana etc) readable
  const markersRef = useRef(new Map());
  const activeLayerRef = useRef(null); // whichever layer (cluster group or plain map) markers currently live on
  const tileLayerRef = useRef(null);
  const obsegLayerRef = useRef(null); // L.layerGroup for the "Večji obseg" municipality overlay
  const [basemap, setBasemap] = useBasemap(BASEMAP_STORAGE_KEY, 'streets');
  const [clustered, setClustered] = useState(() => localStorage.getItem(CLUSTER_STORAGE_KEY) !== '0');
  const [obsegAreas, setObsegAreas] = useState([]);

  useEffect(() => {
    if (mapRef.current || !divRef.current || !window.L) return;
    const L   = window.L;
    // maxZoom set here explicitly, not just via the tile layer — the tile layer is
    // added in a separate effect below (keyed on basemap), and markerClusterGroup
    // needs a resolvable max zoom on the map itself before that runs, or it throws
    // "Map has no maxZoom specified".
    const map = L.map(divRef.current, { center: [46.12, 14.80], zoom: 8, maxZoom: 19 }); // Slovenia
    if (L.markerClusterGroup) {
      clusterRef.current = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45 });
      if (clustered) map.addLayer(clusterRef.current);
    }
    // Its own plain layer group (not clustered — these are areas, not points), added once;
    // markers render above it automatically since Leaflet's default markerPane sits above
    // the overlayPane vector layers like polygons use.
    obsegLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // markersRef must be cleared here too — under StrictMode's dev-mode double-invoke
    // (mount → cleanup → mount again), leaving stale marker objects around after the
    // map/cluster group they belonged to gets destroyed means the next markers-effect
    // run tries to removeLayer() them from a *new* cluster group that never had them,
    // which throws inside Leaflet.markercluster's internal bookkeeping.
    return () => { map.remove(); mapRef.current = null; tileLayerRef.current = null; clusterRef.current = null; markersRef.current = new Map(); activeLayerRef.current = null; obsegLayerRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Toggle the cluster group's attachment to the map — separate from the marker-rebuild
  // effect below so flipping the switch doesn't need to wait on a rows change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !clusterRef.current) return;
    const onMap = map.hasLayer(clusterRef.current);
    if (clustered && !onMap) map.addLayer(clusterRef.current);
    if (!clustered && onMap) map.removeLayer(clusterRef.current);
    localStorage.setItem(CLUSTER_STORAGE_KEY, clustered ? '1' : '0');
  }, [clustered]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;
    const useCluster = clustered && !!clusterRef.current;
    const targetLayer = useCluster ? clusterRef.current : map;
    // Remove existing markers from whichever layer they were actually added to —
    // removing them from the wrong layer type throws inside Leaflet.markercluster's
    // internal bookkeeping (see the mount-effect comment above for the same gotcha).
    const prevLayer = activeLayerRef.current;
    if (prevLayer) markersRef.current.forEach(m => prevLayer.removeLayer(m));
    markersRef.current = new Map();
    rows.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng)).forEach(r => {
      const { Icon } = typeStyle(r.intervention_type);
      const marker = L.marker([r.lat, r.lng], { icon: markerIcon(L, tierColor(r), Icon) });
      marker.bindPopup(popupHtml(r), { maxWidth: 320 });
      marker.on('click', () => onSelect?.(r.id)); // keep the list panel in sync with the map, not just the reverse
      targetLayer.addLayer ? targetLayer.addLayer(marker) : marker.addTo(map);
      markersRef.current.set(r.id, marker);
    });
    activeLayerRef.current = targetLayer;
  }, [rows, clustered]);

  useEffect(() => {
    if (!flyTo) return;
    const map = mapRef.current;
    const marker = markersRef.current.get(flyTo);
    if (!map || !marker) return;
    // Inside a collapsed cluster — zoomToShowLayer spiders/zooms until it's visible,
    // then the callback opens its popup. Without clustering, just fly straight to it.
    if (clustered && clusterRef.current) {
      clusterRef.current.zoomToShowLayer(marker, () => marker.openPopup());
    } else {
      map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 12), { duration: 0.6 });
      marker.openPopup();
    }
  }, [flyTo, clustered]);

  // "Večji obseg" overlay — independent of the point-intervention list/filters above,
  // so it's fetched on its own timer here rather than threaded through the parent's
  // filter-driven `load()`.
  useEffect(() => {
    let cancelled = false;
    const loadObseg = () => getJson('/api/interventions/vecji-obseg')
      .then(d => { if (!cancelled) setObsegAreas(d); }).catch(() => {});
    loadObseg();
    const iv = setInterval(loadObseg, REFRESH_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L || !obsegLayerRef.current) return;
    const L = window.L;
    obsegLayerRef.current.clearLayers();
    obsegAreas.forEach(area => {
      (area.boundary || []).forEach(polygonRings => {
        const poly = L.polygon(polygonRings, { color: 'rgba(168,85,247,0.9)', weight: 2, fillColor: '#a855f7', fillOpacity: 0.12 });
        poly.bindPopup(obsegPopupHtml(area), { maxWidth: 320 });
        obsegLayerRef.current.addLayer(poly);
      });
    });
  }, [obsegAreas]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <LastUpdated updatedAt={updatedAt} />
      <BasemapSwitcher basemap={basemap} onChange={setBasemap} />
      <button onClick={() => setClustered(v => !v)} title={clustered ? 'Onemogoči združevanje bližnjih dogodkov' : 'Omogoči združevanje bližnjih dogodkov'}
        style={{
          position: 'absolute', top: '2.6rem', right: '0.5rem', zIndex: 1000,
          display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.5rem', borderRadius: '0.5rem',
          fontSize: '0.68rem', fontWeight: 500, cursor: 'pointer', background: 'var(--bg-1)',
          border: clustered ? '1px solid var(--accent-green)' : '1px solid var(--border)',
          color: clustered ? 'var(--accent-green)' : 'var(--text-2)', boxShadow: '0 1px 6px rgba(0,0,0,0.3)',
        }}>
        <Ungroup size={12} /> Združevanje
      </button>
      <Legend />
      <div ref={divRef} style={{ height: '100%' }} />
    </div>
  );
}

// ── Statistics popup ─────────────────────────────────────────────────────────
function StatBar({ label, value, max, color }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.22rem' }}>
      <div style={{ width: '90px', fontSize: '0.68rem', color: 'var(--text-3)', flexShrink: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</div>
      <div style={{ flex: 1, height: '13px', background: 'var(--bg-3)', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '3px', transition: 'width 0.3s' }} />
      </div>
      <div style={{ width: '32px', fontSize: '0.7rem', color: 'var(--text-2)', flexShrink: 0, textAlign: 'right' }}>{value}</div>
    </div>
  );
}

const STATS_DAYS = 30;

function StatsModal({ onClose }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getJson(`/api/interventions/stats?days=${STATS_DAYS}`).then(setStats).catch(e => setError(e.message));
  }, []);

  // The backend only returns days that had at least one event — backfill the rest as
  // zero here so a quiet day shows as an empty bar instead of silently disappearing
  // from the list (which would make the 30-day window look shorter/uneven than it is).
  const dailyFilled = useMemo(() => {
    const counts = new Map((stats?.daily || []).map(r => [r.day, r.n]));
    const out = [];
    for (let i = STATS_DAYS - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      out.push({ day, n: counts.get(day) || 0 });
    }
    return out;
  }, [stats]);
  const maxDaily = Math.max(...dailyFilled.map(r => r.n), 1);

  // The backend groups by the raw SPIN intervention_type string, but several distinct
  // raw values can all fall into typeStyle()'s "Drugo" catch-all (or any other bucket) —
  // re-group here by the same classified label so those don't show as duplicate bars.
  const byTypeGrouped = useMemo(() => {
    const totals = new Map();
    for (const r of stats?.byType || []) {
      const label = typeStyle(r.intervention_type).label;
      totals.set(label, (totals.get(label) || 0) + r.n);
    }
    return [...totals.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
  }, [stats]);
  const maxType = Math.max(...byTypeGrouped.map(r => r.n), 1);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'rgba(0,0,0,0.5)' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ width: 'min(640px,94vw)', maxHeight: '84vh', overflowY: 'auto', background: 'var(--bg-1)',
        border: '1px solid var(--border)', borderRadius: '0.75rem', boxShadow: '0 4px 24px rgba(0,0,0,0.4)', padding: '1.5rem 1.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.3rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)' }}>
            <BarChart2 size={18} style={{ color: 'var(--accent-blue)' }} /> Statistika dogodkov
          </div>
          <button onClick={onClose} title="Zapri" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', display: 'flex' }}>
            <X size={18} />
          </button>
        </div>

        {error ? (
          <div style={{ color: 'var(--accent-red)', fontSize: '0.8rem' }}>Napaka pri nalaganju statistike: {error}</div>
        ) : !stats ? (
          <div style={{ color: 'var(--text-3)', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Loader size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> Nalaganje…
          </div>
        ) : (
          <>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: '0.6rem' }}>
              Dogodkov na dan — zadnjih {STATS_DAYS} dni
            </div>
            <div style={{ marginBottom: '1.6rem' }}>
              {dailyFilled.map(r => (
                <StatBar key={r.day} label={new Date(r.day + 'T12:00:00').toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit' })}
                  value={r.n} max={maxDaily} color="var(--accent-blue)" />
              ))}
            </div>

            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: '0.6rem' }}>
              Po vrsti dogodka — zadnjih {STATS_DAYS} dni
            </div>
            <div>
              {byTypeGrouped.length === 0
                ? <div style={{ color: 'var(--text-3)', fontSize: '0.75rem' }}>Ni podatkov</div>
                : byTypeGrouped.map(r => (
                  <StatBar key={r.label} label={r.label} value={r.n} max={maxType} color="var(--accent-green)" />
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Filter toolbar ───────────────────────────────────────────────────────────
function Toolbar({ filters, setFilters, municipalities, types, archiveMode, setArchiveMode,
  archiveDataType, setArchiveDataType, onShowStats }) {
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
        <input value={qInput} onChange={e => setQInput(e.target.value)} placeholder="Iskanje po opisu, kraju…"
          style={{ ...selStyle, width: '100%', paddingLeft: '1.7rem', boxSizing: 'border-box' }} />
        {qInput && (
          <button onClick={() => setQInput('')} title="Počisti" style={{
            position: 'absolute', right: '0.35rem', top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', display: 'flex' }}>
            <X size={13} />
          </button>
        )}
      </div>

      <select value={filters.municipality} onChange={e => setFilters(f => ({ ...f, municipality: e.target.value }))} style={selStyle}>
        <option value="">Vse občine</option>
        {municipalities.map(m => <option key={m} value={m}>{m}</option>)}
      </select>

      {archiveDataType !== 'obseg' && (
        <select value={filters.type} onChange={e => setFilters(f => ({ ...f, type: e.target.value }))} style={selStyle}>
          <option value="">Vse vrste</option>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      )}

      <button onClick={() => setArchiveMode(v => !v)} title="Preišči celotno zgodovino namesto zadnjih dogodkov" style={{
        display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.6rem', borderRadius: '0.4rem',
        fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
        border: archiveMode ? '1px solid color-mix(in srgb, var(--accent-blue) 35%, transparent)' : '1px solid var(--border)',
        background: archiveMode ? 'color-mix(in srgb, var(--accent-blue) 12%, transparent)' : 'var(--bg-3)',
        color: archiveMode ? 'var(--accent-blue)' : 'var(--text-2)',
      }}>
        <History size={13} /> Arhiv
      </button>

      <button onClick={onShowStats} title="Prikaži statistiko dogodkov" style={{
        display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.6rem', borderRadius: '0.4rem',
        fontSize: '0.78rem', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
        border: '1px solid var(--border)', background: 'var(--bg-3)', color: 'var(--text-2)',
      }}>
        <BarChart2 size={13} /> Statistika
      </button>

      {archiveMode && (
        <>
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: '0.4rem', overflow: 'hidden' }}>
            {[['dogodki', 'Dogodki'], ['obseg', 'Večji obseg']].map(([id, label]) => (
              <button key={id} onClick={() => setArchiveDataType(id)} style={{
                padding: '0.3rem 0.55rem', fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer', border: 'none',
                background: archiveDataType === id ? 'color-mix(in srgb, var(--accent-blue) 12%, transparent)' : 'var(--bg-3)',
                color: archiveDataType === id ? 'var(--accent-blue)' : 'var(--text-2)',
              }}>{label}</button>
            ))}
          </div>
          <input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} style={selStyle} />
          <span style={{ color: 'var(--text-3)', fontSize: '0.75rem' }}>–</span>
          <input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} style={selStyle} />
        </>
      )}

      {(filters.q || filters.municipality || filters.type || filters.from || filters.to) && (
        <button onClick={() => { setQInput(''); setFilters({ q: '', municipality: '', type: '', from: '', to: '' }); }}
          title="Počisti vse filtre" style={{
            display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.5rem', borderRadius: '0.4rem',
            fontSize: '0.75rem', color: 'var(--text-3)', background: 'none', border: '1px solid var(--border)', cursor: 'pointer' }}>
          <Filter size={12} /> Počisti
        </button>
      )}
    </div>
  );
}

// ── Result list ──────────────────────────────────────────────────────────────
function ResultList({ rows, selected, onSelect }) {
  const rowRefs = useRef(new Map());

  // Keeps the list in sync when selection comes from the map side (marker click),
  // not just the reverse — scrolls the matching row into view if it's off-screen.
  useEffect(() => {
    if (selected == null) return;
    rowRefs.current.get(selected)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  if (!rows.length) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-3)', fontSize: '0.8rem', textAlign: 'center', padding: '1rem' }}>
        Noben dogodek ne ustreza tem filtrom.
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {rows.map(r => {
        const { Icon } = typeStyle(r.intervention_type);
        const color = tierColor(r);
        const active = r.id === selected;
        // Always the real Slovenian source text — never typeStyle's internal English tag.
        const title = r.event_type || r.intervention_type || 'Neznano';
        return (
          <button key={r.id} ref={el => { if (el) rowRefs.current.set(r.id, el); else rowRefs.current.delete(r.id); }}
            onClick={() => onSelect(r.id)} style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '0.55rem 0.75rem',
            borderBottom: '1px solid var(--border-soft)', cursor: 'pointer',
            background: active ? 'color-mix(in srgb, var(--accent-green) 10%, transparent)' : 'transparent',
            borderLeft: active ? '3px solid var(--accent-green)' : '3px solid transparent',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Icon size={13} style={{ color, flexShrink: 0 }} />
              <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-1)' }}>
                {title}
              </span>
              {!!r.description_pending && (
                <span title="Celotno besedilo še ni objavljeno — preverjamo periodično" style={{
                  fontSize: '0.62rem', fontWeight: 600, padding: '0.05rem 0.4rem', borderRadius: '1rem',
                  color: 'var(--accent-amber, #d29922)',
                  background: 'color-mix(in srgb, var(--accent-amber, #d29922) 15%, transparent)' }}>
                  NEZAKLJUČENO
                </span>
              )}
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginTop: '0.15rem' }}>
              {r.address || r.municipality || '—'} · {fmtWhen(r.occurred_at || r.reported_at)}
            </div>
            {r.description ? (
              <div style={{ fontSize: '0.74rem', color: 'var(--text-2)', marginTop: '0.3rem', lineHeight: 1.4,
                display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {r.description}
              </div>
            ) : r.description_pending ? (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', fontStyle: 'italic', marginTop: '0.3rem' }}>
                Čakanje na podrobnosti…
              </div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ── Večji obseg archive list ───────────────────────────────────────────────────
// Self-contained, unlike ResultList — it has its own fetch/pagination since it's a
// different data shape (municipality + free text, no lat/lng point) rather than
// something that plugs into the point-intervention rows/map/selection machinery above.
const OBSEG_PAGE_SIZE = 50;

function ObsegHistoryList({ filters }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (append = false) => {
    append ? setLoadingMore(true) : setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(OBSEG_PAGE_SIZE), offset: append ? String(rows.length) : '0' });
      if (filters.q)            params.set('q', filters.q);
      if (filters.municipality) params.set('municipality', filters.municipality);
      if (filters.from)         params.set('from', filters.from);
      if (filters.to)           params.set('to', filters.to + 'T23:59:59');
      const { rows: page, total: n } = await getJson(`/api/interventions/vecji-obseg/history?${params}`);
      setRows(prev => append ? [...prev, ...page] : page);
      setTotal(n);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); setLoadingMore(false); }
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(false); }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '0.6rem', color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
        <Loader size={20} style={{ animation: 'spin 0.8s linear infinite' }} /> Nalaganje…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--accent-red)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
        Napaka pri nalaganju: {error}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ padding: '0.5rem 0.75rem', fontSize: '0.72rem', color: 'var(--text-3)',
        borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
        Prikazanih {rows.length} od {total} rezultatov (večji obseg)
      </div>
      {!rows.length ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-3)', fontSize: '0.8rem', textAlign: 'center', padding: '1rem' }}>
          Noben dogodek ne ustreza tem filtrom.
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {rows.map((r, i) => (
            <div key={`${r.obcina_mid}-${r.message_at}-${i}`} style={{
              padding: '0.55rem 0.75rem', borderBottom: '1px solid var(--border-soft)', maxWidth: '640px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#a855f7', flexShrink: 0 }} />
                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-1)' }}>{r.obcina_naziv}</span>
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginTop: '0.15rem' }}>{fmtWhen(r.message_at)}</div>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-2)', marginTop: '0.3rem', lineHeight: 1.4 }}>{r.besedilo}</div>
            </div>
          ))}
        </div>
      )}
      {rows.length < total && (
        <button onClick={() => load(true)} disabled={loadingMore} style={{
          flexShrink: 0, padding: '0.55rem', fontSize: '0.78rem', fontWeight: 500,
          color: 'var(--accent-blue)', background: 'var(--bg-3)', border: 'none',
          borderTop: '1px solid var(--border-soft)', cursor: loadingMore ? 'default' : 'pointer' }}>
          {loadingMore ? 'Nalaganje…' : `Naloži še ${Math.min(OBSEG_PAGE_SIZE, total - rows.length)}`}
        </button>
      )}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────
const PAGE_SIZE = 100;

export default function InterventionsView({ visible }) {
  const [rows, setRows]           = useState([]);
  const [total, setTotal]         = useState(0);
  const [municipalities, setMunicipalities] = useState([]);
  const [types, setTypes]         = useState([]);
  const [filters, setFilters]     = useState({ q: '', municipality: '', type: '', from: '', to: '' });
  const [archiveMode, setArchiveMode] = useState(false);
  const [archiveDataType, setArchiveDataType] = useState('dogodki'); // 'dogodki' | 'obseg' — only relevant while archiveMode
  const [showStats, setShowStats] = useState(false);
  const [selected, setSelected]   = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]         = useState(null);
  // Mobile only — desktop always shows the list as a fixed sidebar (see .pm-interventions-list-toggle).
  // Defaults closed so the map gets the full screen instead of being squeezed by a permanent
  // bottom panel, matching MapView.jsx's mobile sidebar-overlay pattern.
  const [listOpen, setListOpen]   = useState(false);
  const loadedOnce = useRef(false);

  // The map (and its Leaflet instance) fully unmounts/remounts each time this panel is
  // hidden/shown again (see the `if (!visible) return null` below) — but `selected` lives
  // here and would otherwise survive that, making the freshly remounted map replay its
  // fly-to-marker + open-popup effect as if you'd just clicked it. Clearing it on hide
  // means returning to the page always starts from a clean, unselected map.
  useEffect(() => { if (!visible) setSelected(null); }, [visible]);
  // Leaving Arhiv always resets back to the normal Dogodki view, so re-opening Arhiv
  // later doesn't silently land on the Večji obseg list from a previous session.
  useEffect(() => { if (!archiveMode) setArchiveDataType('dogodki'); }, [archiveMode]);

  const activeFilters = filters.q || filters.municipality || filters.type || filters.from || filters.to;

  // append=true adds a page onto the existing list (Load more); otherwise it's a
  // fresh search/refresh that replaces the list from offset 0.
  const load = useCallback(async (append = false) => {
    append ? setLoadingMore(true) : setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: append ? String(rows.length) : '0' });
      if (filters.q)            params.set('q', filters.q);
      if (filters.municipality) params.set('municipality', filters.municipality);
      if (filters.type)         params.set('type', filters.type);
      if (archiveMode) {
        if (filters.from) params.set('from', filters.from);
        if (filters.to)   params.set('to', filters.to + 'T23:59:59');
      } else {
        // Live = last LIVE_WINDOW_HOURS hours, not just "most recent N rows" — older
        // entries stay reachable only through Archive, even on a quiet feed. Applies
        // the same cutoff whether or not the event has been confirmed yet.
        params.set('from', new Date(Date.now() - LIVE_WINDOW_HOURS * 3600000).toISOString());
        // Live mode has no "load more" (it re-fetches from scratch every REFRESH_MS anyway),
        // so request the backend's actual max instead of the archive page size — a busy
        // 24h window (storms etc.) can otherwise silently lose events past PAGE_SIZE with
        // no way to reach them.
        params.set('limit', String(LIVE_MAX_ROWS));
      }
      const { rows: page, total: n } = await getJson(`/api/interventions?${params}`);
      setRows(prev => append ? [...prev, ...page] : page);
      setTotal(n);
      setUpdatedAt(new Date().toISOString());
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); setLoadingMore(false); loadedOnce.current = true; }
  }, [filters, archiveMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load(false);
    if (archiveMode) return; // archive browsing doesn't auto-refresh out from under you
    const iv = setInterval(() => load(false), REFRESH_MS);
    return () => clearInterval(iv);
  }, [filters, archiveMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    getJson('/api/interventions/municipalities').then(setMunicipalities).catch(() => {});
    getJson('/api/interventions/types').then(setTypes).catch(() => {});
  }, []);

  const mapRows = useMemo(() => rows.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng)), [rows]);

  if (!visible) return null;

  // Close the mobile list overlay on selection so the map's fly-to is actually visible —
  // otherwise the 85%-width overlay would keep covering it. No-op on desktop (list isn't
  // an overlay there).
  const handleSelectRow = (id) => {
    setSelected(id);
    if (window.innerWidth <= 720) setListOpen(false);
  };

  // Shared between the desktop fixed sidebar and the mobile overlay below.
  const listContent = (
    <>
      <div style={{ padding: '0.5rem 0.75rem', fontSize: '0.72rem', color: 'var(--text-3)',
        borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
        Prikazanih {rows.length} od {total} rezultatov {archiveMode ? '(arhiv)' : `(zadnjih ${LIVE_WINDOW_HOURS} ur)`}
        {activeFilters ? ' · filtrirano' : ''}
        {!archiveMode && ' — za starejše preklopi na Arhiv'}
      </div>
      <ResultList rows={rows} selected={selected} onSelect={handleSelectRow} />
      {archiveMode && rows.length < total && (
        <button onClick={() => load(true)} disabled={loadingMore} style={{
          flexShrink: 0, padding: '0.55rem', fontSize: '0.78rem', fontWeight: 500,
          color: 'var(--accent-blue)', background: 'var(--bg-3)', border: 'none',
          borderTop: '1px solid var(--border-soft)', cursor: loadingMore ? 'default' : 'pointer' }}>
          {loadingMore ? 'Nalaganje…' : `Naloži še ${Math.min(PAGE_SIZE, total - rows.length)}`}
        </button>
      )}
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Toolbar filters={filters} setFilters={setFilters} municipalities={municipalities} types={types}
        archiveMode={archiveMode} setArchiveMode={setArchiveMode}
        archiveDataType={archiveDataType} setArchiveDataType={setArchiveDataType}
        onShowStats={() => setShowStats(true)} />
      {showStats && <StatsModal onClose={() => setShowStats(false)} />}
      {archiveMode && archiveDataType === 'obseg' ? (
        <ObsegHistoryList filters={filters} />
      ) : loading && !loadedOnce.current ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: '0.6rem', color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.82rem' }}>
          <Loader size={20} style={{ animation: 'spin 0.8s linear infinite' }} />
          Nalaganje dogodkov…
        </div>
      ) : error && !rows.length ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--accent-red)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
          Napaka pri nalaganju dogodkov: {error}
        </div>
      ) : (
        <div className="pm-interventions-body" style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
          <InterventionsMap rows={mapRows} visible={visible} updatedAt={updatedAt} flyTo={selected} onSelect={setSelected} />

          {/* Desktop: fixed sidebar, always visible — hidden by CSS on mobile below */}
          <div className="pm-interventions-list-desktop" style={{
            width: '420px', flexShrink: 0, borderLeft: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', minHeight: 0 }}>
            {listContent}
          </div>

          {/* Mobile: toggle button overlaid on the map — mirrors MapView.jsx's sidebar toggle,
              so the map gets the full screen by default instead of a permanent bottom panel. */}
          <button className="pm-interventions-list-toggle" onClick={() => setListOpen(o => !o)}
            style={{ display:'none', position:'absolute', bottom:'0.6rem', left:'0.6rem', zIndex:1000,
              background:'var(--bg-1)', border:'1px solid var(--border)', borderRadius:'0.4rem',
              padding:'0.4rem 0.6rem', cursor:'pointer', color:'var(--text-1)',
              fontSize:'0.75rem', fontFamily:'monospace', boxShadow:'0 2px 8px rgba(0,0,0,0.3)',
              alignItems:'center', gap:'0.35rem' }}>
            {listOpen ? <ChevronRight size={14}/> : <ChevronLeft size={14}/>}
            {listOpen ? 'Skrij seznam' : `📋 ${rows.length}`}
          </button>

          {listOpen && (
            <div className="pm-interventions-list-mobile" style={{
              position:'absolute', top:0, left:0, bottom:0, width:'85%', maxWidth:'340px',
              zIndex:999, display:'flex', flexDirection:'column',
              background:'var(--bg-1)', borderRight:'1px solid var(--border)',
              boxShadow:'4px 0 16px rgba(0,0,0,0.4)' }}>
              {listContent}
            </div>
          )}
          {listOpen && (
            <div className="pm-interventions-list-backdrop" onClick={() => setListOpen(false)}
              style={{ position:'absolute', inset:0, zIndex:998, background:'rgba(0,0,0,0.3)' }} />
          )}
        </div>
      )}
      <style>{`
        @media (max-width: 720px) {
          .pm-interventions-list-desktop { display: none !important; }
          .pm-interventions-list-toggle  { display: flex !important; }
        }
      `}</style>
    </div>
  );
}

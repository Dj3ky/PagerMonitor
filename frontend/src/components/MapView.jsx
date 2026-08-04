import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, LocateFixed, Users, Loader } from 'lucide-react';
import { fetchMap, saveMessageLocation, clearMessageLocation, fetchUserLocations } from '../utils/api.js';
import { geocodeAddress, parseLocation } from '../utils/parseLocation.js';
import { useSite } from '../context/SiteContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { getCountryCenter } from '../utils/countryCenters.js';

const TILE_URL  = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

function fmtTime(ts, locale, hour12) {
  return new Date(ts).toLocaleString(locale, { hour12,
    day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function Badge({ label, color }) {
  if (!label) return null;
  return (
    <span style={{ fontSize:'0.65rem', fontWeight:600, padding:'0.1rem 0.4rem',
      borderRadius:'0.75rem', color, background:color+'22', border:`1px solid ${color}44`, whiteSpace:'nowrap' }}>
      {label}
    </span>
  );
}

function Flash({ msg }) {
  if (!msg) return null;
  return <div style={{ padding:'0.4rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.75rem', fontFamily:'monospace',
    color:'var(--accent-amber)', background:'color-mix(in srgb, var(--accent-amber) 10%, transparent)',
    border:'1px solid color-mix(in srgb, var(--accent-amber) 30%, transparent)',
    margin:'0.5rem 0.75rem' }}>{msg}</div>;
}

export default function MapView({ messages: liveMessages, flyToMsg, onFlyComplete, onLocationResolved, visible, resetKey, locationSharing }) {
  const { mapDotColor = '#00ff9d', mapMaxAgeDays = 30, geocodeCountry = 'si', locale, hour12 } = useSite();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const mapRef         = useRef(null);
  const mapDivRef      = useRef(null);
  const markersRef     = useRef({});        // id → L.marker (always created)
  const clusterRef     = useRef(null);      // L.markerClusterGroup
  const heatRef        = useRef(null);      // L.heatLayer
  const [mapMessages, setMapMessages] = useState([]);
  const [selected,    setSelected]    = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [geocoding,   setGeocoding]   = useState(false);
  const [total,       setTotal]       = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [layerMode,   setLayerMode]   = useState('markers'); // 'markers' | 'cluster' | 'heat'
  const [dateFrom,    setDateFrom]    = useState('');
  const [dateTo,      setDateTo]      = useState('');

  const [mapReady, setMapReady] = useState(false);
  const pendingFlyRef = useRef(null);

  // ── User live location sharing (driven by App-level hook) ─────────────────
  const geoState    = locationSharing?.state    ?? 'idle';
  const geoPosition = locationSharing?.position ?? null;
  const myMarkerRef = useRef(null);

  // ── Admin: show other users' locations ────────────────────────────────────
  const [showUsers,    setShowUsers]    = useState(false);
  const userMarkersRef = useRef({});
  const usersIntervalRef = useRef(null);
  // Ref so the visible top-up effect always reads current fetch params without stale closure
  const fetchParamsRef = useRef({ mapMaxAgeDays, dateFrom: '', dateTo: '' });

  // Init Leaflet map
  useEffect(() => {
    if (mapRef.current || !mapDivRef.current || !window.L) return;
    const L   = window.L;
    const { lat: cLat, lon: cLon, zoom: cZoom } = getCountryCenter(geocodeCountry);
    const map = L.map(mapDivRef.current, { center:[cLat, cLon], zoom:cZoom });
    L.tileLayer(TILE_URL, { attribution:TILE_ATTR, maxZoom:19 }).addTo(map);

    // Create cluster group (hidden by default)
    if (L.markerClusterGroup) {
      clusterRef.current = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 50,
        iconCreateFunction: (cluster) => L.divIcon({
          html: `<div style="
            width:36px;height:36px;border-radius:50%;
            background:${mapDotColor};opacity:0.85;
            display:flex;align-items:center;justify-content:center;
            font-weight:700;font-size:0.75rem;color:#000;
            border:2px solid #fff;box-shadow:0 0 8px ${mapDotColor};
            font-family:monospace;
          ">${cluster.getChildCount()}</div>`,
          className: '', iconSize:[36,36], iconAnchor:[18,18],
        }),
      });
    }

    mapRef.current = map;
    setMapReady(true);
    return () => { map.remove(); mapRef.current = null; clusterRef.current = null; heatRef.current = null; setMapReady(false); };
  }, []);

  // Switch between layer modes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) return;
    const L = window.L;

    // Remove all layers first
    Object.values(markersRef.current).forEach(m => { try { map.removeLayer(m); } catch (_) {} });
    if (clusterRef.current) { try { map.removeLayer(clusterRef.current); } catch (_) {} }
    if (heatRef.current)    { try { map.removeLayer(heatRef.current); } catch (_) {} }

    if (layerMode === 'markers') {
      Object.values(markersRef.current).forEach(m => { try { m.addTo(map); } catch (_) {} });
    } else if (layerMode === 'cluster' && clusterRef.current) {
      clusterRef.current.clearLayers();
      Object.values(markersRef.current).forEach(m => { try { clusterRef.current.addLayer(m); } catch (_) {} });
      clusterRef.current.addTo(map);
    } else if (layerMode === 'heat') {
      const points = mapMessages
        .filter(m => m.lat && m.lng)
        .map(m => [m.lat, m.lng, 0.5]);
      if (heatRef.current) map.removeLayer(heatRef.current);
      heatRef.current = L.heatLayer(points, {
        radius: 25, blur: 15, maxZoom: 17,
        gradient: { 0.2:'#00ff9d', 0.5:'#ffb800', 0.8:'#ff4444' },
      }).addTo(map);
    }
  }, [layerMode, mapReady, mapMessages]);

  // Keep ref in sync so the visible top-up always uses current params
  useEffect(() => {
    fetchParamsRef.current = { mapMaxAgeDays, dateFrom, dateTo };
  }, [mapMaxAgeDays, dateFrom, dateTo]);

  // ── Sync blue "my location" dot from hook position ───────────────────────
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    if (geoPosition) {
      const { lat, lng } = geoPosition;
      if (myMarkerRef.current) {
        myMarkerRef.current.setLatLng([lat, lng]);
      } else {
        myMarkerRef.current = window.L.marker([lat, lng], {
          icon: window.L.divIcon({
            className: '',
            html: `<div style="width:14px;height:14px;border-radius:50%;background:#3b82f6;border:3px solid #fff;box-shadow:0 0 0 4px #3b82f655;"></div>`,
            iconSize:[14,14], iconAnchor:[7,7],
          }),
          zIndexOffset: 1000,
        }).bindPopup(`<div style="font-family:monospace;font-size:0.8rem"><strong style="color:#3b82f6">You</strong><br/>${user?.username}</div>`)
          .addTo(mapRef.current);
      }
    } else {
      if (myMarkerRef.current) {
        try { mapRef.current?.removeLayer(myMarkerRef.current); } catch (_) {}
        myMarkerRef.current = null;
      }
    }
  }, [geoPosition, mapReady]);

  // ── Show users (admin) ────────────────────────────────────────────────────
  const refreshUserMarkers = useCallback(() => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    fetchUserLocations().then(users => {
      const seen = new Set();
      users.forEach(u => {
        if (u.user_id === user?.id) return; // skip self — shown by myMarker
        seen.add(u.username);
        const existing = userMarkersRef.current[u.username];
        if (existing) {
          existing.setLatLng([u.lat, u.lng]);
        } else {
          const color = '#f59e0b';
          const marker = L.marker([u.lat, u.lng], {
            icon: L.divIcon({
              className: '',
              html: `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
                <div style="background:${color};color:#000;font-family:monospace;font-size:0.6rem;font-weight:700;padding:1px 5px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.4)">${u.username}</div>
                <div style="width:10px;height:10px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 6px ${color}"></div>
              </div>`,
              iconSize:[60,28], iconAnchor:[30,28],
            }),
            zIndexOffset: 900,
          }).bindPopup(`<div style="font-family:monospace;font-size:0.8rem"><strong style="color:${color}">${u.username}</strong><br/><span style="color:#888;font-size:0.7rem">${u.lat.toFixed(5)}, ${u.lng.toFixed(5)}</span><br/><span style="color:#888;font-size:0.65rem">${new Date(u.updated_at + 'Z').toLocaleTimeString()}</span></div>`)
            .addTo(mapRef.current);
          userMarkersRef.current[u.username] = marker;
        }
      });
      // Remove stale markers
      Object.keys(userMarkersRef.current).forEach(name => {
        if (!seen.has(name)) {
          try { mapRef.current?.removeLayer(userMarkersRef.current[name]); } catch (_) {}
          delete userMarkersRef.current[name];
        }
      });
    }).catch(() => {});
  }, [user]);

  useEffect(() => {
    if (!isAdmin) return;
    if (showUsers) {
      refreshUserMarkers();
      usersIntervalRef.current = setInterval(refreshUserMarkers, 30_000);
    } else {
      clearInterval(usersIntervalRef.current);
      Object.values(userMarkersRef.current).forEach(m => {
        try { mapRef.current?.removeLayer(m); } catch (_) {}
      });
      userMarkersRef.current = {};
    }
    return () => clearInterval(usersIntervalRef.current);
  }, [showUsers, isAdmin]);

  // When map tab becomes visible, top-up any coordinates saved after the last fetch
  useEffect(() => {
    if (!visible || !mapRef.current) return;
    mapRef.current.invalidateSize();
    const { mapMaxAgeDays: mad, dateFrom: df, dateTo: dt } = fetchParamsRef.current;
    fetchMap(df && dt ? 5000 : 2000, mad, df || null, dt || null)
      .then(rows => {
        if (!Array.isArray(rows)) return;
        rows.forEach(msg => {
          if (!markersRef.current[msg.id]) {
            setMapMessages(prev => {
              if (prev.find(m => m.id === msg.id)) return prev;
              setTotal(t => t + 1);
              return [msg, ...prev];
            });
            addMarker(msg);
          }
        });
      })
      .catch(console.warn);
  }, [visible]);

  function makeIcon(color) {
    const col = color || mapDotColor;
    return window.L.divIcon({
      className: '',
      html: `<div style="width:14px;height:14px;border-radius:50%;background:${col};border:2px solid #fff;box-shadow:0 0 7px ${col};"></div>`,
      iconSize:[14,14], iconAnchor:[7,7], popupAnchor:[0,-10],
    });
  }

  const deleteLocation = useCallback((id) => {
    clearMessageLocation(id).catch(() => {});
    const marker = markersRef.current[id];
    if (marker) {
      try { mapRef.current?.closePopup(); mapRef.current?.removeLayer(marker); } catch (_) {}
      delete markersRef.current[id];
    }
    setMapMessages(prev => prev.filter(m => m.id !== id));
    setTotal(t => Math.max(0, t - 1));
    setSelected(s => s?.id === id ? null : s);
  }, []);

  useEffect(() => {
    window.__pmDeleteLocation = deleteLocation;
    return () => { delete window.__pmDeleteLocation; };
  }, [deleteLocation]);

  const addMarker = useCallback((msg) => {
    if (!window.L || !msg.lat || !msg.lng) return;
    const color = msg.alias_color || mapDotColor;
    const label = msg.alias_name  || msg.capcode;
    const popup = `<div style="font-family:monospace;font-size:0.8rem;min-width:180px">
      <strong style="color:${color}">${label}</strong><br/>
      <span style="color:#888;font-size:0.7rem">${msg.capcode} · ${fmtTime(msg.timestamp, locale, hour12)}</span><br/>
      <div style="margin-top:4px;word-break:break-word">${msg.message || '(no text)'}</div>
      <button onclick="window.__pmDeleteLocation(${msg.id})" style="margin-top:6px;padding:2px 8px;font-size:0.7rem;font-family:monospace;cursor:pointer;border-radius:4px;border:1px solid #ff444466;background:transparent;color:#ff6666;">Delete location</button>
    </div>`;

    if (markersRef.current[msg.id]) {
      markersRef.current[msg.id].setLatLng([msg.lat, msg.lng]).setIcon(makeIcon(color));
    } else {
      // Create marker but don't add to map yet — layer mode effect handles placement
      const marker = window.L.marker([msg.lat, msg.lng], { icon: makeIcon(color) })
        .bindPopup(popup)
        .on('click', () => setSelected(msg));
      markersRef.current[msg.id] = marker;

      // Add to current active layer immediately
      if (mapRef.current) {
        if (layerMode === 'markers') marker.addTo(mapRef.current);
        else if (layerMode === 'cluster' && clusterRef.current) clusterRef.current.addLayer(marker);
        // heatmap updates via the full layer rebuild in the effect
      }
    }
  }, [mapDotColor, layerMode]);

  // Update all marker colors when mapDotColor changes
  useEffect(() => {
    Object.values(markersRef.current).forEach(m => {
      // Only update markers that use the default color (no alias color)
    });
    // Simplest: re-add all markers with updated icons
    mapMessages.forEach(msg => addMarker(msg));
  }, [mapDotColor]);

  // Execute pending fly once map is ready
  useEffect(() => {
    if (!mapReady || !pendingFlyRef.current) return;
    const msg = pendingFlyRef.current;
    pendingFlyRef.current = null;
    setTimeout(() => flyTo(msg), 100);
  }, [mapReady]);

  // Fly to a message when navigated from feed via map pin button
  useEffect(() => {
    if (!flyToMsg) return;
    if (!mapRef.current) {
      pendingFlyRef.current = flyToMsg;
      onFlyComplete?.();
      return;
    }
    flyTo(flyToMsg);
    onFlyComplete?.();
  }, [flyToMsg]);
  // Full reset + fetch whenever admin setting OR date picker changes
  useEffect(() => {
    setLoading(true);
    Object.values(markersRef.current).forEach(m => {
      try { mapRef.current?.removeLayer(m); } catch (_) {}
    });
    markersRef.current = {};
    if (clusterRef.current) clusterRef.current.clearLayers();
    setMapMessages([]);
    setTotal(0);

    fetchMap(dateFrom && dateTo ? 5000 : 2000, mapMaxAgeDays, dateFrom || null, dateTo || null)
      .then(rows => {
        const arr = Array.isArray(rows) ? rows : [];
        setMapMessages(arr); setTotal(arr.length);
        arr.forEach(addMarker);
      })
      .catch(console.warn)
      .finally(() => setLoading(false));
  }, [mapMaxAgeDays, dateFrom, dateTo]);

  const geocodedRef = useRef(new Set()); // IDs already geocoded this session

  useEffect(() => {
    Object.values(markersRef.current).forEach(m => {
      try { mapRef.current?.removeLayer(m); } catch (_) {}
    });
    markersRef.current = {};
    if (clusterRef.current) clusterRef.current.clearLayers();
    if (heatRef.current) {
      try { mapRef.current?.removeLayer(heatRef.current); } catch (_) {}
      heatRef.current = null;
    }
    setMapMessages([]);
    setTotal(0);
    geocodedRef.current = new Set();
  }, [resetKey]);

  // Watch live messages — geocode any with addresses
  useEffect(() => {
    if (!liveMessages?.length) return;
    const cutoffMs = Date.now() - mapMaxAgeDays * 24 * 60 * 60 * 1000;

    liveMessages.forEach(msg => {
      // Skip messages outside the age window so re-geocoded old messages
      // don't bypass the mapMaxAgeDays filter via WebSocket
      if (msg.timestamp && new Date(msg.timestamp).getTime() < cutoffMs) return;

      // Already has coords — just add to map if not already there
      if (msg.lat && msg.lng) {
        setMapMessages(prev => {
          if (prev.find(m => m.id === msg.id)) return prev;
          setTotal(t => t + 1);
          return [msg, ...prev];
        });
        addMarker(msg);
        return;
      }

      // Skip if already geocoded in this session
      if (geocodedRef.current.has(msg.id)) return;

      // Try to parse an address from the message text
      const loc = parseLocation(msg.message || '', geocodeCountry);
      if (!loc || loc.type !== 'address') return;

      // Mark as being geocoded
      geocodedRef.current.add(msg.id);
      setGeocoding(true);

      // Pass full location object so geocodeAddress can use the best query
      geocodeAddress(loc, geocodeCountry)
        .then(result => {
          if (!result) return;
          const enriched = { ...msg, lat: result.lat, lng: result.lng };

          // Add to map sidebar
          setMapMessages(prev => {
            if (prev.find(m => m.id === enriched.id)) return prev;
            setTotal(t => t + 1);
            return [enriched, ...prev];
          });
          addMarker(enriched);

          // Persist to DB and notify feed to show 📍 button
          if (enriched.id) {
            saveMessageLocation(enriched.id, result.lat, result.lng)
              .then(() => {
                onLocationResolved?.(enriched.id, result.lat, result.lng);
              })
              .catch(e => console.warn('[MapView] saveMessageLocation failed:', e));
          }
        })
        .catch(() => {})
        .finally(() => setGeocoding(false));
    });
  }, [liveMessages, mapMaxAgeDays]);

  const flyTo = (msg) => {
    if (!msg?.lat || !msg?.lng || isNaN(msg.lat) || isNaN(msg.lng)) return;
    setSelected(msg);
    if (!mapRef.current) return;
    // Add marker if it doesn't exist yet (e.g. map just opened)
    if (!markersRef.current[msg.id]) addMarker(msg);
    mapRef.current.flyTo([msg.lat, msg.lng], 15, { duration:0.8 });
    setTimeout(() => markersRef.current[msg.id]?.openPopup(), 900);
    if (window.innerWidth <= 640) setSidebarOpen(false);
  };

  const SidebarContent = () => (
    <>
      <div style={{ padding:'0.6rem 0.75rem', borderBottom:'1px solid var(--border)',
        fontSize:'0.72rem', color:'var(--text-3)', fontFamily:'monospace',
        display:'flex', alignItems:'center', justifyContent:'space-between', gap:'0.5rem' }}>
        <span>📍 {total} location{total!==1?'s':''}</span>
        <div style={{ display:'flex', gap:'0.5rem' }}>
          {geocoding && <span style={{ color:'var(--accent-amber)' }}>geocoding…</span>}
          {loading   && <span>loading…</span>}
        </div>
      </div>

      {/* Share my location */}
      <div style={{ padding:'0.4rem 0.5rem', borderBottom:'1px solid var(--border)',
        display:'flex', alignItems:'center', gap:'0.4rem', flexWrap:'wrap' }}>
        {geoState !== 'denied' ? (
          <button
            onClick={() => geoState === 'active' ? locationSharing?.stop() : locationSharing?.start()}
            style={{
              display:'flex', alignItems:'center', gap:'0.3rem',
              padding:'0.22rem 0.5rem', borderRadius:'0.35rem', fontSize:'0.72rem',
              fontWeight:500, cursor:'pointer', transition:'all 0.15s', flex:1,
              border: geoState === 'active'
                ? '1px solid color-mix(in srgb, #3b82f6 40%, transparent)'
                : '1px solid var(--border)',
              background: geoState === 'active'
                ? 'color-mix(in srgb, #3b82f6 12%, transparent)'
                : 'var(--bg-3)',
              color: geoState === 'active' ? '#3b82f6' : 'var(--text-2)',
            }}>
            {geoState === 'asking'
              ? <><Loader size={11} style={{ animation:'spin 1s linear infinite' }}/> Locating…</>
              : <><LocateFixed size={11}/> {geoState === 'active' ? 'Sharing location' : 'Share my location'}</>}
          </button>
        ) : (
          <span style={{ fontSize:'0.68rem', color:'var(--accent-amber)', fontFamily:'monospace' }}>Location blocked</span>
        )}
        {isAdmin && (
          <button
            onClick={() => setShowUsers(s => !s)}
            title="Show online users on map"
            style={{
              display:'flex', alignItems:'center', gap:'0.3rem',
              padding:'0.22rem 0.5rem', borderRadius:'0.35rem', fontSize:'0.72rem',
              fontWeight:500, cursor:'pointer', transition:'all 0.15s',
              border: showUsers
                ? '1px solid color-mix(in srgb, var(--accent-amber) 40%, transparent)'
                : '1px solid var(--border)',
              background: showUsers
                ? 'color-mix(in srgb, var(--accent-amber) 12%, transparent)'
                : 'var(--bg-3)',
              color: showUsers ? 'var(--accent-amber)' : 'var(--text-2)',
            }}>
            <Users size={11}/> Users
          </button>
        )}
      </div>
      {/* Date range picker */}
      <div style={{ padding:'0.4rem 0.5rem', borderBottom:'1px solid var(--border)',
        display:'flex', alignItems:'center', gap:'0.3rem', flexWrap:'wrap' }}>
        <input type="date" value={dateFrom} max={dateTo || new Date().toISOString().slice(0,10)}
          onChange={e => setDateFrom(e.target.value)}
          style={{ flex:1, minWidth:0, fontSize:'0.7rem', fontFamily:'monospace', padding:'0.2rem 0.3rem',
            background:'var(--bg-2)', color:'var(--text-1)', border:'1px solid var(--border)',
            borderRadius:'0.3rem', colorScheme:'dark' }} />
        <span style={{ color:'var(--text-3)', fontSize:'0.7rem', flexShrink:0 }}>→</span>
        <input type="date" value={dateTo} min={dateFrom || undefined} max={new Date().toISOString().slice(0,10)}
          onChange={e => setDateTo(e.target.value)}
          style={{ flex:1, minWidth:0, fontSize:'0.7rem', fontFamily:'monospace', padding:'0.2rem 0.3rem',
            background:'var(--bg-2)', color:'var(--text-1)', border:'1px solid var(--border)',
            borderRadius:'0.3rem', colorScheme:'dark' }} />
        {(dateFrom || dateTo) && (
          <button onClick={() => { setDateFrom(''); setDateTo(''); }}
            title="Reset to default range"
            style={{ flexShrink:0, fontSize:'0.7rem', padding:'0.2rem 0.4rem', borderRadius:'0.3rem',
              background:'transparent', border:'1px solid var(--border)', color:'var(--text-2)',
              cursor:'pointer', fontFamily:'monospace', lineHeight:1 }}>×</button>
        )}
      </div>
      <div style={{ padding:'0.2rem 0.5rem 0.3rem', fontSize:'0.65rem', color:'var(--text-3)',
        fontFamily:'monospace', borderBottom:'1px solid var(--border)' }}>
        {dateFrom && dateTo
          ? 'Date range: up to 5000 pins'
          : 'Default view: up to 2000 pins · use dates for more'}
      </div>
      <div style={{ flex:1, overflowY:'auto' }}>
        {mapMessages.length === 0 && !loading ? (
          <div style={{ padding:'1.5rem 1rem', color:'var(--text-3)', fontSize:'0.8rem',
            fontFamily:'monospace', textAlign:'center', lineHeight:1.7 }}>
            No messages with coordinates yet.<br/>
            Messages containing<br/>
            <code style={{ color:'var(--accent-amber)' }}>46.0569,14.5058</code><br/>
            or addresses like<br/>
            <code style={{ color:'var(--accent-amber)' }}>Dunajska cesta 5</code><br/>
            will appear here.
          </div>
        ) : mapMessages.map(msg => (
          <div key={msg.id} onClick={() => flyTo(msg)} style={{
            padding:'0.5rem 0.75rem', cursor:'pointer',
            borderBottom:'1px solid var(--border-soft)',
            background: selected?.id===msg.id ? 'color-mix(in srgb, var(--accent-green) 8%, var(--bg-2))' : 'transparent',
            borderLeft: selected?.id===msg.id ? `3px solid var(--accent-green)` : '3px solid transparent',
            transition:'background 0.1s',
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:'0.4rem', marginBottom:'0.2rem', flexWrap:'wrap' }}>
              <Badge label={msg.alias_name} color={msg.alias_color || '#4ade80'} />
              <Badge label={msg.group_name} color={msg.group_color || '#a855f7'} />
            </div>
            <div style={{ fontFamily:'monospace', fontSize:'0.7rem', color:'var(--text-3)', marginBottom:'0.2rem' }}>
              {msg.capcode} · {fmtTime(msg.timestamp, locale, hour12)}
            </div>
            <div style={{ fontFamily:'monospace', fontSize:'0.78rem', color:'var(--text-1)',
              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {msg.message || '(no text)'}
            </div>
            <div style={{ fontFamily:'monospace', fontSize:'0.65rem', color:'var(--text-3)', marginTop:'0.15rem' }}>
              {msg.lat?.toFixed(6)}, {msg.lng?.toFixed(6)}
            </div>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <>
      <div style={{ display:'flex', height:'100%', overflow:'hidden', position:'relative' }}>

        {/* ── Desktop sidebar ──────────────────────────────────── */}
        <div className="map-sidebar-desktop" style={{
          width:'260px', flexShrink:0, display:'flex', flexDirection:'column',
          background:'var(--bg-1)', borderRight:'1px solid var(--border)', overflow:'hidden',
        }}>
          {SidebarContent()}
        </div>

        {/* ── Map ──────────────────────────────────────────────── */}
        <div style={{ flex:1, position:'relative', minWidth:0 }}>
          <div ref={mapDivRef} style={{ width:'100%', height:'100%' }} />

          {/* Layer mode toggle — top right of map */}
          <div style={{ position:'absolute', top:'0.6rem', right:'0.6rem', zIndex:1000,
            display:'flex', gap:'0.3rem', background:'var(--bg-1)',
            border:'1px solid var(--border)', borderRadius:'0.5rem',
            padding:'0.25rem', boxShadow:'0 2px 8px rgba(0,0,0,0.3)' }}>
            {[
              { id:'markers', label:'📍',   title:'Individual markers' },
              { id:'cluster', label:<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.3"/>
                  <circle cx="9.5" cy="9.5" r="3.5" stroke="currentColor" strokeWidth="1.3"/>
                  <circle cx="4" cy="10" r="2" fill="currentColor" opacity="0.4"/>
                </svg>, title:'Clustered markers', disabled: !window.L?.markerClusterGroup },
              { id:'heat',    label:'🌡',   title:'Heatmap density',   disabled: !window.L?.heatLayer },
            ].map(({ id, label, title, disabled }) => (
              <button key={id} onClick={() => !disabled && setLayerMode(id)} title={title}
                disabled={disabled}
                style={{
                  width:'28px', height:'26px', borderRadius:'0.3rem', border:'none',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontSize:'0.85rem', display:'flex', alignItems:'center', justifyContent:'center',
                  color: layerMode === id ? 'var(--accent-green)' : 'var(--text-2)',
                  background: layerMode === id
                    ? 'color-mix(in srgb, var(--accent-green) 20%, var(--bg-3))'
                    : 'transparent',
                  outline: layerMode === id ? '1px solid var(--accent-green)' : 'none',
                  opacity: disabled ? 0.4 : 1,
                  transition:'all 0.15s',
                }}>
                {label}
              </button>
            ))}
          </div>

          {/* Mobile: toggle sidebar button — shown by CSS on small screens */}
          <button className="map-sidebar-toggle" onClick={() => setSidebarOpen(o => !o)}
            style={{ display:'none', position:'absolute', top:'0.6rem', left:'0.6rem', zIndex:1000,
              background:'var(--bg-1)', border:'1px solid var(--border)', borderRadius:'0.4rem',
              padding:'0.4rem 0.6rem', cursor:'pointer', color:'var(--text-1)',
              fontSize:'0.75rem', fontFamily:'monospace', boxShadow:'0 2px 8px rgba(0,0,0,0.3)',
              alignItems:'center', gap:'0.35rem' }}>
            {sidebarOpen ? <ChevronLeft size={14}/> : <ChevronRight size={14}/>}
            {sidebarOpen ? 'Hide list' : `📍 ${total}`}
          </button>
        </div>

        {/* ── Mobile sidebar overlay ───────────────────────────── */}
        {sidebarOpen && (
          <div className="map-sidebar-mobile" style={{
            position:'absolute', top:0, left:0, bottom:0, width:'85%', maxWidth:'300px',
            zIndex:999, display:'flex', flexDirection:'column',
            background:'var(--bg-1)', borderRight:'1px solid var(--border)',
            boxShadow:'4px 0 16px rgba(0,0,0,0.4)',
          }}>
            {SidebarContent()}
          </div>
        )}

        {/* Backdrop to close sidebar on mobile */}
        {sidebarOpen && (
          <div className="map-sidebar-mobile" onClick={() => setSidebarOpen(false)}
            style={{ position:'absolute', inset:0, zIndex:998,
              background:'rgba(0,0,0,0.3)' }} />
        )}
      </div>

      <style>{`
        @media (max-width: 640px) {
          .map-sidebar-desktop { display: none !important; }
          .map-sidebar-toggle  { display: flex !important; }
        }
      `}</style>
    </>
  );
}

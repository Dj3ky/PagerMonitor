import { useState, useEffect } from 'react';
import { MapPin, RefreshCw, Clock } from 'lucide-react';
import { fetchUserLocations } from '../../utils/api.js';

function age(updatedAt) {
  const diff = Math.floor((Date.now() - new Date(updatedAt + 'Z').getTime()) / 1000);
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function isOnline(updatedAt) {
  return (Date.now() - new Date(updatedAt + 'Z').getTime()) < 10 * 60 * 1000; // within 10 min
}

export default function UserLocations() {
  const [rows,       setRows]       = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);

  const load = () => {
    setLoading(true);
    fetchUserLocations()
      .then(data => { setRows(Array.isArray(data) ? data : []); setLastRefresh(new Date()); })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ maxWidth: '520px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'1rem',
        display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <MapPin size={16} style={{ color:'var(--accent-amber)' }}/> User Locations
      </h2>

      <div className="pm-card">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
          marginBottom:'0.75rem', gap:'0.5rem', flexWrap:'wrap' }}>
          <span style={{ fontSize:'0.72rem', color:'var(--text-3)', fontFamily:'monospace' }}>
            {rows.length === 0
              ? 'No users have shared their location yet.'
              : `${rows.length} user${rows.length !== 1 ? 's' : ''} · auto-refreshes every 30s`}
          </span>
          <div style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
            {lastRefresh && (
              <span style={{ fontSize:'0.68rem', color:'var(--text-3)', fontFamily:'monospace', display:'flex', alignItems:'center', gap:'0.3rem' }}>
                <Clock size={10}/> {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <button className="pm-btn" onClick={load} disabled={loading}
              style={{ display:'flex', alignItems:'center', gap:'0.3rem', padding:'0.2rem 0.5rem', fontSize:'0.72rem' }}>
              <RefreshCw size={11} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}/>
              Refresh
            </button>
          </div>
        </div>

        {rows.length > 0 && (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'0.78rem', fontFamily:'monospace' }}>
            <thead>
              <tr style={{ borderBottom:'1px solid var(--border)' }}>
                {['User', 'Latitude', 'Longitude', 'Last seen'].map(h => (
                  <th key={h} style={{ padding:'0.3rem 0.5rem', textAlign:'left',
                    fontSize:'0.68rem', color:'var(--text-3)', fontWeight:600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const online = isOnline(r.updated_at);
                return (
                  <tr key={r.user_id} style={{ borderBottom:'1px solid var(--border-soft)' }}>
                    <td style={{ padding:'0.45rem 0.5rem' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
                        <span style={{ width:'7px', height:'7px', borderRadius:'50%', flexShrink:0,
                          background: online ? 'var(--accent-green)' : 'var(--text-3)',
                          boxShadow: online ? '0 0 5px var(--accent-green)' : 'none' }} />
                        <span style={{ color:'var(--text-1)', fontWeight:600 }}>{r.username}</span>
                      </div>
                    </td>
                    <td style={{ padding:'0.45rem 0.5rem', color:'var(--text-2)' }}>
                      {r.lat.toFixed(5)}
                    </td>
                    <td style={{ padding:'0.45rem 0.5rem', color:'var(--text-2)' }}>
                      {r.lng.toFixed(5)}
                    </td>
                    <td style={{ padding:'0.45rem 0.5rem' }}>
                      <span style={{ color: online ? 'var(--accent-green)' : 'var(--text-3)',
                        fontSize:'0.72rem' }}>
                        {age(r.updated_at)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {rows.length === 0 && !loading && (
          <div style={{ padding:'1.5rem 0', textAlign:'center', color:'var(--text-3)',
            fontSize:'0.78rem', lineHeight:1.7 }}>
            No locations stored yet.<br/>
            Users can share their location using the<br/>
            <span style={{ color:'#3b82f6' }}>Share my location</span> button on the Map view.
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { usePtrScroll } from '../hooks/usePtrScroll.js';
import { Archive, Search, X, RefreshCw, Download } from 'lucide-react';
import MessageRow from './MessageRow.jsx';
import { useSite } from '../context/SiteContext.jsx';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const authHeaders = () => ({ Authorization: `Bearer ${tok()}` });
const SOURCE_COL_WIDTH = '120px';

function fmtDate(ts, locale) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(locale, { day:'numeric', month:'numeric', year:'numeric' }).replace(/\s/g, '');
}

export default function ArchivePanel({ highlightRules = [], groups = [] }) {
  const { t } = useTranslation();
  const { locale } = useSite();
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState([]);
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // Load stats and recent archive on mount
  useEffect(() => {
    fetch(`${BASE}/api/archive/stats`, { headers: authHeaders() })
      .then(r => r.json()).then(d => { if (d && d.total != null) setStats(d); }).catch(() => {});
    fetch(`${BASE}/api/archive?limit=50`, { headers: authHeaders() })
      .then(r => r.json()).then(d => { if (Array.isArray(d)) setResults(d); }).catch(() => {});
  }, []);

  const search = async (q) => {
    setLoading(true);
    try {
      const url = q.trim()
        ? `${BASE}/api/archive?q=${encodeURIComponent(q)}&limit=200`
        : `${BASE}/api/archive?limit=200`;
      const r = await fetch(url, { headers: authHeaders() });
      const d = await r.json();
      setResults(Array.isArray(d) ? d : []);
      setSearched(true);
    } catch (_) {}
    finally { setLoading(false); }
  };

  const clear = async () => {
    setQuery('');
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/archive?limit=50`, { headers: authHeaders() });
      const d = await r.json();
      setResults(Array.isArray(d) ? d : []);
      setSearched(false);
    } catch (_) {}
    finally { setLoading(false); }
  };

  // Pull-to-refresh (native only) — re-runs whatever's currently on screen (an active
  // search or the default recent view) rather than resetting it.
  const refresh = useCallback(async () => {
    try {
      const url = searched && query.trim()
        ? `${BASE}/api/archive?q=${encodeURIComponent(query)}&limit=200`
        : `${BASE}/api/archive?limit=50`;
      const [statsData, d] = await Promise.all([
        fetch(`${BASE}/api/archive/stats`, { headers: authHeaders() }).then(r => r.json()).catch(() => null),
        fetch(url, { headers: authHeaders() }).then(r => r.json()),
      ]);
      if (statsData && statsData.total != null) setStats(statsData);
      if (Array.isArray(d)) setResults(d);
    } catch (_) {}
  }, [query, searched]);
  const { ref: scrollRef, pull, refreshing } = usePtrScroll(refresh);

  const downloadCsv = async () => {
    const url = query.trim()
      ? `${BASE}/api/archive/export?q=${encodeURIComponent(query)}`
      : `${BASE}/api/archive/export`;
    try {
      const r    = await fetch(url, { headers: authHeaders() });
      const blob = await r.blob();
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `pagermonitor-archive-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (_) {}
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* Header bar */}
      <div style={{ flexShrink:0, padding:'0.5rem 0.75rem', background:'var(--bg-1)',
        borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'0.75rem', flexWrap:'wrap' }}>

        <div style={{ display:'flex', alignItems:'center', gap:'0.4rem', color:'var(--accent-blue)' }}>
          <Archive size={15}/>
          <span style={{ fontFamily:'monospace', fontSize:'0.8rem', fontWeight:700 }}>{t('archivePanel.title')}</span>
        </div>

        {stats && (
          <span style={{ fontFamily:'monospace', fontSize:'0.72rem', color:'var(--text-3)' }}>
            {t('archivePanel.messageCount', { count: stats.total, formatted: stats.total.toLocaleString() })} · {fmtDate(stats.oldest, locale)} – {fmtDate(stats.newest, locale)}
          </span>
        )}

        <div style={{ flex:1, display:'flex', gap:'0.4rem', minWidth:'160px' }}>
          <div style={{ flex:1, position:'relative' }}>
            <Search size={12} style={{ position:'absolute', left:'0.5rem', top:'50%',
              transform:'translateY(-50%)', color:'var(--text-3)' }} />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search(query)}
              placeholder={t('archivePanel.searchPlaceholder')}
              style={{ width:'100%', paddingLeft:'1.75rem', paddingRight:'0.5rem',
                height:'30px', background:'var(--bg-3)', border:'1px solid var(--border)',
                borderRadius:'0.4rem', color:'var(--text-1)', fontSize:'0.8rem',
                fontFamily:'monospace', outline:'none', boxSizing:'border-box' }} />
          </div>
          <button className="pm-btn pm-btn-primary" onClick={() => search(query)}
            disabled={loading} style={{ flexShrink:0, height:'30px' }}>
            {loading ? <RefreshCw size={12} style={{ animation:'spin 1s linear infinite' }}/> : <Search size={12}/>}
          </button>
          {searched && (
            <button className="pm-btn" onClick={clear} style={{ flexShrink:0, height:'30px' }}>
              <X size={12}/>
            </button>
          )}
          <button className="pm-btn" onClick={downloadCsv}
            title={query ? t('archivePanel.exportSearchCsv') : t('archivePanel.exportAllCsv')}
            style={{ flexShrink:0, height:'30px' }}>
            <Download size={12}/>
          </button>
        </div>
      </div>

      {/* Results */}
      <div ref={scrollRef} style={{ flex:1, overflowY:'auto' }}>
        {(pull > 0 || refreshing) && (
          <div style={{ height: refreshing ? 40 : pull, overflow:'hidden',
            display:'flex', alignItems:'center', justifyContent:'center',
            transition: refreshing ? 'height 0.15s' : 'none' }}>
            <span style={{
              width:18, height:18, borderRadius:'50%',
              border:'2px solid var(--accent-blue)', borderTopColor:'transparent',
              opacity: refreshing ? 1 : Math.min(pull / 64, 1),
              transform: refreshing ? undefined : `rotate(${pull * 3}deg)`,
              animation: refreshing ? 'spin 0.6s linear infinite' : 'none',
            }} />
          </div>
        )}
        {results.length === 0 && !loading && (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
            justifyContent:'center', height:'100%', color:'var(--text-3)', gap:'0.5rem' }}>
            <Archive size={32} style={{ opacity:0.2 }}/>
            <p style={{ fontFamily:'monospace', fontSize:'0.85rem', margin:0 }}>
              {stats?.total === 0 ? t('archivePanel.empty') : t('archivePanel.noResults')}
            </p>
          </div>
        )}

        {results.length > 0 && (
          <>
            {/* Header */}
            <div style={{ display:'flex', alignItems:'center', gap:'0.5rem',
              padding:'0.28rem 0.75rem', background:'var(--bg-2)', borderBottom:'1px solid var(--border)',
              position:'sticky', top:0, zIndex:2 }}>
              <span style={{ flexShrink:0, width:'12px' }} />
              {[t('messageFeed.dateTime'), t('messageFeed.source'), t('messageFeed.capcode'), t('messageFeed.aliasGroup'), t('messageFeed.message')].map((h, i) => (
                <span key={h} style={{ fontFamily:'monospace', fontSize:'0.6rem', fontWeight:700,
                  textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--text-3)',
                  ...(i === 0 ? { flexShrink:0, minWidth:'62px', textAlign:'right' } :
                      i === 1 ? { flexShrink:0, width: SOURCE_COL_WIDTH, textAlign:'center' } :
                      i === 2 ? { flexShrink:0, minWidth:'70px' } :
                      i === 3 ? { flexShrink:0, width:'130px' } : { flex:1 }) }}>
                  {h}
                </span>
              ))}
            </div>
            {results.map((msg, i) => (
              <MessageRow key={msg.id || i} msg={msg}
                highlightRules={highlightRules} groups={groups} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

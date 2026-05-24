import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth }      from './context/AuthContext.jsx';
import { useWebSocket } from './hooks/useWebSocket.js';
import { fetchHistory, fetchSearch, fetchStatus, fetchRules, fetchGroups } from './utils/api.js';
import LoginPage     from './components/LoginPage.jsx';
import Header        from './components/Header.jsx';
import StatusBar     from './components/StatusBar.jsx';
import MessageFeed   from './components/MessageFeed.jsx';
import SearchPanel   from './components/SearchPanel.jsx';
import FilterBar     from './components/FilterBar.jsx';
import AdminPanel    from './components/admin/AdminPanel.jsx';
import MapView       from './components/MapView.jsx';
import ArchivePanel      from './components/ArchivePanel.jsx';
import PasswordResetPage from './components/PasswordResetPage.jsx';
import UserProfile       from './components/UserProfile.jsx';
import ErrorBoundary     from './components/ErrorBoundary.jsx';
import { playAlertSound } from './components/admin/KeywordAlerts.jsx';

// Register sound function globally for WebSocket hook
window.__playAlertSound = playAlertSound;
import { useBrowserNotifications } from './hooks/useBrowserNotifications.js';
import { usePushSubscription }     from './hooks/usePushSubscription.js';

const BACKEND_URL  = import.meta.env.VITE_BACKEND_URL || '';
const PAGE_OPTIONS = [20, 50, 100, 200];

export default function App() {
  const { user, loading: authLoading, needsSetup, isPublic } = useAuth();
  const [showLogin, setShowLogin]       = useState(false);
  const [showProfile, setShowProfile]   = useState(false);
  const [resetToken]                    = useState(() => new URLSearchParams(window.location.search).get('reset'));

  const { messages, wsStatus, sdrStatus, prependHistory, appendHistory, removeMessage } = useWebSocket(BACKEND_URL);

  const [filters, setFilters]               = useState({ capcode:'', keyword:'', alias:'', group:'' });
  const [searchResults, setSearchResults]   = useState(null);
  const [searching, setSearching]           = useState(false);
  const [serverStatus, setServerStatus]     = useState(null);
  const [pollSdrStatus, setPollSdrStatus]   = useState(null);
  const [view, setView] = useState(() => sessionStorage.getItem('pm_view') || 'feed');

  const handleSetView = (v) => {
    sessionStorage.setItem('pm_view', v);
    setView(v);
  };
  const [soundEnabled, setSoundEnabled]     = useState(true);
  const browserNotif = useBrowserNotifications();
  const pushSub      = usePushSubscription();
  const [paused, setPaused]                 = useState(false);
  const [newCount, setNewCount]             = useState(0);
  const [loadingMore, setLoadingMore]       = useState(false);
  const [noMoreMessages, setNoMoreMessages] = useState(false);

  const handleLoadMore = async () => {
    const oldest = messages[messages.length - 1];
    if (!oldest?.id || loadingMore) return;
    setLoadingMore(true);
    try {
      const older = await fetchHistory(200, oldest.id);
      if (!older?.length) { setNoMoreMessages(true); }
      else { appendHistory(older); if (older.length < 200) setNoMoreMessages(true); }
    } catch (e) { console.warn('Load more failed:', e); }
    finally { setLoadingMore(false); }
  };
  const [highlightRules, setHighlightRules] = useState([]);
  const [groups, setGroups]                 = useState([]);
  const [pageSize, setPageSize]             = useState(50);
  const [page, setPage]                     = useState(0);

  useEffect(() => { window.__pagemon_sound = soundEnabled; }, [soundEnabled]);

  // Sync push subscription with the browser notification bell
  useEffect(() => {
    if (!user || user.isGuest) return;
    if (browserNotif.enabled && browserNotif.permission === 'granted') {
      pushSub.subscribe();
    } else if (!browserNotif.enabled) {
      pushSub.unsubscribe();
    }
  }, [browserNotif.enabled, browserNotif.permission, user]);

  useEffect(() => {
    if (!user) return;
    fetchHistory(200).then(prependHistory).catch(console.warn);
    fetchRules().then(r  => Array.isArray(r) ? setHighlightRules(r) : null).catch(console.warn);
    fetchGroups().then(r => Array.isArray(r) ? setGroups(r) : null).catch(console.warn);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const poll = () => fetchStatus().then(s => {
      setServerStatus(s);
      if (s?.sdr) setPollSdrStatus(s.sdr);
    }).catch(console.warn);
    poll();
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, [user]);

  useEffect(() => {
    if (paused && messages.length > 0) setNewCount(n => n + 1);
    else setPage(0);
    // Browser notification for newest message
    if (messages.length > 0) browserNotif.notify(messages[0]);
  }, [messages]);

  const [mapFlyTo, setMapFlyTo] = useState(null);

  // Click map pin in feed → switch to map view and fly to location
  const handleMapClick = useCallback((msg) => {
    setMapFlyTo(msg);
    handleSetView('map');
  }, []);

  // When MapView geocodes an address, update the message in feed state so 📍 button appears
  const [resolvedLocations, setResolvedLocations] = useState({});
  const handleLocationResolved = useCallback((id, lat, lng) => {
    setResolvedLocations(prev => ({ ...prev, [id]: { lat, lng } }));
  }, []);

  const handleSearch = useCallback(async q => {
    if (!q.trim()) {
      setSearchResults(null);
      // Only return to feed when leaving search — don't override admin/map/archive on initial mount
      setView(prev => {
        const next = prev === 'search' ? 'feed' : prev;
        if (next !== prev) sessionStorage.setItem('pm_view', next);
        return next;
      });
      return;
    }
    setSearching(true);
    try { const r = await fetchSearch(q); setSearchResults(r); handleSetView('search'); }
    catch (e) { console.warn(e); }
    finally { setSearching(false); }
  }, []);

  // Click-to-filter from message rows
  const handleRowFilter = useCallback((type, value) => {
    setFilters(f => {
      if (type === 'capcode') return { ...f, capcode: f.capcode === value ? '' : value };
      if (type === 'alias')   return { ...f, alias:   f.alias   === value ? '' : value };
      if (type === 'group')   return { ...f, group:   f.group   === value ? '' : value };
      return f;
    });
    setPage(0);
    setNoMoreMessages(false);
  }, []);

  const filteredMessages = useMemo(() => messages
    .map(m => resolvedLocations[m.id] ? { ...m, ...resolvedLocations[m.id] } : m)
    .filter(m => {
    if (filters.capcode && !m.capcode?.includes(filters.capcode)) return false;
    if (filters.alias   && (m.alias_name || m.alias) !== filters.alias) return false;
    if (filters.group   && (m.group_name || m.parent_group_name) !== filters.group) return false;
    if (filters.keyword) {
      try { if (!new RegExp(filters.keyword, 'i').test(m.message || '')) return false; }
      catch { if (!(m.message || '').toLowerCase().includes(filters.keyword.toLowerCase())) return false; }
    }
    return true;
  }), [messages, filters, resolvedLocations]);

  const effectiveSdrStatus = sdrStatus ?? pollSdrStatus;
  const allDisplay         = paused ? [] : filteredMessages;
  const totalPages         = Math.max(1, Math.ceil(allDisplay.length / pageSize));
  const safePage           = Math.min(page, totalPages - 1);
  const displayMessages    = allDisplay.slice(safePage * pageSize, (safePage + 1) * pageSize);

  // Handle password reset link /?reset=TOKEN
  if (resetToken) return <PasswordResetPage token={resetToken} />;

  if (authLoading) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'var(--bg-0)' }}>
        <div style={{ width:'28px', height:'28px', borderRadius:'50%', border:'3px solid var(--bg-4)',
          borderTopColor:'var(--accent-green)', animation:'spin 0.8s linear infinite' }} />
      </div>
    );
  }

  if (!user || needsSetup) return <LoginPage />;

  // Public read-only: hide admin navigation and user controls
  const isGuest = user.isGuest === true;

  // Guest clicked "Log in" — show login page temporarily
  if (isGuest && showLogin) return <LoginPage onCancel={() => setShowLogin(false)} />;

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden', background:'var(--bg-0)' }}>
      <Header wsStatus={wsStatus} soundEnabled={soundEnabled}
        onToggleSound={() => setSoundEnabled(s => !s)}
        browserNotif={browserNotif}
        onSearch={handleSearch} searching={searching}
        view={view} setView={handleSetView}
        isGuest={isGuest}
        onGuestLogin={() => setShowLogin(true)}
        onProfileOpen={() => setShowProfile(true)} />
      {showProfile && <UserProfile onClose={() => setShowProfile(false)} />}

      <StatusBar sdrStatus={effectiveSdrStatus} serverStatus={serverStatus}
        wsStatus={wsStatus} messageCount={messages.length} />

      {view === 'feed' && (
        <FilterBar
          filters={filters}
          onChange={f => { setFilters(f); setPage(0); }}
          paused={paused}
          onTogglePause={() => { setPaused(p => !p); setNewCount(0); }}
          newCount={newCount}
          pageSize={pageSize} onPageSize={s => { setPageSize(s); setPage(0); }}
          pageOptions={PAGE_OPTIONS}
          page={safePage} totalPages={totalPages} onPage={setPage}
          totalMessages={allDisplay.length}
        />
      )}

      <main style={{ flex:1, overflow:'hidden', position:'relative' }}>
        <ErrorBoundary name="main view">
          <div style={{ position:'absolute', inset:0, display: view === 'feed' ? 'flex' : 'none', flexDirection:'column' }}>
            <MessageFeed messages={displayMessages} highlightRules={highlightRules}
              groups={groups} onFilter={handleRowFilter} onMapClick={handleMapClick}
              onLoadMore={safePage === totalPages - 1 ? handleLoadMore : null}
              loadingMore={loadingMore} noMoreMessages={noMoreMessages}
              totalInDb={serverStatus?.stats?.total || 0}
              totalLoaded={messages.length}
              onDelete={removeMessage} />
          </div>
          {/* MapView always mounted so geocoding/state persists across tab switches */}
          <div style={{ position:'absolute', inset:0, display: view === 'map' ? 'block' : 'none' }}>
            <MapView messages={messages} flyToMsg={mapFlyTo}
              visible={view === 'map'}
              onFlyComplete={() => setMapFlyTo(null)}
              onLocationResolved={handleLocationResolved} />
          </div>
          <div style={{ position:'absolute', inset:0, display: view === 'archive' ? 'flex' : 'none', flexDirection:'column' }}>
            <ArchivePanel highlightRules={highlightRules} groups={groups} />
          </div>
          <div style={{ position:'absolute', inset:0, display: view === 'search' ? 'flex' : 'none', flexDirection:'column' }}>
            <SearchPanel results={searchResults} searching={searching}
              highlightRules={highlightRules} groups={groups}
              onFilter={handleRowFilter} onMapClick={handleMapClick}
              onDelete={id => setSearchResults(r => r?.filter(m => m.id !== id))}
              onClear={() => { setSearchResults(null); handleSetView('feed'); }} />
          </div>
          {view === 'admin' && (
            <AdminPanel sdrStatus={effectiveSdrStatus} serverStatus={serverStatus}
              onRulesChange={setHighlightRules} onGroupsChange={setGroups} />
          )}
        </ErrorBoundary>
      </main>
    </div>
  );
}

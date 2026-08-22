import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { Capacitor } from '@capacitor/core';
import { useAuth }      from './context/AuthContext.jsx';
import { useSite }      from './context/SiteContext.jsx';
import { useWebSocket, subscribeWsMessages } from './hooks/useWebSocket.js';
import { fetchHistory, fetchSearch, fetchStatus, fetchRules, fetchGroups } from './utils/api.js';
import LoginPage     from './components/LoginPage.jsx';
import Header        from './components/Header.jsx';
import BottomNav     from './components/BottomNav.jsx';
import StatusBar     from './components/StatusBar.jsx';
import MessageFeed   from './components/MessageFeed.jsx';
import SearchPanel   from './components/SearchPanel.jsx';
import FilterBar     from './components/FilterBar.jsx';
import MapView       from './components/MapView.jsx';
import ArchivePanel      from './components/ArchivePanel.jsx';
import WeatherView       from './components/WeatherView.jsx';
import PasswordResetPage from './components/PasswordResetPage.jsx';
import JoinPage          from './components/JoinPage.jsx';
import UserProfile       from './components/UserProfile.jsx';
import ErrorBoundary     from './components/ErrorBoundary.jsx';

// Admin tooling and the aircraft/traffic radars are large and only used by a
// subset of sessions (admins, or sites with those features enabled) — split
// them into their own chunks instead of bloating everyone's initial bundle.
const AdminPanel        = lazy(() => import('./components/admin/AdminPanel.jsx'));
const AircraftView      = lazy(() => import('./components/AircraftView.jsx'));
const TrafficView       = lazy(() => import('./components/TrafficView.jsx'));
const InterventionsView = lazy(() => import('./components/InterventionsView.jsx'));

import { playAlertSound } from './components/admin/KeywordAlerts.jsx';

// Register sound function globally for WebSocket hook
window.__playAlertSound = playAlertSound;
import { useBrowserNotifications } from './hooks/useBrowserNotifications.js';
import { usePushSubscription }     from './hooks/usePushSubscription.js';
import { useFcmPush }              from './hooks/useFcmPush.js';
import { useLocationSharing }      from './hooks/useLocationSharing.js';

const BACKEND_URL  = import.meta.env.VITE_BACKEND_URL || '';
const PAGE_OPTIONS = [20, 50, 100, 200];

export default function App() {
  const { user, loading: authLoading, needsSetup, isPublic } = useAuth();
  const { enableTraffic, enableAircraft, enableInterventions, geocodeCountry } = useSite();
  // All three features are hardcoded to Slovenian data sources (DARS/DRSI
  // traffic, Slovenia-bounding-box aircraft, SOS112 interventions) — pointless
  // outside a Slovenian deployment, regardless of the enable toggle. Same gate
  // ARSO weather already uses.
  const showAircraft      = enableAircraft      && geocodeCountry === 'si';
  const showTraffic       = enableTraffic       && geocodeCountry === 'si';
  const showInterventions = enableInterventions && geocodeCountry === 'si';
  const [showLogin, setShowLogin]       = useState(false);
  const [showProfile, setShowProfile]   = useState(false);
  const [resetToken]                    = useState(() => new URLSearchParams(window.location.search).get('reset'));
  const [inviteCode]                    = useState(() => new URLSearchParams(window.location.search).get('invite'));

  const { messages, wsStatus, sdrStatus, prependHistory, appendHistory, removeMessage } = useWebSocket(BACKEND_URL);

  const [filters, setFilters]               = useState({ capcode:'', keyword:'', alias:'', group:'' });
  const [searchResults, setSearchResults]   = useState(null);
  const [searching, setSearching]           = useState(false);
  const [searchQuery, setSearchQuery]       = useState('');
  const [searchHasMore, setSearchHasMore]   = useState(false);
  const [searchCursor, setSearchCursor]     = useState(null);
  // Bumped on every new search / clear so an in-flight request (a fresh search, or a
  // "load more" for a since-superseded query) can tell it's stale once it resolves and
  // discard itself instead of corrupting the current results with a mismatched query's
  // response — see handleSearch/handleSearchLoadMore.
  const searchRequestId = useRef(0);
  const [loadingMoreSearch, setLoadingMoreSearch] = useState(false);
  const [serverStatus, setServerStatus]     = useState(null);
  const [pollSdrStatus, setPollSdrStatus]   = useState(null);
  const [latestSha, setLatestSha]           = useState(null);
  const [updateFlags, setUpdateFlags]       = useState({ server: false, client: false });
  const [view, setView] = useState(() => sessionStorage.getItem('pm_view') || 'feed');
  // Requested admin tab — set by the status-bar update link so AdminPanel can
  // switch tabs even when it is already mounted (view already === 'admin').
  const [requestedAdminTab, setRequestedAdminTab] = useState(null);

  const handleSetView = (v) => {
    sessionStorage.setItem('pm_view', v);
    setView(v);
  };

  // Bounce off a menu that got disabled while the user was on it (or is disabled on load).
  useEffect(() => {
    if ((view === 'aircraft' && !showAircraft) || (view === 'traffic' && !showTraffic) ||
        (view === 'interventions' && !showInterventions)) {
      handleSetView('feed');
    }
  }, [view, showAircraft, showTraffic, showInterventions]);
  const [soundEnabled, setSoundEnabled]     = useState(true);
  const browserNotif = useBrowserNotifications();
  const pushSub      = usePushSubscription();
  useFcmPush();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isNative = Capacitor.isNativePlatform();
  const [paused, setPaused]                 = useState(false);
  const [newCount, setNewCount]             = useState(0);
  const [loadingMore, setLoadingMore]       = useState(false);
  const [noMoreMessages, setNoMoreMessages] = useState(false);
  // The server's real scan position (not the id of the oldest *displayed* message — under
  // an active feed filter those can diverge a lot, since a matching message's id can sit
  // far above the raw range the server actually had to scan through to find it). Load More
  // must resume from this, or it re-scans a range already proven empty instead of advancing.
  const [historyCursor, setHistoryCursor]   = useState(null);

  const handleLoadMore = async () => {
    if (loadingMore || noMoreMessages) return;
    setLoadingMore(true);
    try {
      const { messages: older, hasMore, nextBefore } = await fetchHistory(200, historyCursor);
      if (older?.length) appendHistory(older);
      setHistoryCursor(nextBefore);
      setNoMoreMessages(!hasMore);
    } catch (e) { console.warn('Load more failed:', e); }
    finally { setLoadingMore(false); }
  };
  const [highlightRules, setHighlightRules] = useState([]);
  const [groups, setGroups]                 = useState([]);
  const [pageSize, setPageSize]             = useState(50);
  const [page, setPage]                     = useState(0);

  useEffect(() => { window.__pagermonitor_sound = soundEnabled; }, [soundEnabled]);

  // Lets useBrowserNotifications tell "tab focused, looking at the feed" (skip popup,
  // it's already visible) apart from "tab focused, but the feed is hidden behind the
  // profile/settings overlay" (still show it — the user can't actually see new messages).
  useEffect(() => { window.__pagermonitor_feed_covered = showProfile; }, [showProfile]);

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
    fetchHistory(200).then(r => {
      prependHistory(r.messages);
      setHistoryCursor(r.nextBefore);
      setNoMoreMessages(!r.hasMore);
    }).catch(console.warn);
    fetchRules().then(r  => Array.isArray(r) ? setHighlightRules(r) : null).catch(console.warn);
    fetchGroups().then(r => Array.isArray(r) ? setGroups(r) : null).catch(console.warn);
  }, [user]);

  // Pull-to-refresh (native only — see usePtrScroll) re-catches-up the feed the same way
  // a WS reconnect does, without needing to actually drop the socket. Also resets the
  // load-more cursor to match, since it's re-anchoring the feed to the newest messages.
  const refreshFeed = useCallback(() => (
    fetchHistory(200).then(r => {
      prependHistory(r.messages);
      setHistoryCursor(r.nextBefore);
      setNoMoreMessages(!r.hasMore);
    }).catch(console.warn)
  ), [prependHistory]);

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

  // Fetch latest GitHub commit SHA on login + re-check every hour
  // Used by status bar to show update availability badges
  useEffect(() => {
    if (!user) return;
    const check = () =>
      fetch('https://api.github.com/repos/Dj3ky/PagerMonitor/commits/main')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.sha) setLatestSha(d.sha); })
        .catch(() => {});
    check();
    const t = setInterval(check, 60 * 60 * 1000); // re-check every hour
    return () => clearInterval(t);
  }, [user]);

  // This is a monorepo (client/, backend/, frontend/ all in one repo), so the server
  // and every SDR client just report their own `git rev-parse HEAD` of the whole tree.
  // Comparing that hash directly against latestSha above would flag "update available"
  // for a Pi client even when the newest commit only touched backend/ or frontend/ (and
  // vice versa for the server). Instead, diff each reported hash against latestSha via
  // GitHub's compare API and only flag it if the changed files actually fall under the
  // relevant directory. Results are cached per hash pair since hashes rarely change.
  const compareCacheRef = useRef(new Map());
  useEffect(() => {
    if (!latestSha) return;
    const serverHash    = serverStatus?.gitHash;
    const clientHashes  = [...new Set((serverStatus?.sdrClients ?? []).map(c => c.gitHash).filter(Boolean))];

    const touchesPath = async (fromHash, prefixes) => {
      if (!fromHash || fromHash === latestSha) return false;
      const cacheKey = `${fromHash}..${latestSha}`;
      const cached = compareCacheRef.current.get(cacheKey);
      if (cached) return cached.some(f => prefixes.some(p => f.startsWith(p)));
      try {
        const r = await fetch(`https://api.github.com/repos/Dj3ky/PagerMonitor/compare/${fromHash}...${latestSha}`);
        if (!r.ok) return false;
        const d = await r.json();
        const files = (d.files || []).map(f => f.filename);
        compareCacheRef.current.set(cacheKey, files);
        return files.some(f => prefixes.some(p => f.startsWith(p)));
      } catch { return false; }
    };

    let cancelled = false;
    (async () => {
      const serverRelevant = await touchesPath(serverHash, ['backend/', 'frontend/']);
      const clientRelevant = (await Promise.all(clientHashes.map(h => touchesPath(h, ['client/'])))).some(Boolean);
      if (!cancelled) setUpdateFlags({ server: serverRelevant, client: clientRelevant });
    })();
    return () => { cancelled = true; };
  }, [latestSha, serverStatus?.gitHash, JSON.stringify((serverStatus?.sdrClients ?? []).map(c => c.gitHash))]);

  // Jump to page 0 only when a genuinely new message arrives at the top (id changes).
  // Using messages.length here would also fire when "load more" appends older
  // history at the end, which changes length without a new message — that was
  // resetting the user back to page 0 whenever they paged to the end and loaded more.
  // Also skip the jump while a local filter is active (capcode/keyword/alias/group):
  // otherwise every incoming message — matching the filter or not — yanked the user
  // back to page 0 mid-search, making it near-impossible to browse filtered results
  // while the feed keeps receiving traffic.
  const newestId  = messages[0]?.id ?? 0;
  const filtering = !!(filters.capcode || filters.keyword || filters.alias || filters.group);
  useEffect(() => {
    if (paused && messages.length > 0) setNewCount(n => n + 1);
    else if (!filtering) setPage(0);
  }, [newestId]);

  // Browser notifications — subscribe directly to raw WS events, not React state.
  // This fires once per live message, regardless of React batching, and never
  // fires for historical messages loaded via fetchHistory() on page load/reconnect.
  useEffect(() => {
    return subscribeWsMessages(data => {
      if (data.type === 'message') browserNotif.notify(data);
    });
  }, [browserNotif.notify]);

  const locationSharing = useLocationSharing(user);

  const [mapFlyTo, setMapFlyTo]       = useState(null);
  const [mapResetKey, setMapResetKey] = useState(0);
  const handleResetMap = useCallback(() => setMapResetKey(k => k + 1), []);

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
      searchRequestId.current++; // invalidate any in-flight search/load-more for the old query
      setSearchResults(null);
      setSearchQuery('');
      setSearchHasMore(false);
      setSearchCursor(null);
      // Only return to feed when leaving search — don't override admin/map/archive on initial mount
      setView(prev => {
        const next = prev === 'search' ? 'feed' : prev;
        if (next !== prev) sessionStorage.setItem('pm_view', next);
        return next;
      });
      return;
    }
    const requestId = ++searchRequestId.current;
    setSearching(true);
    setSearchQuery(q);
    try {
      const r = await fetchSearch(q);
      if (searchRequestId.current !== requestId) return; // superseded by a newer search/clear
      setSearchResults(r.results);
      setSearchHasMore(r.hasMore);
      setSearchCursor(r.nextBefore);
      handleSetView('search');
    }
    catch (e) { console.warn(e); }
    finally { if (searchRequestId.current === requestId) setSearching(false); }
  }, []);

  // Load the next page of DB search results (same cursor the results ended on) and
  // append — mirrors handleLoadMore for the live feed, but against /api/search instead
  // of /api/history. Guarded the same way as handleSearch: if a new search (or a clear)
  // starts while this is in flight, its response is discarded instead of being appended
  // onto whatever query is now active.
  const handleSearchLoadMore = useCallback(async () => {
    if (loadingMoreSearch || !searchHasMore || !searchQuery) return;
    const requestId = searchRequestId.current;
    setLoadingMoreSearch(true);
    try {
      const r = await fetchSearch(searchQuery, 100, searchCursor);
      if (searchRequestId.current !== requestId) return; // superseded by a newer search/clear
      setSearchResults(prev => [...(prev || []), ...r.results]);
      setSearchHasMore(r.hasMore);
      setSearchCursor(r.nextBefore);
    } catch (e) { console.warn('Search load more failed:', e); }
    finally { if (searchRequestId.current === requestId) setLoadingMoreSearch(false); }
  }, [searchQuery, searchCursor, searchHasMore, loadingMoreSearch]);

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

  // Handle invite link /?invite=CODE
  if (inviteCode) return <JoinPage code={inviteCode} />;

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
    <div className="app-shell" style={{ display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--bg-0)' }}>
      <Header wsStatus={wsStatus} soundEnabled={soundEnabled}
        onToggleSound={() => setSoundEnabled(s => !s)}
        browserNotif={browserNotif}
        onSearch={handleSearch} searching={searching}
        view={view} setView={handleSetView}
        isGuest={isGuest}
        onGuestLogin={() => setShowLogin(true)}
        onProfileOpen={() => setShowProfile(true)}
        menuOpen={mobileMenuOpen} onMenuOpenChange={setMobileMenuOpen} />
      {showProfile && <UserProfile onClose={() => setShowProfile(false)} />}

      <StatusBar sdrStatus={effectiveSdrStatus} serverStatus={serverStatus}
        wsStatus={wsStatus} messageCount={messages.length}
        latestSha={latestSha} updateFlags={updateFlags}
        onNavigate={(tab) => { handleSetView('admin'); setRequestedAdminTab(tab); }} />

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
              onDelete={removeMessage}
              wsStatus={wsStatus}
              onRefresh={refreshFeed} />
          </div>
          {/* MapView always mounted so geocoding/state persists across tab switches */}
          <div style={{ position:'absolute', inset:0, display: view === 'map' ? 'block' : 'none' }}>
            <MapView messages={messages} flyToMsg={mapFlyTo}
              visible={view === 'map'}
              onFlyComplete={() => setMapFlyTo(null)}
              onLocationResolved={handleLocationResolved}
              resetKey={mapResetKey}
              locationSharing={locationSharing} />
          </div>
          <div style={{ position:'absolute', inset:0, display: view === 'archive' ? 'flex' : 'none', flexDirection:'column' }}>
            <ArchivePanel highlightRules={highlightRules} groups={groups} />
          </div>
          <div style={{ position:'absolute', inset:0, display: view === 'weather' ? 'flex' : 'none', flexDirection:'column' }}>
            <WeatherView visible={view === 'weather'} locationSharing={locationSharing} />
          </div>
          {showAircraft && (
            <div style={{ position:'absolute', inset:0, display: view === 'aircraft' ? 'flex' : 'none', flexDirection:'column' }}>
              <Suspense fallback={null}>
                <AircraftView visible={view === 'aircraft'} />
              </Suspense>
            </div>
          )}
          {showTraffic && (
            <div style={{ position:'absolute', inset:0, display: view === 'traffic' ? 'flex' : 'none', flexDirection:'column' }}>
              <Suspense fallback={null}>
                <TrafficView visible={view === 'traffic'} />
              </Suspense>
            </div>
          )}
          {showInterventions && (
            <div style={{ position:'absolute', inset:0, display: view === 'interventions' ? 'flex' : 'none', flexDirection:'column' }}>
              <Suspense fallback={null}>
                <InterventionsView visible={view === 'interventions'} />
              </Suspense>
            </div>
          )}
          <div style={{ position:'absolute', inset:0, display: view === 'search' ? 'flex' : 'none', flexDirection:'column' }}>
            <SearchPanel results={searchResults} searching={searching}
              highlightRules={highlightRules} groups={groups}
              onFilter={handleRowFilter} onMapClick={handleMapClick}
              onDelete={id => setSearchResults(r => r?.filter(m => m.id !== id))}
              onLoadMore={handleSearchLoadMore} hasMore={searchHasMore} loadingMore={loadingMoreSearch}
              onClear={() => {
                searchRequestId.current++; // invalidate any in-flight search/load-more
                setSearchResults(null); setSearchQuery(''); setSearchHasMore(false); setSearchCursor(null);
                handleSetView('feed');
              }} />
          </div>
          {view === 'admin' && (
            <Suspense fallback={null}>
              <AdminPanel sdrStatus={effectiveSdrStatus} serverStatus={serverStatus}
                onRulesChange={setHighlightRules} onGroupsChange={setGroups}
                requestedTab={requestedAdminTab}
                onTabHandled={() => setRequestedAdminTab(null)}
                onResetMap={handleResetMap} />
            </Suspense>
          )}
        </ErrorBoundary>
      </main>

      {isNative && (
        <BottomNav view={view} setView={handleSetView}
          menuOpen={mobileMenuOpen} onMenuOpenChange={setMobileMenuOpen}
          showInterventions={showInterventions} />
      )}

      {/* Location sharing prompt — shown once on first open */}
      {locationSharing.showPrompt && !isGuest && (
        <div style={{
          position:'fixed', bottom:'1rem', left:'50%', transform:'translateX(-50%)',
          zIndex:9000, maxWidth:'360px', width:'calc(100% - 2rem)',
          background:'var(--bg-1)', border:'1px solid var(--border)',
          borderRadius:'0.6rem', padding:'0.75rem 1rem',
          boxShadow:'0 4px 24px rgba(0,0,0,0.5)',
          display:'flex', flexDirection:'column', gap:'0.5rem',
        }}>
          <div style={{ display:'flex', alignItems:'flex-start', gap:'0.6rem' }}>
            <span style={{ fontSize:'1.1rem', flexShrink:0 }}>📍</span>
            <div>
              <div style={{ fontSize:'0.85rem', fontWeight:600, color:'var(--text-1)', marginBottom:'0.2rem' }}>
                Allow location access?
              </div>
              <div style={{ fontSize:'0.75rem', color:'var(--text-3)', lineHeight:1.5 }}>
                Used to center the weather radar on your location.
              </div>
            </div>
          </div>
          <div style={{ display:'flex', gap:'0.5rem', justifyContent:'flex-end' }}>
            <button onClick={locationSharing.declinePrompt}
              style={{ padding:'0.3rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem',
                border:'1px solid var(--border)', background:'transparent',
                color:'var(--text-2)', cursor:'pointer' }}>
              Not now
            </button>
            <button onClick={locationSharing.acceptPrompt}
              style={{ padding:'0.3rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem',
                border:'1px solid color-mix(in srgb, #3b82f6 40%, transparent)',
                background:'color-mix(in srgb, #3b82f6 15%, transparent)',
                color:'#3b82f6', cursor:'pointer', fontWeight:600 }}>
              Allow
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

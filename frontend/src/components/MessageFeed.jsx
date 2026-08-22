import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import MessageRow from './MessageRow.jsx';
import { useSite } from '../context/SiteContext.jsx';
import { fetchLastSeen, saveLastSeen } from '../utils/api.js';
import { usePtrScroll } from '../hooks/usePtrScroll.js';

const BADGE_COL_WIDTH = '150px';
const SOURCE_COL_WIDTH = '120px';

function FeedHeader() {
  const { t } = useTranslation();
  const cell = (label, style) => (
    <span style={{ fontFamily:'monospace', fontSize:'0.68rem', fontWeight:700,
      textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--text-3)', ...style }}>
      {label}
    </span>
  );
  return (
    <div className="feed-header" style={{ display:'flex', alignItems:'center', gap:'0.5rem',
      padding:'0.28rem 0.75rem',
      background:'color-mix(in srgb, var(--bg-2) 85%, transparent)',
      backdropFilter:'blur(8px)', WebkitBackdropFilter:'blur(8px)',
      borderBottom:'1px solid var(--border)', borderLeft:'3px solid transparent',
      position:'sticky', top:0, zIndex:2 }}>
      <span style={{ width:'12px', flexShrink:0 }} />
      {cell(t('messageFeed.dateTime'),   { flexShrink:0, width:'90px', textAlign:'right', whiteSpace:'nowrap' })}
      {cell(t('messageFeed.source'),        { flexShrink:0, width: SOURCE_COL_WIDTH, textAlign:'center' })}
      {cell(t('messageFeed.capcode'),       { flexShrink:0, minWidth:'78px', textAlign:'center' })}
      {cell(t('messageFeed.aliasGroup'), { flexShrink:0, width: BADGE_COL_WIDTH, textAlign:'center', margin:'0 0.4rem' })}
      {cell(t('messageFeed.message'),       { flex:1, marginLeft:'0.35rem' })}
    </div>
  );
}

export default function MessageFeed({ messages, highlightRules = [], groups = [], onFilter, onMapClick, onLoadMore, loadingMore, noMoreMessages, totalInDb, totalLoaded, onDelete, wsStatus, onRefresh }) {
  const { t } = useTranslation();
  // settingsLoaded is true once the /api/site-settings fetch has resolved (success or fail).
  // We must NOT start the badge timer until then — otherwise a slow mobile network causes
  // the timer to fire with the hard-coded default (10 s) before the real configured value
  // arrives, permanently clearing the NEW badges too early.
  const { newBadgeSeconds = 10, settingsLoaded = true } = useSite();

  // lastSeenId from the server — tracks per-user across all devices
  const [lastSeenId, setLastSeenId] = useState(null); // null = not yet loaded
  const markSeenTimer = useRef(null);
  const pendingMarkId = useRef(null);
  const { ref: scrollRef, pull, refreshing } = usePtrScroll(onRefresh);

  // After WS connects or reconnects, scroll to top so newest messages are visible.
  // rAF defers until after React flushes, then history prepend keeps us at the top.
  useEffect(() => {
    if (wsStatus !== 'open') return;
    const id = requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(id);
  }, [wsStatus]);

  // Load user's last-seen from server on mount
  useEffect(() => {
    fetchLastSeen()
      .then(d => setLastSeenId(d.lastSeenId ?? 0))
      .catch(() => setLastSeenId(0)); // if fetch fails, show nothing as new
  }, []);

  // Stable primitive: the ID of the top (newest) message on the current page.
  // Using a primitive rather than the `messages` array reference means the
  // badge timer only restarts when a genuinely new message arrives — NOT on
  // every App re-render caused by the 10-second serverStatus poll (which
  // calls allDisplay.slice() and produces a new array reference each time,
  // previously resetting the countdown as fast as it ran).
  const topMessageId = messages[0]?.id ?? 0;

  // When a new message arrives (topMessageId advances) or lastSeenId loads,
  // schedule marking as seen.
  // Guards:
  //   1. Wait for settingsLoaded so we use the real configured duration, not the
  //      hard-coded default that is in place while the settings fetch is in flight.
  //   2. pendingMarkId is a HIGH-WATER MARK — it must never go backwards.
  //      `messages` is a paginated slice so messages[0] is the newest on the
  //      *current page*, not the global newest. If the user switches to an older
  //      page, topId can be lower than what we already recorded. Without the
  //      max() guard the timer would save that lower id to the server, causing
  //      already-seen messages to reappear as NEW on the next visit.
  useEffect(() => {
    if (!settingsLoaded) return;
    if (lastSeenId === null || topMessageId === 0) return;

    // High-water mark: advance only, never regress
    const highestNew = Math.max(pendingMarkId.current ?? 0, topMessageId);
    if (highestNew <= lastSeenId) {
      clearTimeout(markSeenTimer.current);
      return;
    }
    pendingMarkId.current = highestNew;

    clearTimeout(markSeenTimer.current);
    if (newBadgeSeconds === 0) {
      // Badge disabled — mark as seen immediately so NEW badge never appears
      setLastSeenId(highestNew);
      saveLastSeen(highestNew).catch(() => {});
      return;
    }
    markSeenTimer.current = setTimeout(() => {
      const id = pendingMarkId.current;
      if (!id) return;
      setLastSeenId(id);
      saveLastSeen(id).catch(() => {}); // fire-and-forget, non-critical
    }, newBadgeSeconds * 1000);

    return () => clearTimeout(markSeenTimer.current);
  }, [topMessageId, lastSeenId, newBadgeSeconds, settingsLoaded]);

  // When tab regains focus, restart the countdown with the same high-water mark
  useEffect(() => {
    const onFocus = () => {
      if (!settingsLoaded) return;
      if (lastSeenId === null || topMessageId === 0) return;
      const highestNew = Math.max(pendingMarkId.current ?? 0, topMessageId);
      if (highestNew <= lastSeenId) return;
      pendingMarkId.current = highestNew;
      clearTimeout(markSeenTimer.current);
      markSeenTimer.current = setTimeout(() => {
        const id = pendingMarkId.current;
        if (!id) return;
        setLastSeenId(id);
        saveLastSeen(id).catch(() => {});
      }, newBadgeSeconds * 1000);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [topMessageId, lastSeenId, newBadgeSeconds, settingsLoaded]);

  useEffect(() => () => clearTimeout(markSeenTimer.current), []);

  // `messages` here is already run through the caller's local capcode/keyword/alias/group
  // filter — it can be empty either because nothing has loaded yet at all (totalLoaded===0)
  // or because everything currently loaded was filtered out (totalLoaded>0). Only the first
  // case means there's truly nothing to show; the second means older, unloaded messages
  // might still match, so Load More must stay reachable here too — not just below the list,
  // which this early return would otherwise skip entirely.
  const showLoadMore = onLoadMore && !noMoreMessages && totalLoaded < totalInDb;
  const loadMoreButton = showLoadMore && (
    <div style={{ padding:'0.75rem', textAlign:'center', flexShrink:0 }}>
      <button onClick={onLoadMore} disabled={loadingMore}
        style={{ padding:'0.4rem 1.25rem', borderRadius:'0.5rem', cursor: loadingMore ? 'wait' : 'pointer',
          fontSize:'0.8rem', fontFamily:'monospace', fontWeight:600,
          background:'color-mix(in srgb,var(--accent-green) 10%,transparent)',
          border:'1px solid color-mix(in srgb,var(--accent-green) 25%,transparent)',
          color: loadingMore ? 'var(--text-3)' : 'var(--accent-green)',
          transition:'all 0.15s' }}>
        {loadingMore ? t('messageFeed.loading') : t('messageFeed.loadMore', { loaded: totalLoaded, total: totalInDb })}
      </button>
    </div>
  );

  if (messages.length === 0) {
    return (
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
        justifyContent:'center', height:'100%', color:'var(--text-3)', gap:'0.5rem' }}>
        <div style={{ fontSize:'3rem', opacity:0.2 }}>📟</div>
        <p style={{ fontFamily:'monospace', fontSize:'0.85rem', margin:0 }}>
          {totalLoaded > 0 ? t('messageFeed.noMatchesLoaded') : t('messageFeed.waiting')}
        </p>
        {loadMoreButton}
      </div>
    );
  }

  return (
    <div ref={scrollRef} style={{ height:'100%', overflowY:'auto', display:'flex', flexDirection:'column' }}>
      {(pull > 0 || refreshing) && (
        <div style={{ height: refreshing ? 40 : pull, flexShrink:0, overflow:'hidden',
          display:'flex', alignItems:'center', justifyContent:'center',
          transition: refreshing ? 'height 0.15s' : 'none' }}>
          <span style={{
            width:18, height:18, borderRadius:'50%',
            border:'2px solid var(--accent-green)', borderTopColor:'transparent',
            opacity: refreshing ? 1 : Math.min(pull / 64, 1),
            transform: refreshing ? undefined : `rotate(${pull * 3}deg)`,
            animation: refreshing ? 'ptr-spin 0.6s linear infinite' : 'none',
          }} />
        </div>
      )}
      <FeedHeader />
      {messages.map((msg, i) => {
        const msgId = msg.id ?? 0;
        const isNew = lastSeenId !== null && msgId > lastSeenId;
        return (
          <MessageRow key={msgId || i}
            msg={msg}
            index={i}
            isNew={isNew}
            highlightRules={highlightRules}
            groups={groups}
            onFilter={onFilter}
            onMapClick={onMapClick}
            onDelete={onDelete} />
        );
      })}

      {/* Load more — only shown on last page when there are more messages in DB */}
      {loadMoreButton}

      <style>{`
        @media(max-width:600px){.feed-header{display:none!important}}
        @keyframes new-pulse { 0%,100%{opacity:1} 50%{opacity:0.45} }
        @keyframes ptr-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

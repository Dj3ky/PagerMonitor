import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';

// The native Android shell has no Chrome browser UI to hand the overscroll to —
// "pull down at the top reloads the page" is a Chrome-app feature, not something
// a bare WebView does on its own — so letting it through there just produces a
// dead rubber-band gap instead of a refresh. Keep it contained everywhere on
// native, and drive an actual pull-to-refresh ourselves (see onRefresh below).
const isNative = Capacitor.isNativePlatform();

const THRESHOLD = 64; // px of pull before release triggers a refresh
const MAX_PULL  = 90;
const DAMPING   = 0.5; // finger travels further than the indicator, like most native PTR

/**
 * Attaches dynamic overscroll-behavior-y to a scroll container so that:
 *   • scrolled down        → 'contain'  (bottom overscroll stays in the element)
 *   • at top + touching    → 'auto'     (deliberate pull-to-refresh reaches the browser)
 *   • at top + NOT touching→ 'contain'  (momentum coasted to top — absorb here, not body)
 *
 * On native, additionally implements a real pull-to-refresh gesture (since the OS/browser
 * one is unavailable there): pulling past THRESHOLD at scrollTop 0 and releasing calls
 * onRefresh(). Returns { ref, pull, refreshing } — ref attaches to the scrollable element,
 * pull/refreshing drive the visual indicator.
 *
 * ref is a callback ref (not useRef) on purpose: several callers conditionally render a
 * different subtree (e.g. an empty-state placeholder) before the real scrollable element
 * exists, so the node this hook attaches to can show up on a later render than the first.
 * A useRef-based effect would capture that first (null) node once and never revisit it.
 */
export function usePtrScroll(onRefresh) {
  const [node, setNode] = useState(null);
  const ref = useCallback((el) => setNode(el), []);
  const [pull, setPull]           = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const el = node;
    if (!el) return;
    let touching = false;
    let pulling  = false;
    let startY   = 0;
    let pullDist = 0;
    let busy     = false;

    const updateOverscroll = () => {
      if (isNative || el.scrollTop > 0) {
        el.style.overscrollBehaviorY = 'contain';
      } else {
        el.style.overscrollBehaviorY = touching ? 'auto' : 'contain';
      }
    };

    const onTouchStart = (e) => {
      touching = true;
      updateOverscroll();
      if (isNative && onRefresh && !busy && el.scrollTop === 0) {
        startY  = e.touches[0].clientY;
        pulling = true;
      }
    };

    const onTouchMove = (e) => {
      if (!pulling) return;
      if (el.scrollTop > 0) { pulling = false; pullDist = 0; setPull(0); return; }
      const delta = e.touches[0].clientY - startY;
      pullDist = delta > 0 ? Math.min(delta * DAMPING, MAX_PULL) : 0;
      setPull(pullDist);
    };

    const onTouchEnd = () => {
      touching = false;
      if (!pulling) return;
      pulling = false;
      if (pullDist >= THRESHOLD) {
        busy = true;
        setRefreshing(true);
        Promise.resolve().then(onRefresh).catch(() => {}).finally(() => {
          busy = false;
          setRefreshing(false);
          setPull(0);
        });
      } else {
        setPull(0);
      }
      pullDist = 0;
    };

    updateOverscroll();
    el.addEventListener('scroll',      updateOverscroll, { passive: true });
    el.addEventListener('touchstart',  onTouchStart,      { passive: true });
    el.addEventListener('touchmove',   onTouchMove,       { passive: true });
    el.addEventListener('touchend',    onTouchEnd,        { passive: true });
    el.addEventListener('touchcancel', onTouchEnd,        { passive: true });

    return () => {
      el.removeEventListener('scroll',      updateOverscroll);
      el.removeEventListener('touchstart',  onTouchStart);
      el.removeEventListener('touchmove',   onTouchMove);
      el.removeEventListener('touchend',    onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [node, onRefresh]);

  return { ref, pull, refreshing };
}

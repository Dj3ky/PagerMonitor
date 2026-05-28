import { useEffect, useRef } from 'react';

/**
 * Attaches dynamic overscroll-behavior-y to a scroll container so that:
 *   • scrolled down        → 'contain'  (bottom overscroll stays in the element)
 *   • at top + touching    → 'auto'     (deliberate pull-to-refresh reaches the browser)
 *   • at top + NOT touching→ 'contain'  (momentum coasted to top — absorb here, not body)
 *
 * Returns a ref to attach to the scrollable element.
 */
export function usePtrScroll() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let touching = false;

    const update = () => {
      if (el.scrollTop > 0) {
        el.style.overscrollBehaviorY = 'contain';
      } else {
        el.style.overscrollBehaviorY = touching ? 'auto' : 'contain';
      }
    };

    const onTouchStart  = () => { touching = true;  update(); };
    const onTouchEnd    = () => { touching = false; };

    update();
    el.addEventListener('scroll',      update,       { passive: true });
    el.addEventListener('touchstart',  onTouchStart, { passive: true });
    el.addEventListener('touchend',    onTouchEnd,   { passive: true });
    el.addEventListener('touchcancel', onTouchEnd,   { passive: true });

    return () => {
      el.removeEventListener('scroll',      update);
      el.removeEventListener('touchstart',  onTouchStart);
      el.removeEventListener('touchend',    onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  return ref;
}

/**
 * Browser (OS-level) notifications hook.
 * Uses the Web Notifications API — works on desktop and Android Chrome.
 * On iOS Safari requires the site to be added to home screen as a PWA.
 */
import { useState, useCallback, useEffect } from 'react';

const LS_KEY = 'pm_browser_notif';

export function useBrowserNotifications() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;

  // Restore saved preference
  const [enabled, setEnabled] = useState(() => {
    if (!supported) return false;
    try { return localStorage.getItem(LS_KEY) === 'true'; } catch { return false; }
  });

  // Current browser permission: 'default' | 'granted' | 'denied'
  const [permission, setPermission] = useState(
    supported ? Notification.permission : 'denied'
  );

  // Keep permission in sync if user changes it in browser settings
  useEffect(() => {
    if (!supported) return;
    const id = setInterval(() => setPermission(Notification.permission), 2000);
    return () => clearInterval(id);
  }, [supported]);

  // If permission is revoked, disable automatically
  useEffect(() => {
    if (permission === 'denied' && enabled) {
      setEnabled(false);
      try { localStorage.setItem(LS_KEY, 'false'); } catch {}
    }
  }, [permission, enabled]);

  const toggle = useCallback(async () => {
    if (!supported) return;

    if (enabled) {
      // Turn off
      setEnabled(false);
      try { localStorage.setItem(LS_KEY, 'false'); } catch {}
      return;
    }

    // Turn on — request permission if not yet granted
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') return; // user denied
    }

    if (Notification.permission === 'granted') {
      setEnabled(true);
      try { localStorage.setItem(LS_KEY, 'true'); } catch {}
    }
  }, [supported, enabled]);

  const notify = useCallback((msg) => {
    if (!supported || !enabled || Notification.permission !== 'granted') return;
    // Don't notify if the page is visible and focused — user can already see it
    if (document.visibilityState === 'visible' && document.hasFocus()) return;

    try {
      const alias   = msg.alias_name || msg.alias || msg.capcode;
      const body    = msg.message || '(tone / numeric only)';
      const title   = `📟 ${alias}`;

      const n = new Notification(title, {
        body,
        icon:   '/icon-192.png',
        badge:  '/badge-96.png',
        tag:    `pm-${msg.capcode}`,   // replaces previous notif from same capcode
        silent: false,
      });

      // Click notification → focus the tab
      n.onclick = () => { window.focus(); n.close(); };

      // Auto-close after 8 seconds
      setTimeout(() => n.close(), 8000);
    } catch (_) {}
  }, [supported, enabled]);

  return { supported, enabled, permission, toggle, notify };
}

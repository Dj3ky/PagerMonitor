import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';

const isNative = Capacitor.isNativePlatform();
const BASE = import.meta.env.VITE_BACKEND_URL || '';

// Native Android background push (FCM) — the counterpart to usePushSubscription.js's
// Web Push for the browser/PWA. No on/off toggle: unlike the PWA (where enabling push
// is an explicit user action from a website), an installed app registering for its own
// notifications on first launch is the expected native pattern, gated only by the
// standard Android 13+ runtime permission prompt.
export function useFcmPush() {
  useEffect(() => {
    if (!isNative) return;
    let removeListeners = () => {};

    import('@capacitor/push-notifications').then(async ({ PushNotifications }) => {
      await PushNotifications.createChannel({
        id: 'pm_messages',
        name: 'Pager messages',
        description: 'New pager messages matching your notification preferences',
        importance: 4, // HIGH — heads-up popup + sound, without bypassing Do Not Disturb
        visibility: 1,
      }).catch(() => {});

      const perm = await PushNotifications.checkPermissions();
      if (perm.receive === 'prompt') {
        const req = await PushNotifications.requestPermissions();
        if (req.receive !== 'granted') return;
      } else if (perm.receive !== 'granted') {
        return;
      }

      const regListener = await PushNotifications.addListener('registration', async ({ value: token }) => {
        const tok = localStorage.getItem('pm_token') || '';
        fetch(`${BASE}/api/push/fcm-subscribe`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
          body:    JSON.stringify({ token }),
        }).catch(() => {});
      });
      const errListener = await PushNotifications.addListener('registrationError', (err) => {
        console.warn('FCM registration failed:', err);
      });

      await PushNotifications.register();

      removeListeners = () => { regListener.remove(); errListener.remove(); };
    }).catch(() => {});

    return () => removeListeners();
  }, []);
}

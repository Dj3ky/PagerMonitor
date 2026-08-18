import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './App.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import { AuthProvider }  from './context/AuthContext.jsx';
import { SiteProvider }  from './context/SiteContext.jsx';
import './i18n.js';
import './index.css';

const isNative = Capacitor.isNativePlatform();

// The native Android shell has no use for the install/offline-cache service worker
// (it's already an installed app), and Android WebView's SW support is inconsistent
// enough that it's not worth the risk of it interfering with asset loading.
if (!isNative && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // App stays suspended in memory across phone app-switches instead of
      // re-navigating, so check for a newer worker every time it's foregrounded.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});

    // Reload once so the page picks up the fresh bundle the new worker serves.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });
}

if (isNative) {
  import('@capacitor/status-bar').then(({ StatusBar, Style }) => {
    StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
    StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
    StatusBar.setBackgroundColor({ color: '#0d1117' }).catch(() => {});
  }).catch(() => {});

  // Hide the native splash once React has mounted, instead of the fixed
  // launchShowDuration timer, so it never covers an unfinished first paint.
  import('@capacitor/splash-screen').then(({ SplashScreen }) => {
    requestAnimationFrame(() => SplashScreen.hide().catch(() => {}));
  }).catch(() => {});
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <SiteProvider>
          <App />
        </SiteProvider>
      </AuthProvider>
    </ThemeProvider>
  </React.StrictMode>
);

import { createContext, useContext, useState, useEffect } from 'react';

const DEFAULT = { siteName: 'PagerMonitor', siteDescription: 'Real-time pager decoder', newBadgeSeconds: 10, mapDotColor: '#00ff9d', showMapButton: true, mapMaxAgeDays: 30, publicMode: false, geocodeCountry: 'si', locale: 'sl-SI', hour12: false };
const BASE    = import.meta.env.VITE_BACKEND_URL || '';

const SiteContext = createContext({ ...DEFAULT, settingsLoaded: false, update: () => {} });

export function SiteProvider({ children }) {
  const [settings, setSettings]         = useState(DEFAULT);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/site-settings`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const s = {
          siteName:        (d.siteName        || DEFAULT.siteName).trim(),
          siteDescription:  d.siteDescription || DEFAULT.siteDescription,
          newBadgeSeconds: Math.max(0, parseInt(d.newBadgeSeconds, 10) || 0),
          mapDotColor:     d.mapDotColor     || DEFAULT.mapDotColor,
          showMapButton:   d.showMapButton   !== false,
          mapMaxAgeDays:   Math.max(1/24, parseFloat(d.mapMaxAgeDays) || DEFAULT.mapMaxAgeDays),
          publicMode:      !!d.publicMode,
          geocodeCountry:  /^[a-z]{2}$/.test(d.geocodeCountry) ? d.geocodeCountry : DEFAULT.geocodeCountry,
          locale:          /^[a-z]{2}-[A-Z]{2}$/.test(d.locale) ? d.locale : DEFAULT.locale,
          hour12:          !!d.hour12,
        };
        setSettings(s);
        document.title = s.siteName;
      })
      .catch(() => {})
      // Always mark loaded — even if the fetch failed we fall back to defaults
      .finally(() => setSettingsLoaded(true));
  }, []);

  const update = (patch) => {
    setSettings(s => {
      const n = { ...s, ...patch, siteName: (patch.siteName || s.siteName).trim() };
      document.title = n.siteName;
      return n;
    });
  };

  return (
    <SiteContext.Provider value={{ ...settings, settingsLoaded, update }}>
      {children}
    </SiteContext.Provider>
  );
}

export const useSite = () => useContext(SiteContext);

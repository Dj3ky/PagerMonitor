import { createContext, useContext, useState, useEffect } from 'react';
import i18n from '../i18n.js';

// geocodeCountry/locale blank by default (unconfigured) — see admin.js's
// SITE_SETTINGS_DEFAULTS for why this can't default to Slovenia anymore.
// Optional-feature toggles default off (opt-in), on top of the geocodeCountry gate.
const DEFAULT = { siteName: 'PagerMonitor', siteDescription: 'Real-time pager decoder', newBadgeSeconds: 10, mapDotColor: '#00ff9d', showMapButton: true, mapMaxAgeDays: 30, publicMode: false, geocodeCountry: '', locale: '', hour12: false, windyApiKey: '', enableTraffic: false, enableAircraft: false, enableArsoWeather: false, enableInterventions: false };
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
          windyApiKey:     typeof d.windyApiKey === 'string' ? d.windyApiKey : '',
          enableTraffic:      d.enableTraffic      === true,
          enableAircraft:     d.enableAircraft     === true,
          enableArsoWeather:  d.enableArsoWeather  === true,
          enableInterventions: d.enableInterventions === true,
        };
        setSettings(s);
        document.title = s.siteName;
      })
      .catch(() => {})
      // Always mark loaded — even if the fetch failed we fall back to defaults
      .finally(() => setSettingsLoaded(true));
  }, []);

  // UI language follows the site locale setting: sl-SI switches to Slovenian,
  // everything else (including unconfigured) falls back to English.
  useEffect(() => {
    i18n.changeLanguage(settings.locale === 'sl-SI' ? 'sl' : 'en');
  }, [settings.locale]);

  const update = (patch) => {
    setSettings(s => {
      const n = { ...s, ...patch, siteName: (patch.siteName || s.siteName).trim() };
      document.title = n.siteName;
      return n;
    });
  };

  return (
    // locale is normalized to undefined (not '') here so every consumer's
    // toLocale*String(locale, ...) call falls back to the browser's own locale
    // instead of throwing on an empty-string BCP-47 tag.
    <SiteContext.Provider value={{ ...settings, locale: settings.locale || undefined, settingsLoaded, update }}>
      {children}
    </SiteContext.Provider>
  );
}

export const useSite = () => useContext(SiteContext);

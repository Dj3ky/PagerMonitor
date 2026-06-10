export const COUNTRY_CENTER = {
  si: { lat: 46.12, lon: 14.80, zoom: 9 },
  hr: { lat: 45.10, lon: 15.20, zoom: 8 },
  at: { lat: 47.51, lon: 14.55, zoom: 7 },
  de: { lat: 51.16, lon: 10.45, zoom: 6 },
  ch: { lat: 46.82, lon:  8.23, zoom: 8 },
  it: { lat: 41.87, lon: 12.57, zoom: 6 },
  fr: { lat: 46.23, lon:  2.21, zoom: 6 },
  es: { lat: 40.46, lon: -3.75, zoom: 6 },
  pt: { lat: 39.40, lon: -8.22, zoom: 7 },
  gb: { lat: 55.38, lon: -3.44, zoom: 6 },
  ie: { lat: 53.41, lon: -8.24, zoom: 7 },
  nl: { lat: 52.13, lon:  5.29, zoom: 7 },
  be: { lat: 50.50, lon:  4.47, zoom: 8 },
  pl: { lat: 51.92, lon: 19.14, zoom: 6 },
  cz: { lat: 49.82, lon: 15.47, zoom: 7 },
  sk: { lat: 48.67, lon: 19.70, zoom: 8 },
  hu: { lat: 47.16, lon: 19.50, zoom: 7 },
  ro: { lat: 45.94, lon: 24.97, zoom: 6 },
  rs: { lat: 44.02, lon: 21.01, zoom: 7 },
  ba: { lat: 43.92, lon: 17.68, zoom: 8 },
  me: { lat: 42.71, lon: 19.37, zoom: 9 },
  mk: { lat: 41.61, lon: 21.75, zoom: 8 },
  al: { lat: 41.15, lon: 20.17, zoom: 8 },
  bg: { lat: 42.73, lon: 25.49, zoom: 7 },
  gr: { lat: 39.07, lon: 21.82, zoom: 7 },
  tr: { lat: 38.96, lon: 35.24, zoom: 6 },
  ua: { lat: 48.38, lon: 31.17, zoom: 6 },
  se: { lat: 60.13, lon: 18.64, zoom: 5 },
  no: { lat: 64.59, lon: 17.89, zoom: 5 },
  dk: { lat: 56.26, lon:  9.50, zoom: 7 },
  fi: { lat: 61.92, lon: 25.75, zoom: 5 },
  us: { lat: 37.09, lon: -95.71, zoom: 4 },
  ca: { lat: 56.13, lon: -106.35, zoom: 4 },
  au: { lat: -25.27, lon: 133.78, zoom: 4 },
  nz: { lat: -40.90, lon: 174.89, zoom: 5 },
};

export const FALLBACK_CENTER = { lat: 46.12, lon: 14.80, zoom: 9 };

export function getCountryCenter(geocodeCountry) {
  return COUNTRY_CENTER[geocodeCountry] || FALLBACK_CENTER;
}

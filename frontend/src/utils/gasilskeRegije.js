// Shared with InterventionsView.jsx and MapView.jsx, both of which can render the
// gasilska regija (fire-brigade region) outline overlay from
// GET /api/interventions/gasilske-regije (Slovenia only — see backend/data/gasilske_regije.geojson).
// Fixed order so each region gets a stable hue rather than one that shifts if the
// GeoJSON is rebuilt with features in a different order.
export const REGIJA_ORDER = [
  'Bela krajina', 'Celjska', 'Dolenjska', 'Gorenjska', 'Koroška', 'Ljubljana I',
  'Ljubljana II', 'Ljubljana III', 'Mariborska', 'Notranjska', 'Obalno-kraška',
  'Podravska', 'Pomurska', 'Posavska', 'Saša', 'Severno-primorska', 'Zasavska',
];

export function regijaColor(regija) {
  const i = REGIJA_ORDER.indexOf(regija);
  return `hsl(${i >= 0 ? (i * 360 / REGIJA_ORDER.length) : 0}, 65%, 55%)`;
}

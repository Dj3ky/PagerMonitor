import { useState } from 'react';

// Shared helpers for the Weather tab's Slovenia-specific station-map layers
// (ARSO weather stations, SMOK water levels) — auth fetch, basemap switching,
// and the "last updated" badge.

export const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const authHeaders = () => ({ Authorization: `Bearer ${tok()}` });

export async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const OSM_ATTR   = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CARTO_ATTR = `${OSM_ATTR} © <a href="https://carto.com/attributions">CARTO</a>`;

export const BASEMAPS = {
  streets: { label: 'Ceste', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: OSM_ATTR },
  dark:    { label: 'Temna',    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',  attr: CARTO_ATTR },
  light:   { label: 'Svetla',   url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', attr: CARTO_ATTR },
};

export function useBasemap(storageKey, defaultBasemap = 'dark') {
  return useState(
    () => (localStorage.getItem(storageKey) in BASEMAPS ? localStorage.getItem(storageKey) : defaultBasemap)
  );
}

export function fmtUpdatedAt(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return iso; }
}

// ── Basemap style switcher (Streets / Dark / Light) ─────────────────────────
export function BasemapSwitcher({ basemap, onChange }) {
  return (
    <div style={{
      position: 'absolute', top: '0.5rem', right: '0.5rem', zIndex: 1000,
      display: 'flex', gap: '0.2rem', padding: '0.2rem', borderRadius: '0.5rem',
      background: 'var(--bg-1)', border: '1px solid var(--border)', boxShadow: '0 1px 6px rgba(0,0,0,0.3)',
    }}>
      {Object.entries(BASEMAPS).map(([id, b]) => (
        <button key={id} onClick={() => onChange(id)} title={b.label} style={{
          padding: '0.2rem 0.5rem', borderRadius: '0.35rem', fontSize: '0.68rem', fontWeight: 500,
          cursor: 'pointer', border: 'none', whiteSpace: 'nowrap',
          background: basemap === id ? 'color-mix(in srgb, var(--accent-green) 16%, transparent)' : 'transparent',
          color: basemap === id ? 'var(--accent-green)' : 'var(--text-2)',
        }}>{b.label}</button>
      ))}
    </div>
  );
}

// ── Last-updated label ───────────────────────────────────────────────────────
// Bottom-left, not top-left — Leaflet's own zoom control (+/-) lives in the
// top-left corner by default, and a top-left overlay sits right on top of it.
export function LastUpdated({ updatedAt }) {
  if (!updatedAt) return null;
  return (
    <div style={{
      position: 'absolute', bottom: '0.5rem', left: '0.5rem', zIndex: 1000,
      padding: '0.3rem 0.55rem', borderRadius: '0.5rem', fontSize: '0.68rem',
      background: 'var(--bg-1)', border: '1px solid var(--border)', boxShadow: '0 1px 6px rgba(0,0,0,0.3)',
      color: 'var(--text-2)', whiteSpace: 'nowrap',
    }}>
      Posodobljeno {fmtUpdatedAt(updatedAt)}
    </div>
  );
}

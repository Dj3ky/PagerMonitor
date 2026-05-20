import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext();
const BASE = import.meta.env.VITE_BACKEND_URL || '';

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [token, setToken]     = useState(() => localStorage.getItem('pm_token') || null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [isPublic, setIsPublic]     = useState(false);  // public read-only mode

  useEffect(() => {
    async function verify() {
      // Check setup needed
      try {
        const r = await fetch(`${BASE}/auth/setup`);
        const d = await r.json();
        if (d.needsSetup) { setNeedsSetup(true); setLoading(false); return; }
      } catch (_) {}

      // Check if public mode is enabled
      try {
        const r = await fetch(`${BASE}/api/site-settings`);
        if (r.ok) {
          const d = await r.json();
          if (d.publicMode) {
            setIsPublic(true);
            // If no token, auto-enter as guest
            if (!token) {
              setUser({ username: 'guest', role: 'viewer', isGuest: true });
              setLoading(false);
              return;
            }
          }
        }
      } catch (_) {}

      // Validate existing token
      if (!token) { setLoading(false); return; }
      try {
        const r = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) { const d = await r.json(); setUser(d); }
        else { setToken(null); localStorage.removeItem('pm_token'); }
      } catch (_) { setToken(null); localStorage.removeItem('pm_token'); }
      setLoading(false);
    }
    verify();
  }, []);

  const login = useCallback(async (username, password) => {
    const r = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Login failed');
    localStorage.setItem('pm_token', d.token);
    setToken(d.token);
    setUser({ username: d.username, role: d.role });
    setNeedsSetup(false);
    setIsPublic(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch (_) {}
    localStorage.removeItem('pm_token');
    setToken(null);

    // If public mode is on, become guest again instead of showing login
    try {
      const r = await fetch(`${BASE}/api/site-settings`);
      if (r.ok) { const d = await r.json(); if (d.publicMode) { setUser({ username:'guest', role:'viewer', isGuest:true }); return; } }
    } catch (_) {}
    setUser(null);
  }, [token]);

  const authFetch = useCallback((path, opts = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(`${BASE}${path}`, { ...opts, headers });
  }, [token]);

  return (
    <AuthContext.Provider value={{ user, token, loading, needsSetup, isPublic, login, logout, authFetch, setNeedsSetup }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

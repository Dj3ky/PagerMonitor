const BASE = import.meta.env.VITE_BACKEND_URL || '';

function getToken() { return localStorage.getItem('pm_token') || ''; }

function authHeaders(extra = {}) {
  const t = getToken();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}), ...extra };
}

async function req(method, path, body, isAdmin = false) {
  const opts = { method, headers: authHeaders() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return r.json();
}

// ── Public API ────────────────────────────────────────────────────────────────
export const fetchHistory  = (limit = 200, before = 0) => req('GET', `/api/history?limit=${limit}${before ? `&before=${before}` : ''}`);
export const fetchSearch   = (q, limit = 100) => req('GET', `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
export const fetchStatus   = () => req('GET', '/api/status');
export const fetchAliases  = () => req('GET', '/api/aliases');
export const fetchGroups   = () => req('GET', '/api/groups');
export const fetchRules    = () => req('GET', '/api/rules');
export const saveAlias     = (capcode, body) => req('PUT',    `/api/aliases/${capcode}`, body);
export const deleteAlias   = (capcode)        => req('DELETE', `/api/aliases/${capcode}`, undefined);

// ── Admin API ─────────────────────────────────────────────────────────────────
const A = (method, path, body) => req(method, path, body, true);

export const adminFetchSystem       = () => A('GET', '/admin/system');
export const adminFetchSdrStatus    = () => A('GET', '/admin/sdr/status');
export const adminFetchSdrConfig    = () => A('GET', '/admin/sdr/config');
export const adminFetchSdrLogs      = () => A('GET', '/admin/sdr/logs');
export const adminFetchDbStats      = () => A('GET', '/admin/db/stats');
export const adminFetchNotifConfig  = () => A('GET', '/admin/notifications/config');
export const adminFetchNotifFilter  = () => A('GET', '/admin/notifications/filter');
export const adminFetchDedup        = () => A('GET', '/admin/dedup');
export const adminFetchRules        = () => A('GET', '/admin/rules');
export const adminFetchGroups       = () => A('GET', '/admin/groups');
export const adminFetchAliases      = () => A('GET', '/admin/aliases');

export const adminSdrStart        = ()    => A('POST', '/admin/sdr/start');
export const adminSdrStop         = ()    => A('POST', '/admin/sdr/stop');
export const adminSdrRestart      = ()    => A('POST', '/admin/sdr/restart');
export const adminSdrSetConfig    = cfg  => A('POST', '/admin/sdr/config', cfg);
export const adminPurgeDb         = days => A('DELETE', `/admin/db/purge?days=${days}`);
export const adminPurgeAll        = ()   => A('DELETE', '/admin/db/purge/all');
export const adminSetNotifConfig  = cfg  => A('PUT', '/admin/notifications/config', cfg);
export const adminSaveNotifFilter = cfg  => A('PUT', '/admin/notifications/filter', cfg);
export const adminTestNotif       = svc  => A('POST', `/admin/notifications/test/${svc}`);
export const adminSaveDedup       = cfg  => A('PUT', '/admin/dedup', cfg);
export const adminSaveRule        = rule => A('PUT', '/admin/rules', rule);
export const adminDeleteRule      = id   => A('DELETE', `/admin/rules/${id}`);
export const adminSaveGroup       = (id, body) => id ? A('PUT', `/admin/groups/${id}`, body) : A('POST', '/admin/groups', body);
export const adminDeleteGroup     = id   => A('DELETE', `/admin/groups/${id}`);
export const adminSaveAlias       = (capcode, body) => A('PUT', `/admin/aliases/${capcode}`, body);
export const adminDeleteAlias     = capcode => A('DELETE', `/admin/aliases/${capcode}`);

// Blob downloads (need auth header)
function authDownload(path, filename) {
  const t = getToken();
  return fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${t}` } })
    .then(r => r.blob())
    .then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    });
}
export const adminExportAliasesCsv  = () => authDownload('/admin/aliases/export', 'aliases.csv');
export const adminExportMessagesCsv = () => authDownload('/admin/db/export', `pagermonitor-${Date.now()}.csv`);

export const adminFetchUpdateStatus = () => A('GET', '/admin/update/status');

export const adminImportAliasesCsv = (csvText) => {
  const t = getToken();
  return fetch(`${BASE}/admin/aliases/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv', Authorization: `Bearer ${t}` },
    body: csvText,
  }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });
};

// Last-seen (per user, synced to server)
export const fetchMap            = (limit = 500, maxAgeDays = 30) => req('GET', `/api/map?limit=${limit}&maxAgeDays=${maxAgeDays}`);
export const saveMessageLocation = (id, lat, lng) => req('POST', `/api/messages/${id}/location`, { lat, lng });
export const fetchLastSeen  = () => req('GET', '/api/last-seen', undefined, true);
export const saveLastSeen   = (id) => req('POST', '/api/last-seen', { lastSeenId: id }, true);
export const authLogout     = () => req('POST', '/auth/logout', undefined, true);
export const authMe         = () => req('GET',  '/auth/me',     undefined, true);
export const authUsers      = () => A('GET',  '/auth/users');
export const authRegister   = (u, p, r, e) => A('POST', '/auth/register', { username:u, password:p, role:r, email:e });
export const authSetRole    = (id, role) => A('PUT',  `/auth/users/${id}/role`, { role });
export const authResetPw    = (id, pw)   => A('POST', `/auth/users/${id}/reset-password`, { password:pw });
export const authDeleteUser = (id)       => A('DELETE', `/auth/users/${id}`);
export const authChangePw   = (old_, new_) => A('POST', '/auth/change-password', { oldPassword:old_, newPassword:new_ });

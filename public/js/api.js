import { state } from './state.js';

export async function api(path, method = 'GET', data) {
  const options = {
    method,
    credentials: 'same-origin',
  };
  if (data !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(data);
  }
  const res = await fetch('/api' + path, options);
  let json;
  try {
    json = await res.json();
  } catch (e) {
    json = null;
  }
  if (res.status === 401) {
    state.currentUser = null;
    throw new Error(json?.error || 'Non authentifié');
  }
  if (res.status === 403 && json && json.error === 'No membership') {
    if (state.currentUser) {
      state.currentUser.needsGroup = true;
    }
    throw new Error('No membership');
  }
  if (res.status === 404 && path === '/context' && method === 'GET') {
    return null;
  }
  if (!res.ok) {
    throw new Error((json && json.error) || 'Erreur API');
  }
  return json;
}

export async function syncRehearsalsCache() {
  state.rehearsalsCache = await api('/rehearsals');
}

export function uploadSheetMusic(id, instrument, dataUrl) {
  return api(`/rehearsals/${id}`, 'PUT', { instrument, sheet: dataUrl });
}

export function deleteSheetMusic(id, instrument) {
  return api(`/rehearsals/${id}/sheet?instrument=${encodeURIComponent(instrument)}`, 'DELETE');
}

setInterval(() => {
  if (state.currentUser) {
    syncRehearsalsCache().catch(() => {});
  }
}, 5 * 60 * 1000);

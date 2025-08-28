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

export function listPartitions(songId) {
  return api(`/rehearsals/${songId}/partitions`);
}

export async function uploadPartition(songId, file, displayName) {
  const form = new FormData();
  form.append('file', file);
  if (displayName) {
    form.append('displayName', displayName);
  }
  const res = await fetch(`/api/rehearsals/${songId}/partitions`, {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
  });
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
  if (!res.ok) {
    throw new Error((json && json.error) || 'Erreur API');
  }
  return json;
}

export function deletePartition(songId, partitionId) {
  return api(`/rehearsals/${songId}/partitions/${partitionId}`, 'DELETE');
}

export async function syncRehearsalsCache() {
  const songs = await api('/rehearsals');
  const results = await Promise.allSettled(
    songs.map((song) => listPartitions(song.id)),
  );
  const withPartitions = [];
  results.forEach((result, idx) => {
    const song = songs[idx];
    if (result.status === 'fulfilled') {
      withPartitions.push({ ...song, partitions: result.value });
    } else {
      console.error(
        `Erreur lors de la récupération des partitions pour le morceau ${song.id}`,
        result.reason,
      );
    }
  });
  state.rehearsalsCache = withPartitions;
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

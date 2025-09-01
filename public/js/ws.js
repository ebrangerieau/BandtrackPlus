import { state } from './state.js';

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const port = (location.port ? parseInt(location.port, 10) : (proto === 'wss' ? 443 : 80)) + 1;
const ws = new WebSocket(`${proto}://${location.hostname}:${port}`);

ws.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    if (data.groupId && state.activeGroupId && data.groupId !== state.activeGroupId) {
      return;
    }
    switch (data.type) {
      case 'suggestion:new':
        state.suggestionsCache = state.suggestionsCache || [];
        state.suggestionsCache.push(data.suggestion);
        break;
      case 'suggestion:vote':
        const idx = state.suggestionsCache?.findIndex(s => s.id === data.suggestion.id);
        if (idx >= 0) {
          state.suggestionsCache[idx] = data.suggestion;
        }
        break;
      case 'rehearsal:new':
        state.rehearsalsCache.push(data.rehearsal);
        break;
      case 'rehearsal:update':
        const rIdx = state.rehearsalsCache.findIndex(r => r.id === data.rehearsal.id);
        if (rIdx >= 0) {
          state.rehearsalsCache[rIdx] = data.rehearsal;
        }
        break;
      default:
        break;
    }
  } catch (err) {
    console.error('WS message error', err);
  }
};

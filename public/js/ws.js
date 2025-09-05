import { state } from './state.js';

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const env = typeof process !== 'undefined' ? process.env || {} : {};

let wsUrl = window.WS_URL || env.WS_URL;
if (!wsUrl) {
  const basePort = location.port ? parseInt(location.port, 10) : (proto === 'wss' ? 443 : 80);
  const wsPort = window.WS_PORT || env.WS_PORT;
  const port = wsPort ? parseInt(wsPort, 10) : basePort + 1;
  wsUrl = `${proto}://${location.hostname}:${port}`;
}

let ws;
function connect() {
  ws = new WebSocket(wsUrl);

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

  ws.onerror = (err) => {
    console.error('WS connection error', err);
  };

  ws.onclose = (event) => {
    console.warn('WS connection closed, retrying in 5s', event);
    setTimeout(connect, 5000);
  };
}

connect();

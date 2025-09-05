import { state } from './state.js';
import { api } from './api.js';

export async function checkSession() {
  try {
    const user = await api('/me', 'GET', undefined, { silent401: true });
    if (!user) {
      state.currentUser = null;
      return;
    }
    state.currentUser = user;
    if (!user.needsGroup) {
      const settings = await api('/settings');
      applyTheme(settings.darkMode);
      applyTemplate(settings.template || 'classic');
      document.title = `${settings.groupName} – BandTrack`;
      const groupNameEl = document.getElementById('group-name');
      if (groupNameEl) groupNameEl.textContent = settings.groupName;
    }
  } catch (err) {
    console.debug('checkSession failed', err);
    state.currentUser = null;
  }
}

export function applyTheme(dark) {
  const body = document.body;
  if (dark) body.classList.add('dark');
  else body.classList.remove('dark');
}

export function applyTemplate(templateName) {
  const body = document.body;
  body.classList.forEach((cls) => {
    if (cls.startsWith('template-')) body.classList.remove(cls);
  });
  body.classList.add('template-' + templateName);
}

export async function handleLogout() {
  try {
    await api('/logout', 'POST');
    state.currentUser = null;
  } catch (err) {
    alert(err.message);
  }
}

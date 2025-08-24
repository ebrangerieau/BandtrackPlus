import { useEffect, useState } from 'react';
import { api } from './api.js';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/me')
      .then((u) => {
        setUser(u);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const login = async (username, password) => {
    await api('/login', 'POST', { username, password });
    const u = await api('/me');
    setUser(u);
  };

  const logout = async () => {
    await api('/logout', 'POST');
    setUser(null);
  };

  return { user, loading, login, logout };
}

import { useEffect, useState } from 'react';
import { api } from './api.js';

export function useSuggestions() {
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    api('/suggestions')
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, []);

  const addSuggestion = async (title) => {
    const newSug = await api('/suggestions', 'POST', { title });
    setSuggestions((prev) => [...prev, newSug]);
  };

  const vote = async (id, type) => {
    const updated = await api(`/suggestions/${id}/vote`, type === 'up' ? 'POST' : 'DELETE');
    setSuggestions((prev) => prev.map((s) => (s.id === id ? updated : s)));
  };

  return { suggestions, addSuggestion, vote };
}

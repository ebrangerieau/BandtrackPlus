import { useEffect, useState } from 'react';
import { api } from './api.js';

export function useRehearsals() {
  const [rehearsals, setRehearsals] = useState([]);

  useEffect(() => {
    api('/rehearsals')
      .then(setRehearsals)
      .catch(() => setRehearsals([]));
  }, []);

  return { rehearsals };
}

import React, { useEffect, useState } from 'react';
import api from '../api.js';

export default function Suggestions() {
  const [songs, setSongs] = useState([]);

  useEffect(() => {
    api('/suggestions').then(setSongs).catch(console.error);
  }, []);

  return (
    <div>
      <h1 className="text-xl mb-4">Suggestions</h1>
      <ul className="space-y-2">
        {songs.map((s) => (
          <li key={s.id} className="bg-white p-2 rounded shadow">
            {s.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

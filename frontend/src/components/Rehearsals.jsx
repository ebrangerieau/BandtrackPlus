import React, { useEffect, useState } from 'react';
import api from '../api.js';

export default function Rehearsals() {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    api('/rehearsals').then(setEvents).catch(console.error);
  }, []);

  return (
    <div>
      <h1 className="text-xl mb-4">Répétitions</h1>
      <ul className="space-y-2">
        {events.map((ev) => (
          <li key={ev.id} className="bg-white p-2 rounded shadow">
            <p className="font-semibold">{ev.date}</p>
            <p className="text-sm">{ev.location}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useState } from 'react';
import { useSuggestions } from '../hooks/useSuggestions.js';

export default function Suggestions() {
  const { suggestions, addSuggestion, vote } = useSuggestions();
  const [title, setTitle] = useState('');

  const handleAdd = (e) => {
    e.preventDefault();
    if (title.trim()) {
      addSuggestion(title.trim());
      setTitle('');
    }
  };

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-2">Suggestions</h2>
      <form onSubmit={handleAdd} className="flex gap-2 mb-4">
        <input
          className="flex-1 border p-2"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Titre du morceau"
        />
        <button type="submit" className="bg-green-600 text-white px-2">
          Ajouter
        </button>
      </form>
      <ul className="space-y-2">
        {suggestions.map((s) => (
          <li key={s.id} className="border p-2 flex justify-between items-center">
            <span>{s.title}</span>
            <span className="flex items-center gap-2">
              <button onClick={() => vote(s.id, 'up')}>👍</button>
              <button onClick={() => vote(s.id, 'down')}>👎</button>
              <span>❤️ {s.likes || 0}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

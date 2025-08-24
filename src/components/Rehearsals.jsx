import { useRehearsals } from '../hooks/useRehearsals.js';

export default function Rehearsals() {
  const { rehearsals } = useRehearsals();
  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-2">Répétitions</h2>
      <ul className="space-y-2">
        {rehearsals.map((r) => (
          <li key={r.id} className="border p-2">
            {r.title || r.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

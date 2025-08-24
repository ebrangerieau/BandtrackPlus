import { useState } from 'react';
import { useAuth } from './hooks/useAuth.js';
import LoginForm from './components/LoginForm.jsx';
import Suggestions from './components/Suggestions.jsx';
import Rehearsals from './components/Rehearsals.jsx';

export default function App() {
  const { user, loading, login, logout } = useAuth();
  const [page, setPage] = useState('suggestions');

  if (loading) {
    return <p className="p-4">Chargement...</p>;
  }

  if (!user) {
    return <LoginForm onLogin={login} />;
  }

  return (
    <div>
      <header className="p-4 flex justify-between items-center border-b">
        <span>Bonjour {user.username}</span>
        <nav className="flex gap-2">
          <button onClick={() => setPage('suggestions')} className="underline">
            Suggestions
          </button>
          <button onClick={() => setPage('rehearsals')} className="underline">
            Répétitions
          </button>
        </nav>
        <button onClick={logout} className="text-sm">Déconnexion</button>
      </header>
      {page === 'suggestions' && <Suggestions />}
      {page === 'rehearsals' && <Rehearsals />}
    </div>
  );
}

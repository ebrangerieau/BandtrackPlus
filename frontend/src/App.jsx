import React from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import Login from './components/Login.jsx';
import Suggestions from './components/Suggestions.jsx';
import Rehearsals from './components/Rehearsals.jsx';

function App() {
  return (
    <div className="p-4">
      <nav className="mb-4 flex gap-4">
        <Link className="text-blue-600" to="/login">Connexion</Link>
        <Link className="text-blue-600" to="/suggestions">Suggestions</Link>
        <Link className="text-blue-600" to="/rehearsals">Répétitions</Link>
      </nav>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/suggestions" element={<Suggestions />} />
        <Route path="/rehearsals" element={<Rehearsals />} />
        <Route path="*" element={<Login />} />
      </Routes>
    </div>
  );
}

export default App;

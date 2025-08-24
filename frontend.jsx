import React, { useEffect, useMemo, useRef, useState } from "react";
import "./src/tailwind.css";
import {
  Music,
  Calendar,
  Settings,
  Activity,
  Plus,
  ThumbsUp,
  ThumbsDown,
  Mic,
  MicOff,
  Sun,
  Moon,
  Users,
  Trash2,
  Pencil,
  ChevronRight,
  Play
} from "lucide-react";

// ——————————————————————————————————————————————
// BandTrack – Maquette Frontend (mobile-first)
// - Single-file React component, stateful UI (no backend)
// - Tailwind CSS for styling
// - lucide-react for icons
// - Modals for adds/edits; simple, guided flows
// - Dark mode toggle
// - Bottom navigation with 4 tabs
// ——————————————————————————————————————————————

// Utilitaires simples
function classNames(...arr) {
  return arr.filter(Boolean).join(" ");
}

function Modal({ open, onClose, title, children, actions }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-6">
      <div className="w-full sm:max-w-lg bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-full p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-4 max-h-[65vh] overflow-auto">{children}</div>
        {actions ? (
          <div className="px-5 py-4 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/40 flex gap-3 justify-end">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Chip({ children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full text-xs px-2 py-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
      {children}
    </span>
  );
}

function Progress({ value }) {
  const clamped = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="w-full h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
      <div
        className="h-full bg-black dark:bg-white"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="text-center p-10 sm:p-16">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="text-base font-semibold mb-1">{title}</h3>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">{children}</p>
      {action}
    </div>
  );
}

// Données seed (maquette)
const seedSuggestions = [
  { id: "s1", title: "Valerie (Amy Winehouse)", likes: 6, dislikes: 1, myVote: null },
  { id: "s2", title: "Come Together (The Beatles)", likes: 4, dislikes: 0, myVote: "up" },
  { id: "s3", title: "Zombie (The Cranberries)", likes: 2, dislikes: 2, myVote: null },
];

const seedRehearsals = [
  {
    id: "r1",
    title: "Valerie (Amy Winehouse)",
    myMastery: 6,
    notes: [
      { id: "n1", text: "Bosser le pont / respiration.", audioUrl: null, createdAt: Date.now() - 86400000 },
    ],
    groupStats: { avg: 58, votes: 4 },
  },
  {
    id: "r2",
    title: "Stand by Me (Ben E. King)",
    myMastery: 3,
    notes: [],
    groupStats: { avg: 40, votes: 3 },
  },
];

const seedConcerts = [
  {
    id: "c1",
    name: "Fête de la Musique – Place du Marché",
    date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString(), // +10j
    songs: ["Valerie (Amy Winehouse)", "Stand by Me (Ben E. King)", "Proud Mary"],
  },
  {
    id: "c2",
    name: "Pub Session – Le Blackbird",
    date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 20).toISOString(), // -20j
    songs: ["Valerie (Amy Winehouse)", "Come Together (The Beatles)"],
  },
];

const seedMembers = [
  { id: "m1", name: "Eric", role: "admin" },
  { id: "m2", name: "Anaïs", role: "membre" },
  { id: "m3", name: "Léo", role: "membre" },
];

export default function BandTrackUI() {
  const [active, setActive] = useState("morceaux"); // morceaux | repetitions | prestations | parametres
  const [groupName, setGroupName] = useState("BandTrack – Mon Groupe");
  const [dark, setDark] = useState(false);
  const [logoUrl, setLogoUrl] = useState("");
  const [isAdmin, setIsAdmin] = useState(true); // maquette: admin actif

  const [suggestions, setSuggestions] = useState(seedSuggestions);
  const [rehearsals, setRehearsals] = useState(seedRehearsals);
  const [concerts, setConcerts] = useState(seedConcerts);
  const [members, setMembers] = useState(seedMembers);

  // Modals
  const [showAddSuggestion, setShowAddSuggestion] = useState(false);
  const [showAddConcert, setShowAddConcert] = useState(false);
  const [showNoteFor, setShowNoteFor] = useState(null); // rehearsal id
  const [showMoveToRehearsal, setShowMoveToRehearsal] = useState(null); // suggestion id
  const [editLogoOpen, setEditLogoOpen] = useState(false);

  useEffect(() => {
    if (dark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [dark]);

  const sortedSuggestions = useMemo(() => {
    return [...suggestions].sort((a, b) => (b.likes - b.dislikes) - (a.likes - a.dislikes));
  }, [suggestions]);

  function voteOnSuggestion(id, type) {
    setSuggestions(prev => prev.map(s => {
      if (s.id !== id) return s;
      let { likes, dislikes, myVote } = s;
      if (type === "up") {
        if (myVote === "up") { likes--; myVote = null; }
        else {
          if (myVote === "down") dislikes--;
          likes++; myVote = "up";
        }
      } else {
        if (myVote === "down") { dislikes--; myVote = null; }
        else {
          if (myVote === "up") likes--;
          dislikes++; myVote = "down";
        }
      }
      return { ...s, likes: Math.max(0, likes), dislikes: Math.max(0, dislikes), myVote };
    }));
  }

  function addSuggestion(title) {
    const t = title.trim();
    if (!t) return;
    setSuggestions(prev => [{ id: `s${Date.now()}`, title: t, likes: 0, dislikes: 0, myVote: null }, ...prev]);
    setShowAddSuggestion(false);
  }

  function removeSuggestion(id) {
    setSuggestions(prev => prev.filter(s => s.id !== id));
  }

  function moveSuggestionToRehearsal(suggestionId) {
    const sug = suggestions.find(s => s.id === suggestionId);
    if (!sug) return;
    setRehearsals(prev => [
      { id: `r${Date.now()}`, title: sug.title, myMastery: 0, notes: [], groupStats: { avg: 0, votes: 0 } },
      ...prev,
    ]);
    setSuggestions(prev => prev.filter(s => s.id !== suggestionId));
    setShowMoveToRehearsal(null);
    setActive("repetitions");
  }

  function updateMyMastery(rehearsalId, value) {
    setRehearsals(prev => prev.map(r => r.id === rehearsalId ? { ...r, myMastery: value } : r));
  }

  function addNote(rehearsalId, note) {
    setRehearsals(prev => prev.map(r => r.id === rehearsalId ? { ...r, notes: [{ id: `n${Date.now()}`, ...note, createdAt: Date.now() }, ...r.notes] } : r));
    setShowNoteFor(null);
  }

  function deleteRehearsal(id) {
    setRehearsals(prev => prev.filter(r => r.id !== id));
  }

  function addConcert({ name, date, songIdsOrTitles }) {
    const songsList = songIdsOrTitles;
    setConcerts(prev => [{ id: `c${Date.now()}`, name: name.trim(), date, songs: songsList }, ...prev]);
    setShowAddConcert(false);
  }

  function deleteConcert(id) {
    setConcerts(prev => prev.filter(c => c.id !== id));
  }

  function toggleMemberRole(id) {
    setMembers(prev => prev.map(m => m.id === id ? { ...m, role: m.role === "admin" ? "membre" : "admin" } : m));
  }

  function removeMember(id) {
    setMembers(prev => prev.filter(m => m.id !== id));
  }

  function handleLogoFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setLogoUrl(reader.result);
    reader.readAsDataURL(file);
  }

  const now = Date.now();
  const upcoming = concerts.filter(c => new Date(c.date).getTime() >= now).sort((a,b)=>new Date(a.date)-new Date(b.date));
  const past = concerts.filter(c => new Date(c.date).getTime() < now).sort((a,b)=>new Date(b.date)-new Date(a.date));

  return (
    <div className={classNames("min-h-screen flex flex-col bg-white text-zinc-900", dark && "dark bg-zinc-950 text-zinc-100")}>      
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto max-w-screen-sm px-4 py-3 flex items-center gap-3">
          {logoUrl ? (
            <img src={logoUrl} alt="Logo" className="h-8 w-8 rounded-lg object-cover" />
          ) : (
            <div className="h-8 w-8 rounded-lg bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center">
              <Music className="h-5 w-5" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold truncate">{groupName}</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">BandTrack</p>
          </div>
          <button
            onClick={() => setDark(!dark)}
            className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 inline-flex items-center gap-2"
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} {dark ? "Clair" : "Sombre"}
          </button>
        </div>
      </header>

      {/* Contenu */}
      <main className="flex-1 mx-auto w-full max-w-screen-sm px-4 pb-24 pt-4 sm:pb-4">
        {active === "morceaux" && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Morceaux proposés</h2>
              <button
                onClick={() => setShowAddSuggestion(true)}
                className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <Plus className="h-4 w-4" /> Proposer
              </button>
            </div>

            {sortedSuggestions.length === 0 ? (
              <EmptyState
                icon={Music}
                title="Aucun titre proposé pour l’instant"
                action={
                  <button onClick={()=>setShowAddSuggestion(true)} className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800">
                    Ajouter un morceau
                  </button>
                }
              >
                Lance la machine à idées : propose un premier morceau, les votes feront le tri.
              </EmptyState>
            ) : (
              <ul className="space-y-3">
                {sortedSuggestions.map(s => (
                  <li key={s.id} className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{s.title}</p>
                        <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                          <Chip>Score {(s.likes - s.dislikes) >= 0 ? "+" : ""}{s.likes - s.dislikes}</Chip>
                          <Chip><ThumbsUp className="h-3 w-3" /> {s.likes}</Chip>
                          <Chip><ThumbsDown className="h-3 w-3" /> {s.dislikes}</Chip>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          aria-label="J’aime"
                          onClick={() => voteOnSuggestion(s.id, "up")}
                          className={classNames(
                            "rounded-xl p-2 border hover:bg-zinc-50 dark:hover:bg-zinc-900",
                            s.myVote === "up" ? "border-black dark:border-white" : "border-zinc-200 dark:border-zinc-800"
                          )}
                        >
                          <ThumbsUp className="h-4 w-4" />
                        </button>
                        <button
                          aria-label="Je n’aime pas"
                          onClick={() => voteOnSuggestion(s.id, "down")}
                          className={classNames(
                            "rounded-xl p-2 border hover:bg-zinc-50 dark:hover:bg-zinc-900",
                            s.myVote === "down" ? "border-black dark:border-white" : "border-zinc-200 dark:border-zinc-800"
                          )}
                        >
                          <ThumbsDown className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setShowMoveToRehearsal(s.id)}
                          className="ml-1 rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900"
                        >
                          Travailler
                        </button>
                        {isAdmin && (
                          <button
                            onClick={() => removeSuggestion(s.id)}
                            className="ml-1 rounded-xl p-2 border border-zinc-200 dark:border-zinc-800 hover:bg-red-50 dark:hover:bg-red-900/30"
                            aria-label="Supprimer"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {active === "repetitions" && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Répétitions</h2>
              <p className="text-xs text-zinc-500">Évalue, note, progresse.</p>
            </div>

            {rehearsals.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="Rien à travailler pour l’instant"
                action={<button onClick={()=>setActive("morceaux")} className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800">Choisir depuis les propositions</button>}
              >
                Passe dans « Morceaux » pour sélectionner ce que le groupe veut bosser.
              </EmptyState>
            ) : (
              <ul className="space-y-3">
                {rehearsals.map(r => (
                  <li key={r.id} className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{r.title}</p>
                        <div className="mt-2 space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span>Maîtrise perso : {r.myMastery}/10</span>
                            <span className="text-zinc-500">Moyenne groupe : {Math.round(r.groupStats.avg/10)}/10 · {r.groupStats.votes} retours</span>
                          </div>
                          <Progress value={(r.myMastery/10)*100} />
                          <div className="flex items-center gap-2 text-xs mt-1">
                            <Chip>Anonyme: synthèse visible par tous</Chip>
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => setShowNoteFor(r.id)}
                        className="rounded-xl p-2 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900"
                        title="Ajouter une note"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {isAdmin && (
                        <button
                          onClick={() => deleteRehearsal(r.id)}
                          className="rounded-xl p-2 border border-zinc-200 dark:border-zinc-800 hover:bg-red-50 dark:hover:bg-red-900/30"
                          aria-label="Supprimer"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>

                    {/* Slider de maîtrise simple */}
                    <div className="mt-3">
                      <input
                        type="range"
                        min={0}
                        max={10}
                        value={r.myMastery}
                        onChange={(e)=>updateMyMastery(r.id, Number(e.target.value))}
                        className="w-full"
                      />
                    </div>

                    {/* Notes */}
                    {r.notes.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {r.notes.map(n => (
                          <div key={n.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-sm leading-snug">{n.text}</p>
                              <span className="text-xs text-zinc-500">{new Date(n.createdAt).toLocaleDateString()}</span>
                            </div>
                            {n.audioUrl && (
                              <div className="mt-2">
                                <audio controls src={n.audioUrl} className="w-full" />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {active === "prestations" && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Prestations</h2>
              <button
                onClick={() => setShowAddConcert(true)}
                className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <Plus className="h-4 w-4" /> Ajouter
              </button>
            </div>

            {/* À venir */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 mb-2">À venir</h3>
              {upcoming.length === 0 ? (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">
                  Rien de programmé.
                </div>
              ) : (
                <ul className="space-y-3">
                  {upcoming.map(c => (
                    <li key={c.id} className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-3">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{c.name}</p>
                          <p className="text-xs text-zinc-500">{new Date(c.date).toLocaleString()}</p>
                        </div>
                        {isAdmin && (
                          <button
                            onClick={() => deleteConcert(c.id)}
                            className="rounded-xl p-2 border border-zinc-200 dark:border-zinc-800 hover:bg-red-50 dark:hover:bg-red-900/30"
                            aria-label="Supprimer"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                        <ChevronRight className="h-5 w-5 text-zinc-400" />
                      </div>
                      <div className="mt-3">
                        <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2"><Play className="h-3 w-3"/> Setlist</div>
                        <ul className="text-sm list-disc pl-5 space-y-1">
                          {c.songs.map((s, idx) => (
                            <li key={idx}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Passées */}
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 mb-2">Passées</h3>
              {past.length === 0 ? (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">
                  Aucune prestation passée pour le moment.
                </div>
              ) : (
                <ul className="space-y-3">
                  {past.map(c => (
                    <li key={c.id} className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-3">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{c.name}</p>
                          <p className="text-xs text-zinc-500">{new Date(c.date).toLocaleString()}</p>
                        </div>
                        {isAdmin && (
                          <button
                            onClick={() => deleteConcert(c.id)}
                            className="rounded-xl p-2 border border-zinc-200 dark:border-zinc-800 hover:bg-red-50 dark:hover:bg-red-900/30"
                            aria-label="Supprimer"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                        <ChevronRight className="h-5 w-5 text-zinc-400" />
                      </div>
                      <div className="mt-3">
                        <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2"><Play className="h-3 w-3"/> Setlist jouée</div>
                        <ul className="text-sm list-disc pl-5 space-y-1">
                          {c.songs.map((s, idx) => (
                            <li key={idx}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {active === "parametres" && (
          <section className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold mb-3">Paramètres</h2>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-200 dark:divide-zinc-800 overflow-hidden">
                {/* Nom du groupe */}
                <div className="p-4 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">Nom du groupe</p>
                    <p className="text-xs text-zinc-500">Affiché dans l’en-tête.</p>
                  </div>
                  <input
                    className="w-[60%] sm:w-[50%] rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm"
                    value={groupName}
                    onChange={(e)=>setGroupName(e.target.value)}
                  />
                </div>

                {/* Logo */}
                <div className="p-4 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">Logo du groupe</p>
                    <p className="text-xs text-zinc-500">Affiché à gauche du titre.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {logoUrl ? (
                      <img src={logoUrl} alt="Logo" className="h-8 w-8 rounded-lg object-cover" />
                    ) : (
                      <div className="h-8 w-8 rounded-lg bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center">
                        <Music className="h-4 w-4" />
                      </div>
                    )}
                    <button
                      onClick={()=>setEditLogoOpen(true)}
                      className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800"
                    >
                      Modifier
                    </button>
                  </div>
                </div>

                {/* Apparence */}
                <div className="p-4 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">Apparence</p>
                    <p className="text-xs text-zinc-500">Mode clair / sombre selon préférence.</p>
                  </div>
                  <button
                    onClick={()=>setDark(!dark)}
                    className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800 inline-flex items-center gap-2"
                  >
                    {dark ? <Sun className="h-4 w-4"/> : <Moon className="h-4 w-4"/>}
                    {dark ? "Passer en clair" : "Passer en sombre"}
                  </button>
                </div>
              </div>
            </div>

            {/* Gestion des membres (admin) */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Users className="h-4 w-4"/>
                <h3 className="text-base font-semibold">Membres & rôles</h3>
                {isAdmin ? <Chip>Admin</Chip> : <Chip>Membre</Chip>}
              </div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-200 dark:divide-zinc-800 overflow-hidden">
                {members.map(m => (
                  <div key={m.id} className="p-4 flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center font-medium">
                      {m.name.slice(0,1)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{m.name}</p>
                      <p className="text-xs text-zinc-500">{m.role === "admin" ? "Administrateur" : "Membre"}</p>
                    </div>
                    {isAdmin && (
                      <>
                        <button
                          onClick={()=>toggleMemberRole(m.id)}
                          className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800"
                        >
                          {m.role === "admin" ? "Rendre membre" : "Rendre admin"}
                        </button>
                        <button
                          onClick={()=>removeMember(m.id)}
                          className="rounded-xl p-2 border border-zinc-200 dark:border-zinc-800 hover:bg-red-50 dark:hover:bg-red-900/30"
                          aria-label="Retirer"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
                {members.length === 0 && (
                  <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">Aucun membre.</div>
                )}
              </div>
              <p className="text-xs text-zinc-500 mt-2">Les retours et niveaux affichés dans « Répétitions » sont agrégés et anonymisés.</p>
            </div>
          </section>
        )}
      </main>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 inset-x-0 z-40 border-t border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto max-w-screen-sm grid grid-cols-4">
          <TabButton icon={Music} label="Morceaux" active={active === "morceaux"} onClick={()=>setActive("morceaux")} />
          <TabButton icon={Activity} label="Répétitions" active={active === "repetitions"} onClick={()=>setActive("repetitions")} />
          <TabButton icon={Calendar} label="Prestations" active={active === "prestations"} onClick={()=>setActive("prestations")} />
          <TabButton icon={Settings} label="Paramètres" active={active === "parametres"} onClick={()=>setActive("parametres")} />
        </div>
      </nav>

      {/* Modals */}
      <Modal
        open={showAddSuggestion}
        onClose={()=>setShowAddSuggestion(false)}
        title="Proposer un morceau"
        actions={
          <>
            <button onClick={()=>setShowAddSuggestion(false)} className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800">Annuler</button>
            <button onClick={()=>addSuggestion(document.getElementById('newSuggestionTitle').value)} className="rounded-xl px-3 py-2 text-sm border border-zinc-900 dark:border-white bg-zinc-900 text-white dark:bg-white dark:text-black">Ajouter</button>
          </>
        }
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">Saisis le titre tel qu’il apparaît sur vos partitions, Setlist.fm ou Spotify.</p>
        <label className="text-sm font-medium">Titre du morceau</label>
        <input id="newSuggestionTitle" placeholder="Ex : Valerie (Amy Winehouse)" className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm" />
      </Modal>

      <Modal
        open={!!showMoveToRehearsal}
        onClose={()=>setShowMoveToRehearsal(null)}
        title="Passer en travail de répétition"
        actions={
          <>
            <button onClick={()=>setShowMoveToRehearsal(null)} className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800">Annuler</button>
            <button onClick={()=>moveSuggestionToRehearsal(showMoveToRehearsal)} className="rounded-xl px-3 py-2 text-sm border border-zinc-900 dark:border-white bg-zinc-900 text-white dark:bg-white dark:text-black">Confirmer</button>
          </>
        }
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Le morceau sera ajouté dans « Répétitions ». Chacun pourra y noter sa maîtrise et ajouter des notes.</p>
      </Modal>

      <AddNoteModal
        open={!!showNoteFor}
        onClose={()=>setShowNoteFor(null)}
        onSave={(note)=> addNote(showNoteFor, note)}
      />

      <AddConcertModal
        open={showAddConcert}
        onClose={()=>setShowAddConcert(false)}
        onSave={addConcert}
        pool={[...new Set([ ...rehearsals.map(r=>r.title), ...suggestions.map(s=>s.title) ])]}
      />

      <EditLogoModal
        open={editLogoOpen}
        onClose={()=>setEditLogoOpen(false)}
        logoUrl={logoUrl}
        setLogoUrl={setLogoUrl}
        onPickFile={handleLogoFile}
      />
    </div>
  );
}

function TabButton({ icon: Icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={classNames(
        "flex flex-col items-center justify-center py-2 text-xs", 
        active ? "text-black dark:text-white" : "text-zinc-500"
      )}
    >
      <Icon className="h-5 w-5" />
      <span className="mt-1">{label}</span>
    </button>
  );
}

function AddNoteModal({ open, onClose, onSave }) {
  const [text, setText] = useState("");
  const [audioUrl, setAudioUrl] = useState("");

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setAudioUrl(url);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ajouter une note"
      actions={
        <>
          <button onClick={onClose} className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800">Annuler</button>
          <button
            onClick={() => { onSave({ text: text.trim(), audioUrl: audioUrl || null }); setText(""); setAudioUrl(""); }}
            className="rounded-xl px-3 py-2 text-sm border border-zinc-900 dark:border-white bg-zinc-900 text-white dark:bg-white dark:text-black"
          >
            Enregistrer
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">Note textuelle</label>
          <textarea
            value={text}
            onChange={(e)=>setText(e.target.value)}
            rows={4}
            placeholder="Impressions, points à travailler, doigtés, phrasés…"
            className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Note audio (optionnel)</label>
          <input type="file" accept="audio/*" capture="microphone" onChange={handleFile} className="mt-1 w-full text-sm" />
          {audioUrl && (
            <div className="mt-2">
              <audio controls src={audioUrl} className="w-full" />
            </div>
          )}
          <p className="text-xs text-zinc-500 mt-1">Sur smartphone, tu peux enregistrer directement depuis le micro.</p>
        </div>
      </div>
    </Modal>
  );
}

function AddConcertModal({ open, onClose, onSave, pool }) {
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [selected, setSelected] = useState({});

  useEffect(()=>{ if(!open){ setName(""); setDate(""); setSelected({}); } }, [open]);

  function toggleSong(title) {
    setSelected(prev => ({ ...prev, [title]: !prev[title] }));
  }

  function submit() {
    const list = Object.entries(selected).filter(([,v])=>v).map(([k])=>k);
    if (!name.trim() || !date) return;
    onSave({ name, date: new Date(date).toISOString(), songIdsOrTitles: list });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ajouter une prestation"
      actions={
        <>
          <button onClick={onClose} className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800">Annuler</button>
          <button onClick={submit} className="rounded-xl px-3 py-2 text-sm border border-zinc-900 dark:border-white bg-zinc-900 text-white dark:bg-white dark:text-black">Créer</button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">Nom de l’évènement</label>
          <input value={name} onChange={(e)=>setName(e.target.value)} placeholder="Ex : Concert au Blackbird" className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm"/>
        </div>
        <div>
          <label className="text-sm font-medium">Date & heure</label>
          <input type="datetime-local" value={date} onChange={(e)=>setDate(e.target.value)} className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm"/>
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">Morceaux (setlist)</label>
          <div className="max-h-40 overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-200 dark:divide-zinc-800">
            {pool.length === 0 ? (
              <div className="p-3 text-sm text-zinc-500">Aucun morceau dans la liste.</div>
            ) : (
              pool.map(title => (
                <label key={title} className="p-3 flex items-center gap-3">
                  <input type="checkbox" checked={!!selected[title]} onChange={()=>toggleSong(title)} />
                  <span className="text-sm">{title}</span>
                </label>
              ))
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-1">Tu peux construire la setlist dès maintenant, et l’ajuster plus tard.</p>
        </div>
      </div>
    </Modal>
  );
}

function EditLogoModal({ open, onClose, logoUrl, setLogoUrl, onPickFile }) {
  const [url, setUrl] = useState("");
  useEffect(()=>{ if(open) setUrl(logoUrl || ""); }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Modifier le logo"
      actions={
        <>
          <button onClick={onClose} className="rounded-xl px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-800">Fermer</button>
          <button onClick={()=>{ setLogoUrl(url.trim()); onClose(); }} className="rounded-xl px-3 py-2 text-sm border border-zinc-900 dark:border-white bg-zinc-900 text-white dark:bg-white dark:text-black">Enregistrer</button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">Depuis une URL</label>
          <input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://…/logo.png" className="mt-1 w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm"/>
        </div>
        <div>
          <label className="text-sm font-medium">Depuis un fichier</label>
          <input type="file" accept="image/*" onChange={(e)=>onPickFile(e.target.files?.[0])} className="mt-1 w-full text-sm" />
          <p className="text-xs text-zinc-500 mt-1">Les images carrées rendent mieux (ex : 512×512).</p>
        </div>
      </div>
    </Modal>
  );
}

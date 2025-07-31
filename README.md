# BandTrack

BandTrack est une application de suivi musical. Le dossier inclut un document 
**CCFv2.pdf** qui décrit le cahier des charges fonctionnel du projet. L'interface 
web fonctionne comme une Progressive Web App monopage et communique avec un 
serveur Node.js via une API REST.

## Fonctions principales
- Authentification des utilisateurs
- Suggestions de morceaux
  - Les utilisateurs peuvent voter pour ou retirer leur vote sur une suggestion
    via les boutons "👍" et "👎". Le compteur global est incrémenté ou
    décrémenté mais ne peut jamais devenir inférieur au nombre de likes
    ajoutés par l'utilisateur lui‑même.
  - Les suggestions peuvent être modifiées par leur auteur ou un administrateur.
- Suivi des répétitions
- Conversion suggestions \<-> répétitions
- Gestion des prestations
- Paramètres du groupe (nom, mode sombre)
- Écran d'accueil (rubrique « Accueil » dans la barre de navigation) indiquant
  la prochaine prestation et la date de la prochaine répétition

Pour démarrer le serveur localement:
```bash
npm install
npm start
```

### Endpoints ajoutés

- `POST /api/suggestions/:id/to-rehearsal` – déplacer une suggestion dans les répétitions.
- `POST /api/rehearsals/:id/to-suggestion` – remettre un morceau de répétition dans la liste J’aime.
- `GET /api/settings` renvoie maintenant aussi `nextRehearsalDate` et `nextRehearsalLocation` pour afficher
  la prochaine répétition sur la page d'accueil.

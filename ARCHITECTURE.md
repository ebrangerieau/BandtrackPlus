ARCHITECTURE
BandTrack est une application de suivi musical fonctionnant comme une Progressive Web App (PWA).
Elle combine un serveur Python minimaliste utilisant uniquement la bibliothèque standard et une interface
web monopage développée en JavaScript.

Vue d’ensemble
/
├── server.py               # Serveur HTTP + API REST en Python pur
├── public/                 # Code client (PWA) et fichiers statiques
├── scripts/                # Scripts de migration de schéma SQLite
├── tests/                  # Tests d’intégration Python (pytest)
├── Dockerfile, docker-compose.yml
├── package.json            # Configuration Node.js pour Tailwind CSS
└── src/                    # Sources CSS avant compilation
Backend Python (server.py)
Serveur basé sur http.server avec classe BandTrackHandler.

Routes API sous le préfixe /api ; les autres chemins servent les fichiers de public/.

Gestion de session via cookie session_id stocké en base (table sessions).

Authentification :

création de compte (/api/register) ;

connexion/déconnexion (/api/login, /api/logout);

changement de mot de passe et WebAuthn.

Fonctionnalités principales :

suggestions de morceaux (/suggestions);

répétitions (/rehearsals);

prestations (/performances);

événements de répétition (/rehearsal-events);

gestion des groupes et des membres.

Réponses JSON ; prise en charge optionnelle de GZip.

Toutes les requêtes modifiant les données exigent un utilisateur authentifié et un groupe actif.

Base de données SQLite
Création automatique du fichier bandtrack.db.
Tables principales :

Table	Rôle principal
users	Utilisateurs, rôle (admin/modérateur), hash de mot de passe, dernier groupe
users_webauthn	Association identifiants WebAuthn / utilisateurs
groups	Groupes musicaux ; propriétaire, code d’invitation, logo
memberships	Lien utilisateur ↔ groupe, rôle, surnom, statut
suggestions	Propositions de chansons (likes, auteur, URL, groupe)
suggestion_votes	Votes individuels pour les suggestions
rehearsals	Suivi des morceaux à répéter (niveaux, notes, audio-notes)
performances	Prestations (nom, date, lieu, chansons)
rehearsal_events	Occurrences de répétition (date, lieu)
settings	Paramètres par groupe : nom, thème sombre, modèle d’UI
sessions	Sessions actives (token, utilisateur, expiration)
logs	Journalisation des actions importantes
Des scripts de migration (scripts/) permettent d’adapter les anciennes bases de données
sans dépendance à Node.js.

Frontend (public/)
Application monopage (app.js) écrite en JavaScript :

appels à l’API avec fetch et credentials: "same-origin";

gestion du cache local pour limiter les requêtes réseau ;

navigation interne et logique de vues (suggestions, répétitions, prestations, agenda).

service-worker.js et manifest.json pour l’installation comme PWA et le mode hors ligne.

Fichiers images et CSS compilés (tailwind.css, style.css).

Construction CSS (src/, tailwind.config.js)
Le CSS est écrit dans src/tailwind.css.

La compilation vers public/tailwind.css se fait via tailwindcss (script npm run build:css).

package.json ne contient que Tailwind comme dépendance, aucun runtime Node n’est requis pour le serveur.

Tests (tests/)
Utilisent pytest.

Créent un serveur en mémoire et vérifient les endpoints :

authentification et gestion de session ;

CRUD suggestions/répétitions ;

paramètres, groupes, permissions…

Les tests n’ont pas besoin d’environnement Node.

Déploiement & maintenance
Docker : Dockerfile et docker-compose.yml permettent un déploiement simple.

Variables d’environnement : HOST, PORT, SSL_KEY, SSL_CERT, ORIGIN…

Lors du démarrage, server.py exécute automatiquement les scripts de migration.

Sauvegarde : backup.sh copie bandtrack.db et les éventuels fichiers audio dans backups/DATE.

Réinitialisation : reset-db.sh supprime la base puis recrée les tables.

Le serveur s’exécute simplement via :

python3 server.py --port 8080
Flux global
L’utilisateur accède à l’application via index.html (PWA).

Les actions de l’interface déclenchent des requêtes AJAX (fetch) vers /api/....

BandTrackHandler traite la requête :

vérifie la session,

exécute l’opération sur SQLite,

renvoie une réponse JSON.

Le client met à jour l’interface selon la réponse.

Les ressources statiques (HTML, JS, images) sont servies par le même serveur.


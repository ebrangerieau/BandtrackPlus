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
SSL_KEY=certs/key.pem SSL_CERT=certs/cert.pem npm start
```

### HTTPS

Le serveur écoute uniquement en HTTPS et nécessite un certificat SSL.
Pour le développement, un certificat auto-signé peut être créé avec :

```bash
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 365 -subj "/CN=localhost"
```

Les chemins vers la clé privée et le certificat sont fournis via les
variables d'environnement `SSL_KEY` et `SSL_CERT` (voir l'exemple de
lancement ci-dessus). En production, utilisez un certificat valide
(Let's Encrypt, etc.) et ajustez ces variables ainsi que `ORIGIN` pour
correspondre au domaine de déploiement.

### Sessions persistantes

Les sessions Express utilisent le module `connect-sqlite3` et sont
enregistrées dans le fichier `bandtrack.db`. Aucune configuration
supplémentaire n'est nécessaire : la table `sessions` est créée
automatiquement au démarrage du serveur.

### Serveur Python

Une implémentation équivalente du backend est également fournie en Python. Elle se
lance simplement avec la commande :

```bash
python3 server.py --port 3000
```

Contrairement à la version Node.js, ce serveur ne dépend d'aucun module
externe : il s'appuie uniquement sur la bibliothèque standard de Python et
crée automatiquement la base de données au premier lancement. Les points
d'accès REST restent identiques au serveur Node.js.

### Progressive Web App

Un fichier `manifest.json` et un `service-worker.js` ont été ajoutés dans le
dossier `public`. Le service worker met en cache les fichiers statiques afin de
permettre l'installation de l'application et son fonctionnement hors ligne.

### Endpoints ajoutés

- `POST /api/suggestions/:id/to-rehearsal` – déplacer une suggestion dans les répétitions.
- `POST /api/rehearsals/:id/to-suggestion` – remettre un morceau de répétition dans la liste J’aime.
- `GET /api/settings` renvoie maintenant aussi `nextRehearsalDate` et `nextRehearsalLocation` pour afficher
  la prochaine répétition sur la page d'accueil.

Les serveurs Node.js et Python gèrent tous deux ces champs et mettent à jour
automatiquement les anciennes bases de données au démarrage.

### Métriques serveur

Un middleware Express enregistre la latence de chaque requête et le nombre
d'erreurs (codes ≥ 400). Ces données sont conservées en mémoire depuis la
dernière réinitialisation.

- `GET /api/metrics` *(administrateur)* – retourne `totalRequests`,
  `averageLatency` (ms), `errorRate` et `lastReset`.
- `DELETE /api/metrics` *(administrateur)* – remet à zéro tous les compteurs.

Les métriques sont également réinitialisées lors du redémarrage du serveur.

### Migration vers la gestion multi‑groupe

Les bases de données créées avant l'introduction des groupes ne possèdent pas
les tables `groups` et `memberships`. Au démarrage, le serveur vérifie leur
présence et lance automatiquement une migration le cas échéant :

1. création d'un groupe par défaut (ID 1) ;
2. ajout de tous les utilisateurs comme membres de ce groupe ;
3. mise à jour des tables de contenu pour inclure un champ `group_id`.

La migration peut également être exécutée manuellement :

```bash
node scripts/migrate_to_multigroup.js
# ou
python3 scripts/migrate_to_multigroup.py
```

### Sauvegardes et restauration

Un script `backup.sh` crée une copie de la base `bandtrack.db` et du dossier `audios/` dans `backups/DATE` où `DATE` est un horodatage `YYYYMMDD_HHMMSS`.
Les `MAX_BACKUPS` dernières sauvegardes seulement sont conservées (7 par défaut).

```bash
./backup.sh            # créer une sauvegarde
MAX_BACKUPS=10 ./backup.sh  # conserver 10 sauvegardes
```

Pour restaurer une sauvegarde :

1. Arrêter le serveur.
2. Copier les fichiers depuis le dossier voulu :
   ```bash
   cp backups/DATE/bandtrack.db .
   rm -rf audios
   cp -r backups/DATE/audios audios
   ```
3. Redémarrer le serveur.

BandTrack est une application de suivi musical. L'interface web fonctionne
comme une Progressive Web App monopage et communique avec un backend Python
minimaliste via une API REST.

## Fonctions principales

- Authentification des utilisateurs
- Suggestions de morceaux (votes, édition par auteur ou admin)
- Suivi des répétitions
- Conversion suggestions ↔ répétitions
- Gestion des prestations (avec date et heure)
- Paramètres du groupe (nom, mode sombre activé par défaut)
- Les administrateurs peuvent gérer les membres via l'API (`POST /api/groups/<id>/members` pour ajouter, `DELETE /api/groups/<id>/members` en fournissant `id` ou `userId` pour supprimer)
- Écran d'accueil indiquant la prochaine prestation et la date de la prochaine
  répétition

## Documentation

- [Guide utilisateur](docs/guide_utilisateur.md)

## Déploiement avec Docker

### Générer des certificats SSL

```bash
mkdir -p certs
openssl req -x509 -nodes -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -subj "/CN=localhost"
```

### Construire l'image

```bash
docker build -t bandtrack .
```

### Démarrer avec `docker run`

```bash
docker run --rm -p 8080:8080 \
  -v "$(pwd)/certs:/certs:ro" \
  -e HOST=0.0.0.0 -e PORT=8080 \
  -e SSL_KEY=/certs/key.pem -e SSL_CERT=/certs/cert.pem \
  -e ORIGIN=https://localhost:8080 \
  bandtrack
```

### Démarrer avec `docker compose`

```bash
docker compose up --build
```

Les variables d'environnement peuvent aussi être définies dans `docker-compose.yml`.

Lors du démarrage du conteneur, `server.py` exécute automatiquement les
scripts de migration Python présents dans le dossier `scripts/`
(`migrate_to_multigroup.py`, `migrate_performance_location.py`,
`migrate_suggestion_votes.py`). Ils assurent la compatibilité des anciennes
bases de données sans dépendance à Node.js.

### Exécution locale sans Docker

```bash
python3 server.py --port 8080
```

Le serveur utilise uniquement la bibliothèque standard de Python et crée la
base SQLite `bandtrack.db` au premier lancement.

## Tests

Les tests automatisés ciblent uniquement la version Python et peuvent être exécutés dans le conteneur :

```bash
pytest
```

Aucun environnement Node.js n'est nécessaire.

## Réinitialiser la base de données

```bash
./reset-db.sh
```

Le script supprime `bandtrack.db` puis recrée les tables et applique les
migrations nécessaires.

## Sauvegardes

Un script `backup.sh` copie la base et les éventuels fichiers audio dans
`backups/DATE`. Seules les `MAX_BACKUPS` dernières sauvegardes sont conservées
(7 par défaut).

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

## Progressive Web App

Le dossier `public` contient le `manifest.json` et le `service-worker.js`
permettant l'installation de l'application et un fonctionnement hors ligne.


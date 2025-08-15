BandTrack est une application de suivi musical. L'interface web fonctionne
comme une Progressive Web App monopage et communique avec un backend Python
minimaliste via une API REST.

## Fonctions principales

- Authentification des utilisateurs
- Suggestions de morceaux (votes, édition par auteur ou admin)
- Suivi des répétitions
- Conversion suggestions ↔ répétitions
- Gestion des prestations
- Paramètres du groupe (nom, mode sombre)
- Écran d'accueil indiquant la prochaine prestation et la date de la prochaine
  répétition

## Démarrage rapide avec Docker

```bash
docker compose up --build
```

L'image construit `server.py` et expose l'API sur le port `8080` par défaut.
Les variables d'environnement `HOST` et `PORT` peuvent être ajustées dans
`docker-compose.yml` ou passées à `docker run`.

### Exécution locale sans Docker

```bash
python3 server.py --port 8080
```

Le serveur utilise uniquement la bibliothèque standard de Python et crée la
base SQLite `bandtrack.db` au premier lancement.

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


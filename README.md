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
- Export du répertoire en PDF (`GET /api/repertoire.pdf`)
- Les administrateurs peuvent gérer les membres via l'API (`POST /api/groups/<id>/members` pour ajouter, `DELETE /api/groups/<id>/members` en fournissant `id` ou `userId` pour supprimer)
- Écran d'accueil indiquant la prochaine prestation et la date de la prochaine
  répétition

## Export en PDF

Un bouton "Exporter en PDF" dans la page des répétitions permet de télécharger le
répertoire des morceaux. Celui-ci appelle l'endpoint `GET /api/repertoire.pdf`
qui génère un document listant les titres et auteurs du groupe actif.

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

### Exécution locale sans Docker

Installer les dépendances (``reportlab`` pour l'export PDF) puis démarrer le serveur :

```bash
pip install -r requirements.txt
python3 main.py --port 8080
```

Le serveur initialise automatiquement les tables dans la base PostgreSQL configurée via `DATABASE_URL` ou les variables `DB_*`.

### Mot de passe administrateur

Lors du premier démarrage, un compte `admin` est créé. Définissez son mot de
passe via la variable d'environnement `ADMIN_PASSWORD` :

```bash
export ADMIN_PASSWORD="monsecret"
python3 main.py --port 8080
```

Si cette variable n'est pas fournie, l'application génère un mot de passe
aléatoire et l'affiche dans la sortie standard. Tant qu'aucun mot de passe
n'est défini, le serveur refuse de démarrer.

L'application utilise PostgreSQL (`DATABASE_URL` ou variables `DB_*`).
Installez la bibliothèque `psycopg2` :

```bash
pip install psycopg2-binary
```

### Cookies de session et HTTPS

Par défaut, le cookie de session reçoit l'attribut `Secure` uniquement si la
requête est effectuée en HTTPS (détection via les en-têtes `X-Forwarded-Proto`
ou `Forwarded`). Pour forcer cet attribut, définissez
`SESSION_COOKIE_SECURE=1`, utile si un proxy TLS ne transmet pas ces en-têtes.
En développement sans HTTPS, laissez cette variable non définie pour que le
cookie soit accepté par le navigateur.

### Installation en mode développement

Pour rendre le paquet `bandtrack` importable depuis n'importe quel
répertoire, installez le projet en mode editable :

```bash
pip install -e .
```

Cette commande crée un lien symbolique vers le code source local. Si le
projet n'est pas installé, ajoutez son chemin au `PYTHONPATH` :

```bash
export PYTHONPATH="$(pwd):$PYTHONPATH"
```

## Tests

Les tests automatisés ciblent uniquement la version Python. Installez d'abord les dépendances de test via l'extra `dev` puis exécutez-les dans le conteneur :

```bash
pip install .[dev]
pytest
```

Aucun environnement Node.js n'est nécessaire.

## Réinitialiser la base de données

```bash
./reset-db.sh
```

Le script réinitialise le schéma PostgreSQL `public` puis recrée les tables via `init_db`.

## Progressive Web App

Le dossier `public` contient le `manifest.json` et le `service-worker.js`
permettant l'installation de l'application et un fonctionnement hors ligne.


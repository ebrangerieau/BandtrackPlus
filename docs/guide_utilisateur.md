# Guide utilisateur

Ce guide décrit les opérations courantes dans BandTrack. Les exemples utilisent l'API HTTP exposée par le serveur (
`https://localhost:8080` par défaut) et supposent que vous êtes déjà connecté lorsque cela est nécessaire.

## Connexion et inscription

### Inscription
```bash
curl -X POST https://localhost:8080/api/register \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "secret"}'
```

### Connexion
```bash
curl -X POST https://localhost:8080/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "secret"}' \
  -c cookies.txt
```
La session est conservée dans `cookies.txt` pour les requêtes suivantes.

## Gestion des suggestions

### Lister les suggestions
```bash
curl https://localhost:8080/api/suggestions -b cookies.txt
```

### Proposer un morceau
```bash
curl -X POST https://localhost:8080/api/suggestions \
  -H "Content-Type: application/json" -b cookies.txt \
  -d '{"title": "Song", "author": "Composer"}'
```

### Voter pour une suggestion
```bash
curl -X POST https://localhost:8080/api/suggestions/1/vote -b cookies.txt
```

### Convertir en répétition
```bash
curl -X POST https://localhost:8080/api/suggestions/1/to-rehearsal -b cookies.txt
```

## Gestion des répétitions

### Lister les répétitions
```bash
curl https://localhost:8080/api/rehearsals -b cookies.txt
```

### Ajouter une répétition
```bash
curl -X POST https://localhost:8080/api/rehearsals \
  -H "Content-Type: application/json" -b cookies.txt \
  -d '{"title": "Song"}'
```

### Mettre à jour une répétition
```bash
curl -X PUT https://localhost:8080/api/rehearsals/1 \
  -H "Content-Type: application/json" -b cookies.txt \
  -d '{"level": 3, "note": "à retravailler"}'
```

### Convertir en suggestion
```bash
curl -X POST https://localhost:8080/api/rehearsals/1/to-suggestion -b cookies.txt
```

## Paramètres du groupe et profil utilisateur

### Consulter les paramètres du groupe
```bash
curl https://localhost:8080/api/settings -b cookies.txt
```

### Modifier les paramètres du groupe
```bash
curl -X PUT https://localhost:8080/api/settings \
  -H "Content-Type: application/json" -b cookies.txt \
  -d '{"groupName": "Mon groupe", "darkMode": true}'
```

### Changer son mot de passe
```bash
curl -X PUT https://localhost:8080/api/password \
  -H "Content-Type: application/json" -b cookies.txt \
  -d '{"oldPassword": "secret", "newPassword": "nouveau"}'
```

### Se déconnecter
```bash
curl -X POST https://localhost:8080/api/logout -b cookies.txt
```


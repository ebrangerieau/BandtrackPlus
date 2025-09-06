# Architecture de BandTrack

## 1. Vue d’ensemble
BandTrack est une **Progressive Web App (PWA)** destinée aux groupes de musique.  
Elle repose sur une architecture simple et portable, conçue pour tourner dans un conteneur Docker sur un NAS ou un serveur léger.

**Composants principaux :**
- Frontend SPA (JavaScript vanilla)
- Backend HTTP (Python)
- Base de données PostgreSQL
- Conteneurisation via Docker
- API REST interne pour la communication frontend ↔ backend

---

## 2. Schéma simplifié

```
[ Client (PWA) ]
        |
   REST API (JSON)
        |
[ Backend Python ]
        |
[ PostgreSQL Database ]
```

---

## 3. Découpage des composants

### 3.1 Frontend
- **Type :** Single Page Application (SPA)
- **Technos :** JavaScript vanilla + HTML/CSS
- **Fonctionnalités clés :**
  - Interface responsive mobile/desktop
  - Thème clair/sombre + templates personnalisés
  - Manifest + service-worker (usage hors-ligne)
- **Entrée principale :** `public/js/ui/index.js`

### 3.2 Backend
- **Serveur :** Python (`http.server`)
- **Fichier principal :** `main.py`
- **Rôle :**
  - Gérer les endpoints REST
  - Authentification & sessions via cookies
  - Gestion des logs et des erreurs
- **Sécurité :**
  - Cookies HttpOnly + SameSite=Lax
  - Hashage mots de passe (PBKDF2-SHA256)

### 3.3 Base de données
- **Type :** PostgreSQL
- **Utilisation :**
  - Persistance des groupes, utilisateurs, suggestions, répétitions, prestations, paramètres
- **Scripts :**
  - `reset-db.sh` → réinitialisation

### 3.4 Conteneurisation
- **Fichiers :** `Dockerfile`, `docker-compose.yml`
- **Services :**
  - Backend Python
  - Base PostgreSQL
- **Objectif :**
  - Déploiement reproductible sur NAS/serveur
  - Sauvegardes automatisées

---

## 4. Flux de données

Exemple : un utilisateur vote pour une suggestion musicale.
1. Le frontend envoie `POST /api/suggestions/{id}/vote`
2. Le backend vérifie la session + droits utilisateur
3. Mise à jour de la base PostgreSQL
4. Réponse JSON envoyée au frontend (nouveau compteur de votes)
5. UI se met à jour côté PWA

---

## 5. Choix techniques

- **PostgreSQL** : base robuste et adaptée aux accès concurrents
- **Backend Python minimaliste** : moins de dépendances externes, facile à maintenir
- **Docker** : homogénéité entre développement, test et production
- **PWA** : utilisable sur smartphone comme une app native (installation via navigateur)

---

## 6. Points sensibles

- **Sessions** : gestion correcte des cookies
- **Sécurité API** : validation stricte des entrées
- **Sauvegardes DB** : planifier une stratégie régulière
- **Scalabilité** : nécessite une configuration appropriée de PostgreSQL pour gérer la charge

---

## 7. Évolutivité prévue

- Notifications push
- Export PDF des répertoires
- Lecteur audio intégré
- WebSockets pour la synchro temps réel
- Passage à une base plus robuste (PostgreSQL)

---

## 8. Outils et workflow de développement

- **Tests unitaires** : `pytest` (dossier `tests/`)
- **Sauvegardes** : répertoire `backups/`
- **CI/CD** (à prévoir) : build Docker + tests auto
- **Guide dev rapide :**
  1. `docker-compose up --build`
  2. Accéder au frontend : `http://localhost:8080`
  3. Lancer les tests : `pytest`

---

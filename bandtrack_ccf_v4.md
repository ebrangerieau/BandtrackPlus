# BandTrack – Cahier des charges version 4

## 1. Présentation du projet

BandTrack constitue une application web collaborative destinée aux groupes de musique pour faciliter la gestion de leur répertoire, le suivi des répétitions et la planification des prestations. Cette version 4 représente une évolution majeure par rapport aux prototypes précédents, intégrant un backend centralisé, une authentification biométrique moderne et une architecture évolutive conçue pour accompagner la croissance des groupes utilisateurs.

L'application fonctionne comme une Progressive Web App installable, offrant une expérience native sur tous les appareils tout en conservant les avantages du web. Elle centralise toutes les données sur un serveur sécurisé et propose des fonctionnalités avancées de collaboration musicale.

## 2. Architecture technique

### 2.1 Vue d'ensemble
L'architecture repose sur une séparation claire entre le frontend et le backend, communiquant exclusivement via une API REST sécurisée. Cette approche garantit la maintenabilité, la scalabilité et la possibilité d'évolutions futures sans refonte complète.

### 2.2 Frontend
L'interface utilisateur constitue une Single Page Application développée en JavaScript vanilla, servie par le backend et installable comme Progressive Web App. L'application accède aux API natives de l'appareil pour l'authentification biométrique, l'enregistrement audio et autres fonctionnalités avancées, sous réserve du consentement explicite de l'utilisateur.

La PWA permet une installation directe sur l'écran d'accueil des smartphones et ordinateurs, offrant un accès rapide et une expérience utilisateur optimisée. Un service worker assure la mise en cache des ressources statiques pour un fonctionnement optimal, y compris en cas de connectivité limitée.

### 2.3 Backend et API
Le backend Python fournit une API REST complète accessible via les endpoints `/api/*`. Toutes les opérations de création, lecture, mise à jour et suppression transitent par cette API, garantissant une cohérence des données et une sécurité homogène.

L'architecture supporte deux implémentations backend distinctes : une version Python utilisant uniquement la bibliothèque standard, et une version Node.js avec Express pour les déploiements nécessitant un écosystème JavaScript. Les deux implémentations exposent des endpoints identiques et maintiennent une compatibilité totale au niveau API.

### 2.4 Persistance et déploiement
La base de données SQLite stocke l'ensemble des informations applicatives avec une structure optimisée pour les performances et la cohérence. Pour les déploiements nécessitant une montée en charge, une migration vers PostgreSQL ou MySQL reste possible sans modification du code applicatif grâce à une couche d'abstraction appropriée.

Le déploiement s'effectue via des conteneurs Docker, avec un volume persistant pour la base de données et les fichiers audio. Cette approche facilite les déploiements sur différents environnements, des serveurs personnels aux plateformes cloud professionnelles.

## 3. Authentification et gestion des utilisateurs

### 3.1 Création de compte et connexion
Chaque utilisateur dispose d'un compte personnel avec identifiant unique et mot de passe. Le premier compte créé obtient automatiquement les privilèges administrateur, simplifiant l'initialisation du système pour de nouveaux groupes.

L'authentification traditionnelle par mot de passe utilise un hachage PBKDF2-SHA256 avec sel unique par utilisateur, offrant une protection robuste contre les attaques par dictionnaire et les fuites de données.

### 3.2 Authentification biométrique
L'authentification biométrique via WebAuthn et Passkeys représente une fonctionnalité premium optionnelle, activable après une première connexion réussie. Cette méthode exploite les capteurs intégrés aux appareils modernes pour une authentification rapide et sécurisée.

L'utilisation de l'authentification biométrique s'étend à la validation des actions sensibles telles que la suppression de prestations, la modification des rôles utilisateur ou l'accès aux paramètres administrateur, renforçant la sécurité globale du système.

### 3.3 Gestion des sessions et sécurité
Les sessions utilisateur utilisent des cookies sécurisés avec les attributs HttpOnly et SameSite pour prévenir les attaques XSS et CSRF. L'expiration automatique après sept jours d'inactivité garantit un équilibre entre sécurité et commodité d'usage.

Un système de journalisation des connexions et actions sensibles permet un suivi des activités et facilite la détection d'éventuelles anomalies de sécurité.

### 3.4 Système de rôles étendu
La gestion des permissions s'articule autour de trois niveaux : utilisateur standard, modérateur et administrateur. Les modérateurs disposent de droits étendus sur les contenus sans accéder à la gestion des utilisateurs, offrant une granularité adaptée aux différentes tailles de groupes.

Les administrateurs peuvent promouvoir ou rétrograder les autres utilisateurs, à l'exception de leur propre compte pour éviter les verrouillages accidentels. Un mécanisme de sauvegarde permet la désignation d'un administrateur de secours en cas d'indisponibilité du compte principal.

## 4. Fonctionnalités métier

### 4.1 Suggestions musicales
La section suggestions permet à tous les utilisateurs de proposer des morceaux avec titre obligatoire, auteur et liens YouTube optionnels. Un système de vote par pouce facilite l'identification des morceaux populaires au sein du groupe.

Le classement automatique selon les votes positifs aide à prioriser le travail sur les morceaux les plus appréciés. Les créateurs de suggestions et les modérateurs peuvent modifier ou supprimer leurs propositions, avec confirmation obligatoire pour les suppressions.

Un mécanisme de conversion permet de transformer directement une suggestion approuvée en morceau de répétition, conservant toutes les métadonnées associées et facilitant la transition vers le travail actif.

### 4.2 Répétitions et suivi des progrès
Chaque morceau en répétition dispose d'une fiche complète incluant les informations de base et les outils de suivi personnalisé. Les utilisateurs évaluent leur maîtrise via un curseur gradué de 0 à 10, avec coloration visuelle facilitant la lecture rapide des niveaux.

Les notes textuelles personnelles permettent de consigner des observations techniques, des difficultés rencontrées ou des points d'amélioration. Ces notes restent privées à chaque utilisateur tout en contribuant à un suivi précis des progrès.

L'enregistrement de notes audio courtes enrichit le suivi en permettant la sauvegarde d'idées musicales, de variations ou de rappels vocaux. Les fichiers sont limités à 10 Mo avec compression automatique pour optimiser le stockage et les performances.

La consultation des évaluations et notes des autres membres s'effectue de manière anonymisée, préservant la confidentialité tout en offrant une vision d'ensemble des progrès du groupe.

### 4.3 Planification des prestations
La gestion des prestations organise les événements en sections distinctes pour les dates à venir et passées, avec tri chronologique automatique. Chaque prestation associe un nom, une date, un lieu optionnel et une sélection de morceaux du répertoire.

L'accès rapide aux fiches détaillées des morceaux depuis l'interface de prestation facilite les révisions de dernière minute et la coordination entre les membres. Un système de notification optionnel peut alerter les membres des prestations approchantes.

Les prestations passées constituent un historique consultatif permettant de suivre l'évolution du répertoire et l'activité du groupe dans le temps.

## 5. Interface utilisateur et expérience

### 5.1 Navigation et ergonomie
L'interface adopte une navigation par onglets fixes en bas d'écran, optimisée pour l'usage mobile tout en restant fonctionnelle sur ordinateur. Les sections principales (Suggestions, Répétitions, Prestations, Paramètres) restent accessibles en un clic depuis tout écran.

Les fenêtres modales centrées gèrent l'ajout et la modification de contenus, maintenant le contexte visuel tout en offrant suffisamment d'espace pour les formulaires détaillés.

### 5.2 Design responsive et accessibilité
L'interface s'adapte automatiquement aux différentes tailles d'écran, du smartphone au grand écran, avec des breakpoints optimisés pour chaque usage. Les éléments tactiles respectent les recommandations d'accessibilité avec des zones de clic suffisantes et un contraste approprié.

L'étiquetage sémantique des formulaires et la navigation au clavier garantissent l'accessibilité aux utilisateurs de technologies d'assistance. Les liens externes s'ouvrent dans de nouveaux onglets pour préserver la session applicative.

### 5.3 Personnalisation
Le système de thèmes inclut les modes sombre et clair avec basculement automatique selon les préférences système de l'utilisateur. Le nom du groupe et le logo personnalisé apparaissent dans l'interface, renforçant l'identité visuelle de chaque installation.

## 6. Sécurité et conformité

### 6.1 Protection des données
L'ensemble des échanges entre le client et le serveur utilisent le protocole HTTPS avec certificats à jour. La validation systématique des entrées utilisateur prévient les attaques par injection et les corruptions de données.

Les mots de passe subissent un hachage sécurisé avec sel unique avant stockage, rendant impossible leur récupération en cas d'accès non autorisé à la base de données.

### 6.2 Sauvegarde et récupération
Un système de sauvegarde automatique quotidienne préserve l'intégrité des données avec rétention sur plusieurs versions. Les sauvegardes incluent la base de données principale et l'ensemble des fichiers audio associés.

La procédure de restauration documentée permet une remise en service rapide en cas d'incident, avec tests réguliers des processus de récupération.

## 7. Monitoring et maintenance

### 7.1 Journalisation
L'application génère des logs structurés pour toutes les opérations critiques, facilitant le diagnostic et la résolution des problèmes. Les niveaux de log configurables permettent d'adapter la verbosité selon les besoins opérationnels.

### 7.2 Métriques de performance
Le monitoring intégré suit les métriques essentielles telles que les temps de réponse, l'utilisation des ressources et la fréquence des erreurs. Ces indicateurs facilitent l'optimisation proactive des performances.

## 8. Roadmap et évolutions

### 8.1 Fonctionnalités prévues
Les développements futurs incluront un lecteur audio universel intégrant YouTube et Spotify, des notifications push pour les événements importants, et l'export PDF des répertoires et notes de répétition.

### 8.2 Scalabilité technique
L'architecture actuelle supporte une migration transparente vers des bases de données plus robustes et des architectures distribuées selon l'évolution des besoins. L'implémentation de WebSockets permettra la synchronisation en temps réel pour les groupes nécessitant une collaboration plus intensive.

## 9. Contraintes et prérequis techniques

Le déploiement nécessite un environnement Docker avec accès réseau pour les API externes et certificats HTTPS valides pour l'authentification biométrique. L'installation sur NAS Synology ou serveurs personnels reste privilégiée pour le contrôle des données et la simplicité d'administration.

La compatibilité navigateur cible les versions récentes de Chrome, Firefox, Safari et Edge supportant les technologies PWA et WebAuthn pour une expérience optimale sur tous les appareils.
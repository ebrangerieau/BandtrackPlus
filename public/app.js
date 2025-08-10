/*
  app.js (backend-enabled version)
  --------------------------------
  Ce fichier JavaScript contrôle l’interface de BandTrack lorsque les données
  sont centralisées sur un serveur via une API REST.  Toutes les opérations
  (authentification, suggestions, répétitions, prestations et paramètres)
  s’effectuent en envoyant des requêtes HTTP au serveur (sous le préfixe
  `/api`).  Le stockage local (localStorage) n’est plus utilisé : les données
  sont partagées entre les utilisateurs grâce à une base de données.

  L’application conserve la structure de navigation et d’interface définie
  dans le cahier des charges V1, tout en adaptant les actions pour être
  asynchrones.  Les utilisateurs doivent être connectés pour accéder aux
  fonctionnalités principales.  Si la session expire, ils sont ramenés à
  l’écran de connexion.
*/

(() => {
  // Utilisateur et page courants
  let currentUser = null;
  let currentPage = 'home';

  // Cache des répétitions pour éviter de relancer trop souvent la requête
  let rehearsalsCache = [];

  // Indique si la vérification biométrique a été effectuée
  let webAuthnVerified = false;

  function hasModRights() {
    return currentUser && (currentUser.membershipRole === 'admin' || currentUser.membershipRole === 'moderator');
  }
  function isAdmin() {
    return currentUser && currentUser.membershipRole === 'admin';
  }

  /**
   * Effectue une requête vers l’API.  Ajoute systématiquement le préfixe
   * `/api` et passe l’option `credentials: 'same-origin'` pour que les
   * cookies de session soient envoyés.  Lève une erreur si la requête
   * retourne un statut d’erreur.
   * @param {string} path Chemin relatif à l’API, par exemple '/suggestions'
   * @param {string} method Méthode HTTP (GET, POST, PUT, DELETE)
   * @param {Object?} data Corps JSON à envoyer pour les méthodes POST/PUT
  */
  async function api(path, method = 'GET', data) {
    const options = {
      method,
      credentials: 'same-origin',
    };
    if (data !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(data);
    }
    const res = await fetch('/api' + path, options);
    if (res.status === 401) {
      // Session invalide : retour à l’authentification
      currentUser = null;
      renderApp();
      throw new Error('Non authentifié');
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      json = null;
    }
    if (!res.ok) {
      throw new Error((json && json.error) || 'Erreur API');
    }
    return json;
  }

  // Déclenche une authentification WebAuthn si nécessaire
  async function ensureBiometric() {
    if (webAuthnVerified || !currentUser) return;
    const opts = await api('/webauthn/login', 'POST', { username: currentUser.username });
    const cred = await SimpleWebAuthnBrowser.startAuthentication(opts);
    await api('/webauthn/login', 'POST', cred);
    webAuthnVerified = true;
  }

  /**
   * Vérifie si un utilisateur est connecté en appelant `/api/me`.  Si c’est le
   * cas, met à jour `currentUser` et applique le thème sombre ou clair selon
   * les paramètres du serveur.  Sinon, `currentUser` reste nul.
   */
  async function checkSession() {
    try {
      const user = await api('/me');
      currentUser = user;
      // Récupère les paramètres (notamment le mode sombre) pour appliquer le thème
      const settings = await api('/settings');
      applyTheme(settings.darkMode);
      applyTemplate(settings.template || 'classic');
      document.title = `${settings.groupName} – BandTrack`;
    } catch (err) {
      currentUser = null;
    }
  }

  /**
   * Applique ou retire la classe `dark` sur le <body> en fonction de la valeur
   * de `dark`.  Cela permet de basculer entre le mode sombre et clair.
   * @param {boolean} dark
   */
  function applyTheme(dark) {
    const body = document.body;
    if (dark) body.classList.add('dark');
    else body.classList.remove('dark');
  }

  /**
   * Applique le modèle visuel (template) choisi.  Le nom du template
   * correspond à une classe CSS ajoutée sur le <body>, par exemple
   * ``template-classic`` ou ``template-groove``.  Cette classe
   * permet de définir des variables CSS spécifiques dans ``style.css``.
   * @param {string} templateName
   */
  function applyTemplate(templateName) {
    const body = document.body;
    // Retirer toute classe de template existante
    body.classList.forEach((cls) => {
      if (cls.startsWith('template-')) body.classList.remove(cls);
    });
    // Appliquer la nouvelle classe
    body.classList.add('template-' + templateName);
  }

  /**
   * Initialise l’application au chargement de la page.  Cette fonction est
   * déclenchée par l’événement `DOMContentLoaded` défini à la fin du fichier.
   */
  async function initApp() {
    await checkSession();
    renderApp();
  }

  /**
   * Point d’entrée pour décider d’afficher l’écran d’authentification ou
   * l’interface principale.  Réinitialise également les caches lorsque
   * l’utilisateur se déconnecte.
   */
  function renderApp() {
    const app = document.getElementById('app');
    if (!currentUser) {
      rehearsalsCache = [];
      renderAuth(app);
    } else {
      renderMain(app);
    }
  }

  /**
   * Affiche l’écran de connexion / inscription.  On crée un formulaire unique
   * et l’on bascule entre les modes en changeant la variable `isRegister`.
   * @param {HTMLElement} app Le conteneur racine
   */
  function renderAuth(app) {
    app.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'auth-container';
    let isRegister = false;

    function draw() {
      container.innerHTML = '';
      const title = document.createElement('h2');
      title.textContent = isRegister ? 'Inscription' : 'Connexion';
      container.appendChild(title);
      const form = document.createElement('form');
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (isRegister) {
          await register();
        } else {
          await login();
        }
      };
      // Champ utilisateur
      const labelUser = document.createElement('label');
      labelUser.textContent = 'Nom d’utilisateur';
      const inputUser = document.createElement('input');
      inputUser.type = 'text';
      inputUser.required = true;
      // Champ mot de passe
      const labelPass = document.createElement('label');
      labelPass.textContent = 'Mot de passe';
      const inputPass = document.createElement('input');
      inputPass.type = 'password';
      inputPass.required = true;
      form.appendChild(labelUser);
      form.appendChild(inputUser);
      form.appendChild(labelPass);
      form.appendChild(inputPass);
      let inputConfirm;
      if (isRegister) {
        const labelConfirm = document.createElement('label');
        labelConfirm.textContent = 'Confirmer le mot de passe';
        inputConfirm = document.createElement('input');
        inputConfirm.type = 'password';
        inputConfirm.required = true;
        form.appendChild(labelConfirm);
        form.appendChild(inputConfirm);
      }
      const errorDiv = document.createElement('div');
      errorDiv.style.color = 'var(--danger-color)';
      errorDiv.style.marginTop = '12px';
      form.appendChild(errorDiv);
      // Bouton de soumission
      const submitBtn = document.createElement('button');
      submitBtn.className = 'btn-primary';
      submitBtn.style.marginTop = '20px';
      submitBtn.textContent = isRegister ? 'S’inscrire' : 'Se connecter';
      form.appendChild(submitBtn);
      if (!isRegister) {
        const bioBtn = document.createElement('button');
        bioBtn.type = 'button';
        bioBtn.className = 'btn-secondary';
        bioBtn.style.marginTop = '10px';
        bioBtn.textContent = 'Connexion biométrique';
        bioBtn.onclick = async () => {
          const username = inputUser.value.trim();
          if (!username) {
            errorDiv.textContent = 'Veuillez saisir un nom d\u2019utilisateur';
            return;
          }
          try {
            const opts = await api('/webauthn/login', 'POST', { username });
            const cred = await SimpleWebAuthnBrowser.startAuthentication(opts);
            const user = await api('/webauthn/login', 'POST', cred);
            currentUser = user;
            await checkSession();
            webAuthnVerified = true;
            renderApp();
          } catch (err) {
            errorDiv.textContent = err.message;
          }
        };
        form.appendChild(bioBtn);
      }
      // Lien pour basculer
      const toggle = document.createElement('a');
      toggle.className = 'link';
      toggle.textContent = isRegister ? 'Déjà un compte ? Se connecter' : 'Créer un compte';
      toggle.onclick = (e) => {
        e.preventDefault();
        isRegister = !isRegister;
        draw();
      };
      container.appendChild(form);
      container.appendChild(toggle);
      app.appendChild(container);

      // Fonctions d’authentification appelées par le formulaire
      async function register() {
        const username = inputUser.value.trim();
        const password = inputPass.value;
        const confirm = inputConfirm ? inputConfirm.value : '';
        if (!username || !password) {
          errorDiv.textContent = 'Veuillez saisir un nom d’utilisateur et un mot de passe';
          return;
        }
        if (password !== confirm) {
          errorDiv.textContent = 'Les mots de passe ne correspondent pas';
          return;
        }
        try {
          await api('/register', 'POST', { username, password });
          // Après l’inscription, récupère la session pour obtenir
          // l’identifiant et le nom d’utilisateur normalisé.
          await checkSession();
          webAuthnVerified = false;
          currentPage = 'home';
          renderMain(app);
        } catch (err) {
          errorDiv.textContent = err.message;
        }
      }
      async function login() {
        const username = inputUser.value.trim();
        const password = inputPass.value;
        if (!username || !password) {
          errorDiv.textContent = 'Veuillez saisir un nom d’utilisateur et un mot de passe';
          return;
        }
        try {
          await api('/login', 'POST', { username, password });
          // Après la connexion, interroge le serveur pour récupérer
          // l’utilisateur courant et appliquer le thème.
          await checkSession();
          webAuthnVerified = false;
          currentPage = 'home';
          renderMain(app);
        } catch (err) {
          errorDiv.textContent = err.message;
        }
      }
    }
    draw();
  }

  /**
   * Page d'accueil après la connexion. Affiche la prochaine prestation et la
   * date de la prochaine répétition, puis propose un bouton pour entrer dans
   * l'application principale.
   * @param {HTMLElement} app
   */
  async function renderHome(app) {
    app.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'home-container';
    app.appendChild(container);

    let nextPerfText = 'Aucune prestation prévue';
    try {
      const list = await api('/performances');
      const today = new Date().toISOString().split('T')[0];
      const upcoming = list.filter((p) => p.date >= today);
      upcoming.sort((a, b) => a.date.localeCompare(b.date));
      if (upcoming.length > 0) {
        const p = upcoming[0];
        nextPerfText = `Prochaine prestation : ${p.name} (${p.date})`;
      }
    } catch (err) {
      nextPerfText = 'Impossible de récupérer les prestations';
    }
    const perfP = document.createElement('p');
    perfP.textContent = nextPerfText;
    container.appendChild(perfP);

    let nextRehearsalDate = '';
    let nextRehearsalLocation = '';
    try {
      const settings = await api('/settings');
      nextRehearsalDate = settings.nextRehearsalDate || '';
      nextRehearsalLocation = settings.nextRehearsalLocation || '';
    } catch (err) {
      // ignore
    }
    const rehP = document.createElement('p');
    rehP.textContent = nextRehearsalDate
      ? `Prochaine répétition : ${nextRehearsalDate}${nextRehearsalLocation ? ' – ' + nextRehearsalLocation : ''}`
      : 'Prochaine répétition : —';
    container.appendChild(rehP);

  }

  /**
   * Rendu principal de l’application une fois l’utilisateur authentifié.
   * Initialise la barre de navigation et appelle la fonction de rendu
   * correspondant à la page sélectionnée.
   * @param {HTMLElement} app
   */
  function renderMain(app) {
    app.innerHTML = '';
    const pageDiv = document.createElement('div');
    pageDiv.className = 'page';
    app.appendChild(pageDiv);
    // Barre de navigation
    const nav = document.createElement('div');
    nav.className = 'nav-bar';
    const navItems = [
      { key: 'home', label: 'Accueil' },
      { key: 'suggestions', label: 'J’aime' },
      { key: 'rehearsals', label: 'Répétitions' },
      { key: 'performances', label: 'Prestations' },
      { key: 'settings', label: 'Paramètres' },
    ];
    navItems.forEach((item) => {
      const btn = document.createElement('button');
      btn.textContent = item.label;
      btn.className = currentPage === item.key ? 'active' : '';
      btn.onclick = () => {
        if (currentPage !== item.key) {
          currentPage = item.key;
          renderMain(app);
        }
      };
      nav.appendChild(btn);
    });
    app.appendChild(nav);
    // Rendu de la page en fonction de currentPage
    if (currentPage === 'home') {
      renderHome(pageDiv);
    } else if (currentPage === 'suggestions') {
      renderSuggestions(pageDiv);
    } else if (currentPage === 'rehearsals') {
      renderRehearsals(pageDiv);
    } else if (currentPage === 'performances') {
      renderPerformances(pageDiv);
    } else if (currentPage === 'settings') {
      renderSettings(pageDiv);
    }
  }

  /**
   * Affiche la liste des suggestions et permet d’ajouter ou de supprimer
   * des morceaux proposés.  L’affichage se met à jour après chaque
   * modification.
   * @param {HTMLElement} container
   */
  async function renderSuggestions(container) {
    container.innerHTML = '';
    const header = document.createElement('h2');
    header.textContent = 'Morceaux suggérés';
    container.appendChild(header);
    let list = [];
    try {
      list = await api('/suggestions');
    } catch (err) {
      const p = document.createElement('p');
      p.style.color = 'var(--danger-color)';
      p.textContent = 'Impossible de récupérer les suggestions';
      container.appendChild(p);
      return;
    }
    // Afficher la liste
    list.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'card collapsed';

      const headerRow = document.createElement('div');
      headerRow.className = 'card-header';

      const titleEl = document.createElement('h3');
      titleEl.textContent = item.title;
      titleEl.onclick = () => {
        card.classList.toggle('collapsed');
      };
      headerRow.appendChild(titleEl);

      const likeBox = document.createElement('div');
      likeBox.className = 'like-info';

      const likeCount = document.createElement('span');
      likeCount.textContent = `❤️ ${item.likes || 0}`;

      const likeBtn = document.createElement('button');
      likeBtn.className = 'like-btn';
      likeBtn.textContent = '👍';
      likeBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          const updated = await api(`/suggestions/${item.id}/vote`, 'POST');
          likeCount.textContent = `❤️ ${updated.likes}`;
          renderSuggestions(container);
        } catch (err) {
          alert(err.message);
        }
      };

      const dislikeBtn = document.createElement('button');
      dislikeBtn.className = 'like-btn';
      dislikeBtn.textContent = '👎';
      dislikeBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          const updated = await api(`/suggestions/${item.id}/vote`, 'DELETE');
          likeCount.textContent = `❤️ ${updated.likes}`;
          renderSuggestions(container);
        } catch (err) {
          alert(err.message);
        }
      };

      likeBox.appendChild(likeCount);
      likeBox.appendChild(likeBtn);
      likeBox.appendChild(dislikeBtn);
      headerRow.appendChild(likeBox);

      card.appendChild(headerRow);
      const details = document.createElement('div');
      details.className = 'card-details';
      if (item.author) {
        const authP = document.createElement('p');
        authP.style.fontStyle = 'italic';
        authP.textContent = 'Auteur : ' + item.author;
        details.appendChild(authP);
      }
      const yt = item.youtube || item.url;
      if (yt) {
        const link = document.createElement('a');
        link.href = yt;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = yt;
        details.appendChild(link);
      }
      const addedBy = document.createElement('p');
      addedBy.style.fontSize = '12px';
      addedBy.style.color = 'var(--text-color)';
      addedBy.textContent = `Ajouté par ${item.creator}`;
      details.appendChild(addedBy);
      if (currentUser && (hasModRights() || item.creatorId === currentUser.id || item.creator === currentUser.username)) {
        const actions = document.createElement('div');
        actions.className = 'actions';
        const editBtn = document.createElement('button');
        editBtn.className = 'btn-secondary';
        editBtn.textContent = 'Modifier';
        editBtn.onclick = (e) => {
          e.stopPropagation();
          showEditSuggestionModal(item, container);
        };
        actions.appendChild(editBtn);
        const toRehBtn = document.createElement('button');
        toRehBtn.className = 'btn-primary';
        toRehBtn.textContent = 'Passer en répétition';
        toRehBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await api(`/suggestions/${item.id}/to-rehearsal`, 'POST');
            rehearsalsCache = await api('/rehearsals');
            renderSuggestions(container);
          } catch (err) {
            alert(err.message);
          }
        };
        actions.appendChild(toRehBtn);
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-danger';
        delBtn.textContent = 'Supprimer';
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm('Supprimer cette suggestion ?')) return;
          try {
            await api(`/suggestions/${item.id}`, 'DELETE');
            renderSuggestions(container);
          } catch (err) {
            alert(err.message);
          }
        };
        actions.appendChild(delBtn);
        details.appendChild(actions);
      }
      card.appendChild(details);
      container.appendChild(card);
    });
    // Bouton flottant pour ajouter une suggestion
    const fab = document.createElement('div');
    fab.className = 'fab';
    fab.title = 'Ajouter un morceau';
    fab.textContent = '+';
    fab.onclick = () => showAddSuggestionModal(container);
    container.appendChild(fab);
  }

  /**
   * Affiche la fenêtre modale pour ajouter une nouvelle suggestion.
   */
  function showAddSuggestionModal(container) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = 'Ajouter une suggestion';
    content.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => {
      e.preventDefault();
    };
    // Titre
    const labelTitle = document.createElement('label');
    labelTitle.textContent = 'Titre';
    const inputTitle = document.createElement('input');
    inputTitle.type = 'text';
    inputTitle.required = true;
    inputTitle.style.width = '100%';
    // Auteur
    const labelAuthor = document.createElement('label');
    labelAuthor.textContent = 'Auteur';
    const inputAuthor = document.createElement('input');
    inputAuthor.type = 'text';
    inputAuthor.style.width = '100%';
    // Lien YouTube
    const labelYt = document.createElement('label');
    labelYt.textContent = 'Lien YouTube';
    const inputYt = document.createElement('input');
    inputYt.type = 'url';
    inputYt.style.width = '100%';
    form.appendChild(labelTitle);
    form.appendChild(inputTitle);
    form.appendChild(labelAuthor);
    form.appendChild(inputAuthor);
    form.appendChild(labelYt);
    form.appendChild(inputYt);
    content.appendChild(form);
    // Actions
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal); // or use modal.remove();
      }
    };
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Ajouter';
    okBtn.onclick = async (e) => {
      e.preventDefault();
      const title = inputTitle.value.trim();
      const author = inputAuthor.value.trim();
      const youtube = inputYt.value.trim();
      if (!title) return;
      try {
        await api('/suggestions', 'POST', { title, author, youtube });
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal); // or use modal.remove();
        }
        renderSuggestions(container);
      } catch (err) {
        alert(err.message);
      }
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    content.appendChild(actions);
    modal.appendChild(content);
    document.body.appendChild(modal);
    setTimeout(() => inputTitle.focus(), 50);
  }

  /**
   * Display a modal to edit an existing suggestion.
   */
  function showEditSuggestionModal(item, container) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = 'Modifier la suggestion';
    content.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => e.preventDefault();
    const labelTitle = document.createElement('label');
    labelTitle.textContent = 'Titre';
    const inputTitle = document.createElement('input');
    inputTitle.type = 'text';
    inputTitle.required = true;
    inputTitle.style.width = '100%';
    inputTitle.value = item.title;
    const labelAuthor = document.createElement('label');
    labelAuthor.textContent = 'Auteur';
    const inputAuthor = document.createElement('input');
    inputAuthor.type = 'text';
    inputAuthor.style.width = '100%';
    inputAuthor.value = item.author || '';

    const labelYt = document.createElement('label');
    labelYt.textContent = 'Lien YouTube';
    const inputYt = document.createElement('input');
    inputYt.type = 'url';
    inputYt.style.width = '100%';
    inputYt.value = item.youtube || item.url || '';
    form.appendChild(labelTitle);
    form.appendChild(inputTitle);
    form.appendChild(labelAuthor);
    form.appendChild(inputAuthor);
    form.appendChild(labelYt);
    form.appendChild(inputYt);
    content.appendChild(form);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal); // or use modal.remove();
      }
    };
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Enregistrer';
    okBtn.onclick = async (e) => {
      e.preventDefault();
      const titleVal = inputTitle.value.trim();
      const authorVal = inputAuthor.value.trim();
      const youtubeVal = inputYt.value.trim();
      if (!titleVal) return;
      try {
        await api(`/suggestions/${item.id}`, 'PUT', {
          title: titleVal,
          author: authorVal,
          youtube: youtubeVal,
        });
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal); // or use modal.remove();
        }
        renderSuggestions(container);
      } catch (err) {
        alert(err.message);
      }
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    content.appendChild(actions);
    modal.appendChild(content);
    document.body.appendChild(modal);
    setTimeout(() => inputTitle.focus(), 50);
  }

  /**
   * Rendu des répétitions.  Affiche les morceaux en cours et permet
   * d’ajuster son propre niveau (0–10) et ses notes, tout en affichant
   * celles des autres membres.
   * @param {HTMLElement} container
   */
  async function renderRehearsals(container) {
    container.innerHTML = '';
    const header = document.createElement('h2');
    header.textContent = 'Morceaux en cours de travail';
    container.appendChild(header);
    let list = [];
    try {
      list = await api('/rehearsals');
      // Mettez en cache pour d’autres pages (prestations)
      rehearsalsCache = list;
    } catch (err) {
      const p = document.createElement('p');
      p.style.color = 'var(--danger-color)';
      p.textContent = 'Impossible de récupérer les répétitions';
      container.appendChild(p);
      return;
    }
    list.forEach((song) => {
      const card = document.createElement('div');
      card.className = 'card collapsed';
      const h3 = document.createElement('h3');
      h3.textContent = song.title;
      h3.onclick = () => {
        card.classList.toggle('collapsed');
      };
      card.appendChild(h3);
      const details = document.createElement('div');
      details.className = 'card-details';
      // Auteur
      if (song.author) {
        const authorP = document.createElement('p');
        authorP.style.fontStyle = 'italic';
        authorP.textContent = 'Auteur : ' + song.author;
        details.appendChild(authorP);
      }
      // Lien YouTube
      if (song.youtube) {
        const ytLink = document.createElement('a');
        ytLink.href = song.youtube;
        ytLink.target = '_blank';
        ytLink.rel = 'noopener noreferrer';
        ytLink.textContent = song.youtube;
        details.appendChild(ytLink);
      }
      // Niveau pour utilisateur courant
      const levelWrapper = document.createElement('div');
      levelWrapper.style.marginTop = '8px';
      const currentLevel = song.levels[currentUser.username] != null ? song.levels[currentUser.username] : 0;
      const levelLabel = document.createElement('label');
      levelLabel.textContent = `Votre niveau (${currentLevel}/10)`;
      levelLabel.className = 'level-display';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = 0;
      range.max = 10;
      range.step = 1;
      range.value = currentLevel;
      function updateRangeColor(val) {
        const percent = val / 10;
        const red = Math.round(255 * (1 - percent));
        const green = Math.round(255 * percent);
        range.style.background = `linear-gradient(to right, rgb(${red},${green},80) ${(val / 10) * 100}%, var(--border-color) ${(val / 10) * 100}%)`;
      }
      updateRangeColor(currentLevel);
      range.oninput = async () => {
        const val = Number(range.value);
        levelLabel.textContent = `Votre niveau (${val}/10)`;
        updateRangeColor(val);
        try {
          await api(`/rehearsals/${song.id}`, 'PUT', { level: val });
        } catch (err) {
          alert(err.message);
        }
      };
      levelWrapper.appendChild(levelLabel);
      levelWrapper.appendChild(range);
      details.appendChild(levelWrapper);
      // Notes pour utilisateur courant
      const notesLabel = document.createElement('label');
      notesLabel.textContent = 'Vos notes';
      const textarea = document.createElement('textarea');
      textarea.value = (song.notes && song.notes[currentUser.username]) || '';
      textarea.onchange = async () => {
        try {
          await api(`/rehearsals/${song.id}`, 'PUT', { note: textarea.value });
        } catch (err) {
          alert(err.message);
        }
      };
      details.appendChild(notesLabel);
      details.appendChild(textarea);

      // Note audio pour l'utilisateur courant
      const audioSection = document.createElement('div');
      audioSection.style.marginTop = '8px';
      const userAudio = song.audioNotes && song.audioNotes[currentUser.username];
      if (userAudio) {
        const audioPlayer = document.createElement('audio');
        audioPlayer.controls = true;
        // userAudio contient désormais une URL de données complète (data:audio/…;base64,XXX)
        audioPlayer.src = userAudio;
        audioSection.appendChild(audioPlayer);
        const delAudioBtn = document.createElement('button');
        delAudioBtn.className = 'btn-danger';
        delAudioBtn.textContent = 'Supprimer audio';
        delAudioBtn.style.marginLeft = '8px';
        delAudioBtn.onclick = async (e) => {
          e.preventDefault();
          if (!confirm('Supprimer la note audio ?')) return;
          try {
            await api(`/rehearsals/${song.id}`, 'PUT', { audio: '' });
            // Rafraîchir la liste après suppression
            renderRehearsals(container);
          } catch (err) {
            alert(err.message);
          }
        };
        audioSection.appendChild(delAudioBtn);
      } else {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'audio/*';
        fileInput.style.display = 'none';
        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'btn-secondary';
        uploadBtn.textContent = 'Ajouter une note audio';
        uploadBtn.onclick = (e) => {
          e.preventDefault();
          fileInput.click();
        };
        fileInput.onchange = async () => {
          const file = fileInput.files[0];
          if (!file) return;
          // Limiter la taille du fichier à 5 Mo
          if (file.size > 5 * 1024 * 1024) {
            alert('Le fichier audio est trop volumineux (max 5 Mo).');
            return;
          }
          const reader = new FileReader();
          reader.onload = async (ev) => {
            // Utiliser l’URL de données complète (avec le type MIME) comme valeur de la note audio
            const dataUrl = (ev.target?.result || '').toString();
            try {
              await api(`/rehearsals/${song.id}`, 'PUT', { audio: dataUrl });
              renderRehearsals(container);
            } catch (err) {
              alert(err.message);
            }
          };
          reader.readAsDataURL(file);
        };
        audioSection.appendChild(uploadBtn);
        audioSection.appendChild(fileInput);
      }
      details.appendChild(audioSection);
      // Afficher les notes et niveaux des autres membres
      // Filtrer les autres membres en ignorant la casse afin d’éviter de voir
      // apparaître plusieurs fois le même utilisateur (ex : « eric » et « Eric »).
      const others = Object.keys(song.levels || {}).filter((u) => u.toLowerCase() !== currentUser.username.toLowerCase());
      if (others.length > 0) {
        const othersDiv = document.createElement('div');
        othersDiv.style.marginTop = '12px';
        const otherTitle = document.createElement('p');
        otherTitle.textContent = 'Autres membres :';
        otherTitle.style.fontStyle = 'italic';
        othersDiv.appendChild(otherTitle);
        others.forEach((u) => {
          const wrapper = document.createElement('div');
          wrapper.style.marginBottom = '4px';
          const lev = song.levels[u];
          const note = song.notes && song.notes[u] ? song.notes[u] : '';
          const pUser = document.createElement('p');
          pUser.style.margin = '0';
          pUser.innerHTML = `<strong>${u}</strong> – Niveau ${lev}/10${note ? ' – ' + note : ''}`;
          wrapper.appendChild(pUser);
          const otherAudio = song.audioNotes && song.audioNotes[u];
          if (otherAudio) {
            const audioEl = document.createElement('audio');
            audioEl.controls = true;
            // otherAudio est un DataURL complet
            audioEl.src = otherAudio;
            audioEl.style.display = 'block';
            audioEl.style.marginTop = '4px';
            wrapper.appendChild(audioEl);
          }
          othersDiv.appendChild(wrapper);
        });
        details.appendChild(othersDiv);
      }
      // Actions (edit/delete) for creator or admin
      if (currentUser && (hasModRights() || currentUser.id === song.creatorId)) {
        const actions = document.createElement('div');
        actions.className = 'actions';
        // Edit button
        const editBtn = document.createElement('button');
        editBtn.className = 'btn-secondary';
        editBtn.textContent = 'Modifier';
        editBtn.onclick = (e) => {
          e.stopPropagation();
          showEditRehearsalModal(song, container);
        };
        actions.appendChild(editBtn);
        const toSugBtn = document.createElement('button');
        toSugBtn.className = 'btn-primary';
        toSugBtn.textContent = 'Remettre dans J\u2019aime';
        toSugBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await api(`/rehearsals/${song.id}/to-suggestion`, 'POST');
            renderRehearsals(container);
          } catch (err) {
            alert(err.message);
          }
        };
        actions.appendChild(toSugBtn);
        // Delete button
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-danger';
        delBtn.textContent = 'Supprimer';
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm('Supprimer ce morceau ?')) return;
          try {
            await api(`/rehearsals/${song.id}`, 'DELETE');
            // Rafraîchir la liste des répétitions et des prestations
            renderRehearsals(container);
            // Mettre à jour le cache des répétitions
            rehearsalsCache = await api('/rehearsals');
          } catch (err) {
            alert(err.message);
          }
        };
        actions.appendChild(delBtn);
        details.appendChild(actions);
      }
      card.appendChild(details);
      container.appendChild(card);
    });
    // Bouton flottant pour ajouter une répétition
    const fab = document.createElement('div');
    fab.className = 'fab';
    fab.title = 'Ajouter un morceau en répétition';
    fab.textContent = '+';
    fab.onclick = () => showAddRehearsalModal(container);
    container.appendChild(fab);
  }

  /**
   * Fenêtre modale pour ajouter un nouveau morceau en répétition.
   */
  function showAddRehearsalModal(container) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = 'Ajouter un morceau';
    content.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => e.preventDefault();
    // Titre
    const labelTitle = document.createElement('label');
    labelTitle.textContent = 'Titre';
    const inputTitle = document.createElement('input');
    inputTitle.type = 'text';
    inputTitle.required = true;
    inputTitle.style.width = '100%';
    // Auteur
    const labelAuthor = document.createElement('label');
    labelAuthor.textContent = 'Auteur';
    const inputAuthor = document.createElement('input');
    inputAuthor.type = 'text';
    inputAuthor.style.width = '100%';
    // YouTube
    const labelYt = document.createElement('label');
    labelYt.textContent = 'Lien YouTube';
    const inputYt = document.createElement('input');
    inputYt.type = 'url';
    inputYt.style.width = '100%';
    // Spotify
    const labelSp = document.createElement('label');
    labelSp.textContent = 'Lien Spotify';
    const inputSp = document.createElement('input');
    inputSp.type = 'url';
    inputSp.style.width = '100%';
    form.appendChild(labelTitle);
    form.appendChild(inputTitle);
    form.appendChild(labelAuthor);
    form.appendChild(inputAuthor);
    form.appendChild(labelYt);
    form.appendChild(inputYt);
    form.appendChild(labelSp);
    form.appendChild(inputSp);
    content.appendChild(form);
    // Actions
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal); // or use modal.remove();
      }
    };
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Ajouter';
    okBtn.onclick = async (e) => {
      e.preventDefault();
      const title = inputTitle.value.trim();
      if (!title) return;
      const author = inputAuthor.value.trim();
      const youtube = inputYt.value.trim();
      const spotify = inputSp.value.trim();
      try {
        await api('/rehearsals', 'POST', { title, author, youtube, spotify });
          if (modal.parentNode) {
            modal.parentNode.removeChild(modal); // or use modal.remove();
          }
        renderRehearsals(container);
      } catch (err) {
        alert(err.message);
      }
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    content.appendChild(actions);
    modal.appendChild(content);
    document.body.appendChild(modal);
    setTimeout(() => inputTitle.focus(), 50);
  }

  /**
   * Fenêtre modale pour modifier un morceau en répétition.  Seul
   * l'auteur du morceau ou un administrateur peut modifier le titre
   * ainsi que les liens YouTube/Spotify.  Les valeurs actuelles
   * apparaissent préremplies.  Après la sauvegarde, la liste des
   * répétitions est rafraîchie.
   * @param {Object} song L'objet représentant la répétition à éditer
   * @param {HTMLElement} container Le conteneur de la page des répétitions
   */
  function showEditRehearsalModal(song, container) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = 'Modifier le morceau';
    content.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => e.preventDefault();
    // Titre
    const labelTitle = document.createElement('label');
    labelTitle.textContent = 'Titre';
    const inputTitle = document.createElement('input');
    inputTitle.type = 'text';
    inputTitle.required = true;
    inputTitle.style.width = '100%';
    inputTitle.value = song.title;
    // Auteur
    const labelAuthor = document.createElement('label');
    labelAuthor.textContent = 'Auteur';
    const inputAuthor = document.createElement('input');
    inputAuthor.type = 'text';
    inputAuthor.style.width = '100%';
    inputAuthor.value = song.author || '';
    // YouTube
    const labelYt = document.createElement('label');
    labelYt.textContent = 'Lien YouTube';
    const inputYt = document.createElement('input');
    inputYt.type = 'url';
    inputYt.style.width = '100%';
    inputYt.value = song.youtube || '';
    // Spotify
    const labelSp = document.createElement('label');
    labelSp.textContent = 'Lien Spotify';
    const inputSp = document.createElement('input');
    inputSp.type = 'url';
    inputSp.style.width = '100%';
    inputSp.value = song.spotify || '';
    form.appendChild(labelTitle);
    form.appendChild(inputTitle);
    form.appendChild(labelAuthor);
    form.appendChild(inputAuthor);
    form.appendChild(labelYt);
    form.appendChild(inputYt);
    form.appendChild(labelSp);
    form.appendChild(inputSp);
    content.appendChild(form);
    // Actions
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal); // or use modal.remove();
      }
    };
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Enregistrer';
    okBtn.onclick = async (e) => {
      e.preventDefault();
      const titleVal = inputTitle.value.trim();
      const authorVal = inputAuthor.value.trim();
      const ytVal = inputYt.value.trim();
      const spVal = inputSp.value.trim();
      if (!titleVal) return;
      try {
        await api(`/rehearsals/${song.id}`, 'PUT', { title: titleVal, author: authorVal, youtube: ytVal, spotify: spVal });
          if (modal.parentNode) {
            modal.parentNode.removeChild(modal); // or use modal.remove();
          }
        // Actualiser la page des répétitions
        renderRehearsals(container);
        // Mettre à jour le cache
        rehearsalsCache = await api('/rehearsals');
      } catch (err) {
        alert(err.message);
      }
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    content.appendChild(actions);
    modal.appendChild(content);
    document.body.appendChild(modal);
    setTimeout(() => inputTitle.focus(), 50);
  }

  /**
   * Rendu des prestations.  Les prestations sont divisées en « À venir » et
   * « Passées » selon la date.  Chaque carte peut être modifiée ou supprimée
   * par son auteur, et un clic en dehors des boutons affiche le détail.
   * @param {HTMLElement} container
   */
  async function renderPerformances(container) {
    container.innerHTML = '';
    const header = document.createElement('h2');
    header.textContent = 'Prestations';
    container.appendChild(header);
    let list = [];
    try {
      list = await api('/performances');
    } catch (err) {
      const p = document.createElement('p');
      p.style.color = 'var(--danger-color)';
      p.textContent = 'Impossible de récupérer les prestations';
      container.appendChild(p);
      return;
    }
    // Assurer d’avoir les répétitions en cache pour afficher les titres
    if (rehearsalsCache.length === 0) {
      try {
        rehearsalsCache = await api('/rehearsals');
      } catch (err) {
        // ignore
      }
    }
    const today = new Date().toISOString().split('T')[0];
    const upcoming = list.filter((p) => p.date >= today);
    const past = list.filter((p) => p.date < today);
    function renderPerfList(title, arr) {
      const titleDiv = document.createElement('div');
      titleDiv.className = 'section-title';
      titleDiv.textContent = title;
      container.appendChild(titleDiv);
      if (arr.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'Aucune prestation';
        container.appendChild(empty);
        return;
      }
      arr.forEach((perf) => {
        const card = document.createElement('div');
        card.className = 'card collapsed';
        const h3 = document.createElement('h3');
        h3.textContent = perf.name;
        h3.onclick = () => {
          card.classList.toggle('collapsed');
        };
        card.appendChild(h3);
        const details = document.createElement('div');
        details.className = 'card-details';
        const dateP = document.createElement('p');
        dateP.textContent = 'Date : ' + perf.date;
        details.appendChild(dateP);
        if (perf.location) {
          const locP = document.createElement('p');
          locP.textContent = 'Lieu : ' + perf.location;
          details.appendChild(locP);
        }
        if (perf.songs && perf.songs.length > 0) {
          const ul = document.createElement('ul');
          perf.songs.forEach((id) => {
            const reh = rehearsalsCache.find((r) => r.id === id);
            const li = document.createElement('li');
            li.textContent = reh ? reh.title : '—';
            ul.appendChild(li);
          });
          details.appendChild(ul);
        }
        if (currentUser && (hasModRights() || currentUser.id === perf.creatorId)) {
          const actions = document.createElement('div');
          actions.className = 'actions';
          const editBtn = document.createElement('button');
          editBtn.className = 'btn-secondary';
          editBtn.textContent = 'Modifier';
          editBtn.onclick = (e) => {
            e.stopPropagation();
            showEditPerformanceModal(perf, container);
          };
          actions.appendChild(editBtn);
          const delBtn = document.createElement('button');
          delBtn.className = 'btn-danger';
          delBtn.textContent = 'Supprimer';
          delBtn.onclick = async (e) => {
            e.stopPropagation();
            if (!confirm('Supprimer cette prestation ?')) return;
            try {
              await ensureBiometric();
              await api(`/performances/${perf.id}`, 'DELETE');
              renderPerformances(container);
            } catch (err) {
              alert(err.message);
            }
          };
          actions.appendChild(delBtn);
          details.appendChild(actions);
        }
        card.appendChild(details);
        container.appendChild(card);
      });
    }
    renderPerfList('À venir', upcoming);
    renderPerfList('Passées', past);
    // Bouton flotant pour ajouter prestation
    const fab = document.createElement('div');
    fab.className = 'fab';
    fab.title = 'Ajouter une prestation';
    fab.textContent = '+';
    fab.onclick = () => showAddPerformanceModal(container);
    container.appendChild(fab);
  }

  /**
   * Affiche une modale pour ajouter une prestation.
   */
  function showAddPerformanceModal(container) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = 'Ajouter une prestation';
    content.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => e.preventDefault();
    // Nom
    const labelName = document.createElement('label');
    labelName.textContent = 'Nom';
    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.required = true;
    inputName.style.width = '100%';
    // Date
    const labelDate = document.createElement('label');
    labelDate.textContent = 'Date';
    const inputDate = document.createElement('input');
    inputDate.type = 'date';
    inputDate.required = true;
    inputDate.style.width = '100%';
    // Lieu
    const labelLoc = document.createElement('label');
    labelLoc.textContent = 'Lieu';
    const inputLoc = document.createElement('input');
    inputLoc.type = 'text';
    inputLoc.style.width = '100%';
    // Sélection des morceaux
    const labelSongs = document.createElement('label');
    labelSongs.textContent = 'Morceaux joués';
    const listDiv = document.createElement('div');
    listDiv.className = 'select-list';
    rehearsalsCache.forEach((song) => {
      const row = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = song.id;
      row.appendChild(checkbox);
      row.appendChild(document.createTextNode(song.title));
      listDiv.appendChild(row);
    });
    form.appendChild(labelName);
    form.appendChild(inputName);
    form.appendChild(labelDate);
    form.appendChild(inputDate);
    form.appendChild(labelLoc);
    form.appendChild(inputLoc);
    form.appendChild(labelSongs);
    form.appendChild(listDiv);
    content.appendChild(form);
    // Actions
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal); // or use modal.remove();
      }
    };
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Ajouter';
    okBtn.onclick = async (e) => {
      e.preventDefault();
      const name = inputName.value.trim();
      const dateVal = inputDate.value;
      const locVal = inputLoc.value.trim();
      if (!name || !dateVal) return;
      const selected = [];
      listDiv.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        if (cb.checked) selected.push(Number(cb.value));
      });
      let warn = false;
      for (const id of selected) {
        const s = rehearsalsCache.find((r) => r.id === id);
        if (s) {
          const levels = Object.values(s.levels || {}).map(Number);
          const min = levels.length ? Math.min(...levels) : 0;
          if (min <= 6) {
            warn = true;
            break;
          }
        }
      }
      if (warn &&
          !confirm(
            'Ce morceau n\u2019est probablement pas suffisamment r\u00e9p\u00e9t\u00e9. Ajouter quand m\u00eame ?'
          )) {
        return;
      }
      try {
        await api('/performances', 'POST', { name, date: dateVal, location: locVal, songs: selected });
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal); // or use modal.remove();
        }
        renderPerformances(container);
      } catch (err) {
        alert(err.message);
      }
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    content.appendChild(actions);
    modal.appendChild(content);
    document.body.appendChild(modal);
    setTimeout(() => inputName.focus(), 50);
  }

  /**
   * Affiche une modale pour modifier une prestation existante.  Les champs
   * sont pré-remplis avec les valeurs actuelles.
   */
  function showEditPerformanceModal(perf, container) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = 'Modifier la prestation';
    content.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => e.preventDefault();
    // Nom
    const labelName = document.createElement('label');
    labelName.textContent = 'Nom';
    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.required = true;
    inputName.style.width = '100%';
    inputName.value = perf.name;
    // Date
    const labelDate = document.createElement('label');
    labelDate.textContent = 'Date';
    const inputDate = document.createElement('input');
    inputDate.type = 'date';
    inputDate.required = true;
    inputDate.style.width = '100%';
    inputDate.value = perf.date;
    // Lieu
    const labelLoc = document.createElement('label');
    labelLoc.textContent = 'Lieu';
    const inputLoc = document.createElement('input');
    inputLoc.type = 'text';
    inputLoc.style.width = '100%';
    inputLoc.value = perf.location || '';
    // Morceaux
    const labelSongs = document.createElement('label');
    labelSongs.textContent = 'Morceaux joués';
    const listDiv = document.createElement('div');
    listDiv.className = 'select-list';
    rehearsalsCache.forEach((song) => {
      const row = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = song.id;
      if (perf.songs.includes(song.id)) checkbox.checked = true;
      row.appendChild(checkbox);
      row.appendChild(document.createTextNode(song.title));
      listDiv.appendChild(row);
    });
    form.appendChild(labelName);
    form.appendChild(inputName);
    form.appendChild(labelDate);
    form.appendChild(inputDate);
    form.appendChild(labelLoc);
    form.appendChild(inputLoc);
    form.appendChild(labelSongs);
    form.appendChild(listDiv);
    content.appendChild(form);
    // Actions
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal); // or use modal.remove();
      }
    };
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Enregistrer';
    okBtn.onclick = async (e) => {
      e.preventDefault();
      const name = inputName.value.trim();
      const dateVal = inputDate.value;
      const locVal = inputLoc.value.trim();
      if (!name || !dateVal) return;
      const selected = [];
      listDiv.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        if (cb.checked) selected.push(Number(cb.value));
      });
      let warn = false;
      for (const id of selected) {
        const s = rehearsalsCache.find((r) => r.id === id);
        if (s) {
          const levels = Object.values(s.levels || {}).map(Number);
          const min = levels.length ? Math.min(...levels) : 0;
          if (min <= 6) {
            warn = true;
            break;
          }
        }
      }
      if (warn &&
          !confirm(
            'Ce morceau n\u2019est probablement pas suffisamment r\u00e9p\u00e9t\u00e9. Enregistrer quand m\u00eame ?'
          )) {
        return;
      }
      try {
        await api(`/performances/${perf.id}`, 'PUT', { name, date: dateVal, location: locVal, songs: selected });
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal); // or use modal.remove();
        }
        renderPerformances(container);
      } catch (err) {
        alert(err.message);
      }
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    content.appendChild(actions);
    modal.appendChild(content);
    document.body.appendChild(modal);
    setTimeout(() => inputName.focus(), 50);
  }

  /**
   * Affiche une modale détaillant une prestation : nom, date et liste des
   * morceaux.  Chaque morceau est cliquable pour accéder à ses notes.
   */
  function showPerformanceDetail(perf) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = perf.name;
    content.appendChild(h3);
    const dateP = document.createElement('p');
    dateP.textContent = 'Date : ' + perf.date;
    content.appendChild(dateP);
    if (perf.location) {
      const locP = document.createElement('p');
      locP.textContent = 'Lieu : ' + perf.location;
      content.appendChild(locP);
    }
    // Liste des morceaux
    const ul = document.createElement('ul');
    if (perf.songs && perf.songs.length > 0) {
      perf.songs.forEach((id) => {
        const song = rehearsalsCache.find((r) => r.id === id);
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.href = '#';
        link.textContent = song ? song.title : '—';
        link.onclick = (e) => {
          e.preventDefault();
          if (song) {
            showSongDetail(song);
          }
        };
        li.appendChild(link);
        ul.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.textContent = 'Aucun morceau sélectionné.';
      ul.appendChild(li);
    }
    content.appendChild(ul);
    const closeDiv = document.createElement('div');
    closeDiv.className = 'modal-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-secondary';
    closeBtn.textContent = 'Fermer';
    closeBtn.onclick = () => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal); // or use modal.remove();
      }
    };
    closeDiv.appendChild(closeBtn);
    content.appendChild(closeDiv);
    modal.appendChild(content);
    document.body.appendChild(modal);
  }

  /**
   * Affiche la fiche détaillée d’un morceau (notes et niveau).  Permet de
   * modifier ses propres valeurs et d’afficher celles des autres.
   * @param {Object} song L’objet répétition correspondant au morceau
   */
  function showSongDetail(song) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = song.title;
    content.appendChild(h3);
    // Afficher le titre et les métadonnées (auteur et liens)
    const metaDiv = document.createElement('div');
    if (song.author) {
      const pAuth = document.createElement('p');
      pAuth.style.fontStyle = 'italic';
      pAuth.textContent = 'Auteur : ' + song.author;
      metaDiv.appendChild(pAuth);
    }
    if (song.youtube) {
      const ytA = document.createElement('a');
      ytA.href = song.youtube;
      ytA.target = '_blank';
      ytA.rel = 'noopener noreferrer';
      ytA.textContent = song.youtube;
      ytA.style.display = 'block';
      metaDiv.appendChild(ytA);
    }
    if (song.spotify) {
      const spA = document.createElement('a');
      spA.href = song.spotify;
      spA.target = '_blank';
      spA.rel = 'noopener noreferrer';
      spA.textContent = song.spotify;
      spA.style.display = 'block';
      metaDiv.appendChild(spA);
    }
    if (metaDiv.children.length > 0) {
      metaDiv.style.marginBottom = '8px';
      content.appendChild(metaDiv);
    }
    // Niveau
    const levelWrapper = document.createElement('div');
    levelWrapper.style.marginTop = '8px';
    const currentLevel = song.levels[currentUser.username] != null ? song.levels[currentUser.username] : 0;
    const levelLabel = document.createElement('label');
    levelLabel.textContent = `Votre niveau (${currentLevel}/10)`;
    levelLabel.className = 'level-display';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = 0;
    range.max = 10;
    range.step = 1;
    range.value = currentLevel;
    function updateRangeColor(val) {
      const percent = val / 10;
      const red = Math.round(255 * (1 - percent));
      const green = Math.round(255 * percent);
      range.style.background = `linear-gradient(to right, rgb(${red},${green},80) ${(val / 10) * 100}%, var(--border-color) ${(val / 10) * 100}%)`;
    }
    updateRangeColor(currentLevel);
    range.oninput = async () => {
      const val = Number(range.value);
      levelLabel.textContent = `Votre niveau (${val}/10)`;
      updateRangeColor(val);
      try {
        await api(`/rehearsals/${song.id}`, 'PUT', { level: val });
        // Mettre à jour localement pour éviter de recharger toute la liste
        song.levels[currentUser.username] = val;
      } catch (err) {
        alert(err.message);
      }
    };
    levelWrapper.appendChild(levelLabel);
    levelWrapper.appendChild(range);
    content.appendChild(levelWrapper);
    // Notes
    const notesLabel = document.createElement('label');
    notesLabel.textContent = 'Vos notes';
    const textarea = document.createElement('textarea');
    textarea.value = (song.notes && song.notes[currentUser.username]) || '';
    textarea.onchange = async () => {
      try {
        await api(`/rehearsals/${song.id}`, 'PUT', { note: textarea.value });
        song.notes[currentUser.username] = textarea.value;
      } catch (err) {
        alert(err.message);
      }
    };
    content.appendChild(notesLabel);
    content.appendChild(textarea);

    // Note audio pour l'utilisateur courant
    const audioSection = document.createElement('div');
    audioSection.style.marginTop = '8px';
    const myAudio = song.audioNotes && song.audioNotes[currentUser.username];
    if (myAudio) {
      const audioPlayer2 = document.createElement('audio');
      audioPlayer2.controls = true;
      // La note audio est stockée sous forme de DataURL complet
      audioPlayer2.src = myAudio;
      audioSection.appendChild(audioPlayer2);
      const delAudioBtn2 = document.createElement('button');
      delAudioBtn2.className = 'btn-danger';
      delAudioBtn2.textContent = 'Supprimer audio';
      delAudioBtn2.style.marginLeft = '8px';
      delAudioBtn2.onclick = async (e) => {
        e.preventDefault();
        if (!confirm('Supprimer la note audio ?')) return;
        try {
          await api(`/rehearsals/${song.id}`, 'PUT', { audio: '' });
          // Mettre à jour l'objet local et rafraîchir l'affichage
          delete song.audioNotes[currentUser.username];
          // Fermer la modale actuelle et en ouvrir une nouvelle pour refléter l'état
          modal.remove();
          showSongDetail(song);
        } catch (err) {
          alert(err.message);
        }
      };
      audioSection.appendChild(delAudioBtn2);
    } else {
      const fileInp = document.createElement('input');
      fileInp.type = 'file';
      fileInp.accept = 'audio/*';
      fileInp.style.display = 'none';
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-secondary';
      addBtn.textContent = 'Ajouter une note audio';
      addBtn.onclick = (e) => {
        e.preventDefault();
        fileInp.click();
      };
      fileInp.onchange = async () => {
        const f = fileInp.files[0];
        if (!f) return;
        if (f.size > 5 * 1024 * 1024) {
          alert('Le fichier audio est trop volumineux (max 5 Mo).');
          return;
        }
        const reader2 = new FileReader();
        reader2.onload = async (ev) => {
          // Transmettez l’URL de données complète (avec MIME type)
          const dataUrl = (ev.target?.result || '').toString();
          try {
            await api(`/rehearsals/${song.id}`, 'PUT', { audio: dataUrl });
            song.audioNotes = song.audioNotes || {};
            song.audioNotes[currentUser.username] = dataUrl;
            // Réafficher la modale avec l'audio nouvellement ajouté
            modal.remove();
            showSongDetail(song);
          } catch (err) {
            alert(err.message);
          }
        };
        reader2.readAsDataURL(f);
      };
      audioSection.appendChild(addBtn);
      audioSection.appendChild(fileInp);
    }
    content.appendChild(audioSection);
    // Autres membres
    // Filtrer en ignorant la casse pour éviter la duplication de l’utilisateur courant
    const others = Object.keys(song.levels || {}).filter((u) => u.toLowerCase() !== currentUser.username.toLowerCase());
    if (others.length > 0) {
      // Afficher les autres membres, leurs niveaux, notes et leurs éventuelles notes audio
      const othersDiv = document.createElement('div');
      othersDiv.style.marginTop = '12px';
      const otherTitle = document.createElement('p');
      otherTitle.textContent = 'Autres membres :';
      otherTitle.style.fontStyle = 'italic';
      othersDiv.appendChild(otherTitle);
      others.forEach((u) => {
        const wrapper = document.createElement('div');
        wrapper.style.marginBottom = '6px';
        const lev = song.levels[u];
        const note = song.notes && song.notes[u] ? song.notes[u] : '';
        const p = document.createElement('p');
        p.style.margin = '0';
        p.innerHTML = `<strong>${u}</strong> – Niveau ${lev}/10${note ? ' – ' + note : ''}`;
        wrapper.appendChild(p);
        // Afficher la note audio pour cet utilisateur si elle existe
        const audioB64 = song.audioNotes && song.audioNotes[u];
        if (audioB64) {
          const audioEl = document.createElement('audio');
          audioEl.controls = true;
          // audioB64 contient désormais une URL de données complète
          audioEl.src = audioB64;
          audioEl.style.display = 'block';
          audioEl.style.marginTop = '4px';
          wrapper.appendChild(audioEl);
        }
        othersDiv.appendChild(wrapper);
      });
      content.appendChild(othersDiv);
    }
    const closeDiv = document.createElement('div');
    closeDiv.className = 'modal-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-secondary';
    closeBtn.textContent = 'Fermer';
    closeBtn.onclick = () => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal); // or use modal.remove();
      }
    };
    closeDiv.appendChild(closeBtn);
    content.appendChild(closeDiv);
    modal.appendChild(content);
    document.body.appendChild(modal);
  }

  /**
   * Rendu de la page paramètres.  Permet de modifier le nom du groupe,
   * d’activer le mode sombre ou clair et de se déconnecter.
   * @param {HTMLElement} container
   */
  async function renderSettings(container) {
    container.innerHTML = '';
    const header = document.createElement('h2');
    header.textContent = 'Paramètres';
    container.appendChild(header);
    let settings;
    try {
      settings = await api('/settings');
    } catch (err) {
      const p = document.createElement('p');
      p.style.color = 'var(--danger-color)';
      p.textContent = 'Impossible de récupérer les paramètres';
      container.appendChild(p);
      return;
    }
    // Nom du groupe
    const labelName = document.createElement('label');
    labelName.textContent = 'Nom du groupe';
    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.value = settings.groupName;
    inputName.style.width = '100%';
    inputName.onchange = async () => {
      try {
        await api('/settings', 'PUT', { groupName: inputName.value, darkMode: settings.darkMode });
        document.title = `${inputName.value} – BandTrack`;
      } catch (err) {
        alert(err.message);
      }
    };
    container.appendChild(labelName);
    container.appendChild(inputName);
    // Mode sombre
    const modeDiv = document.createElement('div');
    modeDiv.style.marginTop = '20px';
    const modeLabel = document.createElement('label');
    modeLabel.textContent = 'Mode sombre';
    modeLabel.style.marginRight = '8px';
    const modeCheckbox = document.createElement('input');
    modeCheckbox.type = 'checkbox';
    modeCheckbox.checked = settings.darkMode;
    modeCheckbox.onchange = async () => {
      try {
        await api('/settings', 'PUT', { groupName: inputName.value, darkMode: modeCheckbox.checked, template: settings.template });
        applyTheme(modeCheckbox.checked);
      } catch (err) {
        alert(err.message);
      }
    };
    modeDiv.appendChild(modeLabel);
    modeDiv.appendChild(modeCheckbox);
    container.appendChild(modeDiv);

    // Prochaine répétition (date/heure)
    const labelDate = document.createElement('label');
    labelDate.textContent = 'Prochaine répétition (date/heure)';
    labelDate.style.marginTop = '20px';
    const inputDate = document.createElement('input');
    inputDate.type = 'datetime-local';
    inputDate.value = settings.nextRehearsalDate || '';
    inputDate.style.width = '100%';
    inputDate.onchange = async () => {
      try {
        await api('/settings', 'PUT', {
          groupName: inputName.value,
          darkMode: modeCheckbox.checked,
          template: settings.template,
          nextRehearsalDate: inputDate.value,
          nextRehearsalLocation: inputLocation.value,
        });
      } catch (err) {
        alert(err.message);
      }
    };
    container.appendChild(labelDate);
    container.appendChild(inputDate);

    // Lieu de la prochaine répétition
    const labelLocation = document.createElement('label');
    labelLocation.textContent = 'Lieu de la prochaine répétition';
    labelLocation.style.marginTop = '12px';
    const inputLocation = document.createElement('input');
    inputLocation.type = 'text';
    inputLocation.value = settings.nextRehearsalLocation || '';
    inputLocation.style.width = '100%';
    inputLocation.onchange = async () => {
      try {
        await api('/settings', 'PUT', {
          groupName: inputName.value,
          darkMode: modeCheckbox.checked,
          template: settings.template,
          nextRehearsalDate: inputDate.value,
          nextRehearsalLocation: inputLocation.value,
        });
      } catch (err) {
        alert(err.message);
      }
    };
    container.appendChild(labelLocation);
    container.appendChild(inputLocation);

    // Sélecteur de template (design)
    const templateDiv = document.createElement('div');
    templateDiv.style.marginTop = '20px';
    const templateLabel = document.createElement('label');
    templateLabel.textContent = 'Template (design)';
    templateLabel.style.marginRight = '8px';
    const templateSelect = document.createElement('select');
    // Définition des templates disponibles
    const templateOptions = [
      { value: 'classic', label: 'Classique' },
      { value: 'groove', label: 'Groove' },
    ];
    templateOptions.forEach((opt) => {
      const optEl = document.createElement('option');
      optEl.value = opt.value;
      optEl.textContent = opt.label;
      templateSelect.appendChild(optEl);
    });
    templateSelect.value = settings.template || 'classic';
    templateSelect.onchange = async () => {
      const val = templateSelect.value;
      try {
        await api('/settings', 'PUT', {
          groupName: inputName.value,
          darkMode: modeCheckbox.checked,
          template: val,
        });
        // Mettre à jour le setting local
        settings.template = val;
        applyTemplate(val);
      } catch (err) {
        alert(err.message);
      }
    };
    templateDiv.appendChild(templateLabel);
    templateDiv.appendChild(templateSelect);
    container.appendChild(templateDiv);

    // Configuration WebAuthn
    const webAuthnBtn = document.createElement('button');
    webAuthnBtn.className = 'btn-secondary';
    webAuthnBtn.style.marginTop = '20px';
    webAuthnBtn.textContent = 'Configurer la biométrie';
    webAuthnBtn.onclick = async () => {
      try {
        const opts = await api('/webauthn/register', 'POST');
        const att = await SimpleWebAuthnBrowser.startRegistration(opts);
        await api('/webauthn/verify-register', 'POST', att);
        webAuthnVerified = true;
        alert('Clé enregistrée');
      } catch (err) {
        alert(err.message);
      }
    };
    container.appendChild(webAuthnBtn);
    // Déconnexion
    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'logout-btn';
    logoutBtn.textContent = 'Se déconnecter';
    logoutBtn.onclick = async () => {
      try {
        await api('/logout', 'POST');
        currentUser = null;
        webAuthnVerified = false;
        renderApp();
      } catch (err) {
        alert(err.message);
      }
    };
    container.appendChild(logoutBtn);

    // Gestion des utilisateurs (visible uniquement pour les administrateurs)
    if (isAdmin()) {
      try {
        const users = await api('/users');
        const adminHeader = document.createElement('h3');
        adminHeader.style.marginTop = '30px';
        adminHeader.textContent = 'Gestion des utilisateurs';
        container.appendChild(adminHeader);
        const table = document.createElement('table');
        table.className = 'user-table';
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>Utilisateur</th><th>Rôle</th></tr>';
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        const initialState = {};
        users.forEach((u) => {
          initialState[u.id] = u.role;
          const tr = document.createElement('tr');
          const nameTd = document.createElement('td');
          nameTd.textContent = u.username;
          const roleTd = document.createElement('td');
          const select = document.createElement('select');
          ['user', 'moderator', 'admin'].forEach((r) => {
            const opt = document.createElement('option');
            opt.value = r;
            opt.textContent = r;
            if (u.role === r) opt.selected = true;
            select.appendChild(opt);
          });
          if (u.id === currentUser.id) select.disabled = true;
          select.dataset.userId = u.id;
          roleTd.appendChild(select);
          tr.appendChild(nameTd);
          tr.appendChild(roleTd);
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        container.appendChild(table);
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-primary';
        saveBtn.style.marginTop = '10px';
        saveBtn.textContent = 'Enregistrer les rôles';
        saveBtn.onclick = async () => {
          try {
            await ensureBiometric();
            const updates = [];
            tbody.querySelectorAll('select').forEach((sel) => {
              const uid = Number(sel.dataset.userId);
              const newVal = sel.value;
              if (initialState[uid] !== newVal) {
                updates.push({ id: uid, role: newVal });
              }
            });
            for (const upd of updates) {
              await api(`/users/${upd.id}`, 'PUT', { role: upd.role });
            }
            alert('Rôles mis à jour');
            renderSettings(container);
          } catch (err) {
            alert(err.message);
          }
        };
        container.appendChild(saveBtn);
      } catch (err) {
        const p = document.createElement('p');
        p.style.color = 'var(--danger-color)';
        p.textContent = 'Impossible de récupérer les utilisateurs';
        container.appendChild(p);
      }
    }
  }

  // Lancement de l’application lorsque le DOM est prêt
  window.addEventListener('DOMContentLoaded', initApp);
})();
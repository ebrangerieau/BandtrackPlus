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
import { state, resetCaches } from "../state.js";
import { api, syncRehearsalsCache, uploadPartition, deletePartition } from "../api.js";
import { checkSession, handleLogout, applyTheme, applyTemplate } from "../auth.js";


  let currentUser = null;
  let currentPage = 'home';

  // Cache des répétitions pour éviter de relancer trop souvent la requête
  let rehearsalsCache = [];

  // Gestion des groupes
  let groupsCache = [];
  let activeGroupId = null;

  // Mois actuellement affiché dans l'agenda
  let agendaDate = new Date();
Object.defineProperties(state, {
  currentUser: { get: () => currentUser, set: v => currentUser = v },
  currentPage: { get: () => currentPage, set: v => currentPage = v },
  rehearsalsCache: { get: () => rehearsalsCache, set: v => rehearsalsCache = v },
  groupsCache: { get: () => groupsCache, set: v => groupsCache = v },
  activeGroupId: { get: () => activeGroupId, set: v => activeGroupId = v },
  agendaDate: { get: () => agendaDate, set: v => agendaDate = v },
});


  // Ferme le menu lorsqu'on clique à l'extérieur
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('profile-menu');
    const hamburger = document.getElementById('hamburger');
    if (!menu) return;
    if (
      !menu.classList.contains('hidden') &&
      !menu.contains(e.target) &&
      e.target !== hamburger && !hamburger?.contains(e.target)
    ) {
      menu.classList.add('hidden');
      menu.classList.remove('block', 'open');
      hamburger?.classList.remove('open');
    }
  });

  function toggleMenu() {
    const menu = document.getElementById('profile-menu');
    const btn = document.getElementById('hamburger');
    if (!menu || !btn) return;
    menu.classList.toggle('hidden');
    menu.classList.toggle('block');
    menu.classList.toggle('open');
    btn.classList.toggle('open');
    const bars = btn.querySelectorAll('span');
    if (bars.length === 3) {
      bars[0].classList.toggle('translate-y-1.5');
      bars[0].classList.toggle('rotate-45');
      bars[1].classList.toggle('opacity-0');
      bars[2].classList.toggle('-translate-y-1.5');
      bars[2].classList.toggle('-rotate-45');
    }
  }

  function hasModRights() {
    return currentUser && (currentUser.membershipRole === 'admin' || currentUser.membershipRole === 'moderator');
  }
  function isAdmin() {
    return currentUser && currentUser.membershipRole === 'admin';
  }

  function formatDateTime(str) {
    if (!str) return '';
    const date = new Date(str);
    if (isNaN(date)) {
      return str;
    }
    return date.toLocaleString('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
      hour12: false,
    });
  }

  async function handleDeleteAccount() {
    const confirmed = confirm('Êtes-vous sûr de vouloir supprimer votre compte ?');
    if (!confirmed) return;
    try {
      await api('/me', 'DELETE');
      currentUser = null;
      renderApp();
    } catch (err) {
      alert(err.message);
    }
  }

  async function changeGroup(id) {
    await api('/context', 'PUT', { groupId: Number(id) });
    localStorage.setItem('activeGroupId', String(id));
    activeGroupId = Number(id);
    resetCaches();
    await checkSession();
  }

  async function refreshGroups(forceId) {
    if (!currentUser) return;
    const select = document.getElementById('group-select');
    const createBtn = document.getElementById('create-group-btn');
    const joinBtn = document.getElementById('join-group-btn');
    if (createBtn) createBtn.onclick = () => showCreateGroupDialog();
    if (joinBtn) joinBtn.onclick = () => showJoinGroupDialog();
    try {
      groupsCache = await api('/groups');
      let selected = forceId || localStorage.getItem('activeGroupId');
      if (!groupsCache.some((g) => String(g.id) === String(selected))) {
        selected = groupsCache[0] ? groupsCache[0].id : null;
      }
      if (select) {
        select.innerHTML = '';
        groupsCache.forEach((g) => {
          const opt = document.createElement('option');
          opt.value = g.id;
          opt.textContent = g.name;
          select.appendChild(opt);
        });
        if (selected) {
          select.value = selected;
        }
        select.onchange = async () => {
          await changeGroup(select.value);
          renderMain(document.getElementById('app'));
        };
      }
      if (selected) {
        await changeGroup(selected);
      }
    } catch (err) {
      console.error(err);
    }
  }

  function showCreateGroupDialog() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = 'Créer un groupe';
    content.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => e.preventDefault();
    const labelName = document.createElement('label');
    labelName.textContent = 'Nom du groupe';
    const inputName = document.createElement('input');
    inputName.type = 'text';
    inputName.required = true;
    inputName.style.width = '100%';
    form.appendChild(labelName);
    form.appendChild(inputName);
    content.appendChild(form);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => modal.remove();
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Créer';
    okBtn.onclick = async () => {
      const name = inputName.value.trim();
      if (!name) return;
      try {
        const data = await api('/groups', 'POST', { name });
        alert('Code d\'invitation : ' + data.invitationCode);
        modal.remove();
        await refreshGroups(data.id);
        renderMain(document.getElementById('app'));
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

  function showJoinGroupDialog() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = 'Rejoindre un groupe';
    content.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => e.preventDefault();
    const labelCode = document.createElement('label');
    labelCode.textContent = 'Code d\'invitation';
    const inputCode = document.createElement('input');
    inputCode.type = 'text';
    inputCode.required = true;
    inputCode.style.width = '100%';
    const labelNick = document.createElement('label');
    labelNick.textContent = 'Surnom';
    const inputNick = document.createElement('input');
    inputNick.type = 'text';
    inputNick.style.width = '100%';
    form.appendChild(labelCode);
    form.appendChild(inputCode);
    form.appendChild(labelNick);
    form.appendChild(inputNick);
    content.appendChild(form);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => modal.remove();
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Rejoindre';
    okBtn.onclick = async () => {
      const code = inputCode.value.trim();
      const nickname = inputNick.value.trim();
      if (!code) return;
      try {
        const data = await api('/groups/join', 'POST', { code, nickname });
        modal.remove();
        await refreshGroups(data.groupId);
        renderMain(document.getElementById('app'));
      } catch (err) {
        alert(err.message);
      }
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    content.appendChild(actions);
    modal.appendChild(content);
    document.body.appendChild(modal);
    setTimeout(() => inputCode.focus(), 50);
  }

  /**
   * Initialise l’application au chargement de la page.  Cette fonction est
   * déclenchée par l’événement `DOMContentLoaded` défini à la fin du fichier.
   */
  async function initApp() {
    await checkSession();
    if (currentUser) {
      await refreshGroups();
    }
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
      const groupNameEl = document.getElementById('group-name');
      if (groupNameEl) groupNameEl.textContent = '';
      resetCaches();
      renderAuth(app);
    } else if (currentUser.needsGroup) {
      renderGroupSetup(app);
    } else {
      renderMain(app);
    }
  }

  function renderGroupSetup(app) {
    app.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'auth-container';
    const h2 = document.createElement('h2');
    h2.textContent = 'Rejoindre ou créer un groupe';
    container.appendChild(h2);
    const p = document.createElement('p');
    p.textContent = 'Vous devez sélectionner ou créer un groupe pour continuer.';
    container.appendChild(p);
    const p2 = document.createElement('p');
    p2.textContent = "Pour rejoindre un groupe existant, munissez-vous de son code d'invitation ou demandez à un administrateur de vous ajouter directement.";
    container.appendChild(p2);
    const btnRow = document.createElement('div');
    const createBtn = document.createElement('button');
    createBtn.className = 'btn-primary';
    createBtn.textContent = 'Créer un groupe';
    createBtn.onclick = () => showCreateGroupDialog();
    btnRow.appendChild(createBtn);
    const joinBtn = document.createElement('button');
    joinBtn.className = 'btn-secondary';
    joinBtn.style.marginLeft = '10px';
    joinBtn.textContent = 'Rejoindre un groupe';
    joinBtn.onclick = () => showJoinGroupDialog();
    btnRow.appendChild(joinBtn);
    container.appendChild(btnRow);
    const deleteBtn = document.createElement('button');
    deleteBtn.id = 'delete-account-btn-group-setup';
    deleteBtn.className = 'delete-account-btn';
    deleteBtn.textContent = 'Supprimer mon compte';
    deleteBtn.onclick = handleDeleteAccount;
    container.appendChild(deleteBtn);
    app.appendChild(container);
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
        // no biometric login
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
          currentPage = 'home';
          await refreshGroups();
          renderApp();
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
          currentPage = 'home';
          await refreshGroups();
          renderApp();
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

    let nextPerfInfo = 'Aucune prestation prévue';
    try {
      const list = await api('/performances');
      const now = new Date();
      const upcoming = list.filter((p) => new Date(p.date) >= now);
      upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));
      if (upcoming.length > 0) {
        const p = upcoming[0];
        nextPerfInfo = `${p.name} (${formatDateTime(p.date)})`;
      }
    } catch (err) {
      nextPerfInfo = 'Impossible de récupérer les prestations';
    }
    const perfP = document.createElement('p');
    const perfStrong = document.createElement('strong');
    perfStrong.textContent = 'Prochaine prestation :';
    perfP.appendChild(perfStrong);
    perfP.appendChild(document.createTextNode(' ' + nextPerfInfo));
    container.appendChild(perfP);

    let nextRehearsalInfo = '—';
    try {
      const list = await api('/agenda');
      const rehearsals = list.filter((item) => item.type === 'rehearsal');
      const now = new Date();
      const upcoming = rehearsals.filter((r) => new Date(r.date) >= now);
      upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));
      if (upcoming.length > 0) {
        const r = upcoming[0];
        nextRehearsalInfo = `${formatDateTime(r.date)}${r.location ? ' – ' + r.location : ''}`;
      }
    } catch (err) {
      // ignore errors
    }
    const rehP = document.createElement('p');
    const rehStrong = document.createElement('strong');
    rehStrong.textContent = 'Prochaine répétition :';
    rehP.appendChild(rehStrong);
    rehP.appendChild(document.createTextNode(' ' + nextRehearsalInfo));
    container.appendChild(rehP);

  }

  /**
   * Rendu principal de l’application une fois l’utilisateur authentifié.
   * Initialise la barre de navigation et appelle la fonction de rendu
   * correspondant à la page sélectionnée.
   * @param {HTMLElement} app
   */
  async function renderMain(app) {
    app.innerHTML = '';
    const hamburgerBtn = document.getElementById('hamburger');
    const profileMenu = document.getElementById('profile-menu');
    const perfBtn = document.getElementById('menu-performances');
    const settingsBtn = document.getElementById('menu-settings');
    const logoutMenuBtn = document.getElementById('menu-logout');
    if (hamburgerBtn && profileMenu) {
      hamburgerBtn.onclick = (e) => {
        e.stopPropagation();
        toggleMenu();
      };
    }
    if (perfBtn) {
      perfBtn.onclick = () => {
        if (currentPage !== 'performances') {
          currentPage = 'performances';
          renderMain(app);
        }
        if (!profileMenu?.classList.contains('hidden')) toggleMenu();
      };
    }
    if (settingsBtn) {
      settingsBtn.onclick = () => {
        if (currentPage !== 'settings') {
          currentPage = 'settings';
          renderMain(app);
        }
        if (!profileMenu?.classList.contains('hidden')) toggleMenu();
      };
    }
    if (logoutMenuBtn) {
      logoutMenuBtn.onclick = async () => {
        if (!profileMenu?.classList.contains('hidden')) toggleMenu();
        await handleLogout();
      };
    }
    const pageDiv = document.createElement('div');
    pageDiv.className = 'page';
    app.appendChild(pageDiv);
    // Barre de navigation
    const nav = document.createElement('div');
    nav.className = 'nav-bar';
    const navItems = [
      { key: 'home', label: 'Accueil' },
      { key: 'suggestions', label: 'Propositions' },
      { key: 'rehearsals', label: 'En cours' },
      { key: 'agenda', label: 'Agenda' },
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
      try {
        await syncRehearsalsCache();
      } catch (err) {
        // ignore
      }
      renderRehearsals(pageDiv);
    } else if (currentPage === 'performances') {
      try {
        await syncRehearsalsCache();
      } catch (err) {
        // ignore
      }
      renderPerformances(pageDiv);
    } else if (currentPage === 'agenda') {
      try {
        await syncRehearsalsCache();
      } catch (err) {
        // ignore
      }
      renderAgenda(pageDiv);
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
    header.className = 'section-title';
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
    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Aucune proposition pour l\u2019instant';
      container.appendChild(empty);
    }
    // Afficher la liste
    list.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'card collapsed bg-white rounded-lg shadow-md p-4 bg-pink-50';

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
        likeBtn.disabled = true;
        dislikeBtn.disabled = true;
        try {
          const updated = await api(`/suggestions/${item.id}/vote`, 'POST');
          likeCount.textContent = `❤️ ${updated.likes}`;
          await renderSuggestions(container);
        } catch (err) {
          alert(err.message);
          likeBtn.disabled = false;
          dislikeBtn.disabled = false;
        }
      };

      const dislikeBtn = document.createElement('button');
      dislikeBtn.className = 'like-btn';
      dislikeBtn.textContent = '👎';
      dislikeBtn.onclick = async (e) => {
        e.stopPropagation();
        likeBtn.disabled = true;
        dislikeBtn.disabled = true;
        try {
          const updated = await api(`/suggestions/${item.id}/vote`, 'DELETE');
          likeCount.textContent = `❤️ ${updated.likes}`;
          await renderSuggestions(container);
        } catch (err) {
          alert(err.message);
          likeBtn.disabled = false;
          dislikeBtn.disabled = false;
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
      if (item.versionOf) {
        const verP = document.createElement('p');
        verP.style.fontStyle = 'italic';
        verP.textContent = 'Version de : ' + item.versionOf;
        details.appendChild(verP);
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
            const newReh = await api(`/suggestions/${item.id}/to-rehearsal`, 'POST');
            rehearsalsCache.push(newReh);
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
    // Version de
    const labelVersion = document.createElement('label');
    labelVersion.textContent = 'Version de';
    const inputVersion = document.createElement('input');
    inputVersion.type = 'text';
    inputVersion.style.width = '100%';
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
    form.appendChild(labelVersion);
    form.appendChild(inputVersion);
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
      const versionOf = inputVersion.value.trim();
      const youtube = inputYt.value.trim();
      if (!title) return;
      try {
        await api('/suggestions', 'POST', { title, author, youtube, versionOf });
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
    const labelVersion = document.createElement('label');
    labelVersion.textContent = 'Version de';
    const inputVersion = document.createElement('input');
    inputVersion.type = 'text';
    inputVersion.style.width = '100%';
    inputVersion.value = item.versionOf || '';

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
    form.appendChild(labelVersion);
    form.appendChild(inputVersion);
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
      const versionVal = inputVersion.value.trim();
      const youtubeVal = inputYt.value.trim();
      if (!titleVal) return;
      try {
        await api(`/suggestions/${item.id}`, 'PUT', {
          title: titleVal,
          author: authorVal,
          versionOf: versionVal,
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
    header.className = 'section-title';
    container.appendChild(header);
    let list = rehearsalsCache;
    if (list.length === 0) {
      try {
        await syncRehearsalsCache();
        list = rehearsalsCache;
      } catch (err) {
        const p = document.createElement('p');
        p.style.color = 'var(--danger-color)';
        p.textContent = 'Impossible de récupérer les répétitions';
        container.appendChild(p);
        return;
      }
    }
    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Aucun morceau en répétition';
      container.appendChild(empty);
    }

    list.forEach((song) => {
      const card = document.createElement('div');
      card.className = 'card collapsed bg-white rounded-lg shadow-md p-4 bg-blue-50';
      // Niveau courant de l'utilisateur pour ce morceau
      const currentLevel =
        song.levels[currentUser.username] != null
          ? song.levels[currentUser.username]
          : 0;
      // En-tête du carton avec titre et niveau
      const headerDiv = document.createElement('div');
      headerDiv.className = 'card-header';
      const h3 = document.createElement('h3');
      h3.textContent = song.title;
      h3.onclick = () => {
        card.classList.toggle('collapsed');
      };
      headerDiv.appendChild(h3);
      const levelBadge = document.createElement('span');
      levelBadge.className = 'level-badge';
      levelBadge.textContent = currentLevel;
      headerDiv.appendChild(levelBadge);
      card.appendChild(headerDiv);
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
        levelBadge.textContent = val;
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

      // Notes audio pour l'utilisateur courant
      const audioSection = document.createElement('div');
      audioSection.style.marginTop = '8px';
      const myAudios = (song.audioNotes && song.audioNotes[currentUser.username]) || [];
      myAudios.forEach((note, idx) => {
        const wrapper = document.createElement('div');
        if (note.title) {
          const t = document.createElement('div');
          t.textContent = note.title;
          wrapper.appendChild(t);
        }
        const player = document.createElement('audio');
        player.controls = true;
        player.src = note.audio;
        wrapper.appendChild(player);
        const del = document.createElement('button');
        del.className = 'btn-danger';
        del.textContent = 'Supprimer audio';
        del.style.marginLeft = '8px';
        del.onclick = async (e) => {
          e.preventDefault();
          if (!confirm('Supprimer la note audio ?')) return;
          try {
            await api(`/rehearsals/${song.id}`, 'PUT', { audioIndex: idx });
            renderRehearsals(container);
          } catch (err) {
            alert(err.message);
          }
        };
        wrapper.appendChild(del);
        audioSection.appendChild(wrapper);
      });
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.placeholder = 'Titre de la note';
      titleInput.style.display = 'block';
      titleInput.style.marginTop = '8px';
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
        if (file.size > 5 * 1024 * 1024) {
          alert('Le fichier audio est trop volumineux (max 5 Mo).');
          return;
        }
        const reader = new FileReader();
        reader.onload = async (ev) => {
          const dataUrl = (ev.target?.result || '').toString();
          try {
            await api(`/rehearsals/${song.id}`, 'PUT', { audio: dataUrl, audioTitle: titleInput.value });
            renderRehearsals(container);
          } catch (err) {
            alert(err.message);
          }
        };
        reader.readAsDataURL(file);
      };
      audioSection.appendChild(titleInput);
      audioSection.appendChild(uploadBtn);
      audioSection.appendChild(fileInput);
      details.appendChild(audioSection);
      if (currentUser) {
        // Partitions
        const partSection = document.createElement('div');
        partSection.style.marginTop = '8px';
        const partLabel = document.createElement('label');
        partLabel.textContent = 'Partition(s)';
        partSection.appendChild(partLabel);
        const partList = document.createElement('div');
        (song.partitions || []).forEach((p) => {
          const row = document.createElement('div');
          const info = document.createElement('span');
          info.textContent = `${p.displayName} – ${p.uploader} – ${formatDateTime(p.date)}`;
          row.appendChild(info);
          const dl = document.createElement('a');
          dl.href = p.downloadUrl;
          dl.textContent = 'Télécharger';
          dl.target = '_blank';
          dl.rel = 'noopener noreferrer';
          dl.className = 'btn-secondary';
          dl.style.marginLeft = '8px';
          row.appendChild(dl);
          if (p.uploader === currentUser.username || isAdmin()) {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-danger';
            delBtn.textContent = 'Supprimer';
            delBtn.style.marginLeft = '8px';
            delBtn.onclick = async (e) => {
              e.preventDefault();
              if (!confirm('Supprimer cette partition ?')) return;
              try {
                await deletePartition(song.id, p.id);
                await syncRehearsalsCache();
                renderRehearsals(container);
              } catch (err) {
                alert(err.message);
              }
            };
            row.appendChild(delBtn);
          }
          partList.appendChild(row);
        });
        partSection.appendChild(partList);
        const partInput = document.createElement('input');
        partInput.type = 'file';
        partInput.accept = 'application/pdf';
        partInput.style.display = 'none';
        const partBtn = document.createElement('button');
        partBtn.className = 'btn-secondary';
        partBtn.textContent = 'Déposer une partition';
        partBtn.onclick = (e) => {
          e.preventDefault();
          partInput.click();
        };
        partInput.onchange = async () => {
          const file = partInput.files[0];
          if (!file) return;
          try {
            await uploadPartition(song.id, file, file.name);
            await syncRehearsalsCache();
            renderRehearsals(container);
          } catch (err) {
            alert(err.message);
          }
        };
        partSection.appendChild(partBtn);
        partSection.appendChild(partInput);
        details.appendChild(partSection);
      }
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
          const userStrong = document.createElement('strong');
          userStrong.textContent = u;
          pUser.appendChild(userStrong);
          pUser.appendChild(document.createTextNode(` – Niveau ${lev}/10${note ? ' – ' + note : ''}`));
          wrapper.appendChild(pUser);
          const otherAudios = (song.audioNotes && song.audioNotes[u]) || [];
          otherAudios.forEach((note) => {
            const audioEl = document.createElement('audio');
            audioEl.controls = true;
            audioEl.src = note.audio;
            audioEl.style.display = 'block';
            audioEl.style.marginTop = '4px';
            if (note.title) {
              const t = document.createElement('div');
              t.textContent = note.title;
              t.style.marginTop = '4px';
              wrapper.appendChild(t);
            }
            wrapper.appendChild(audioEl);
          });
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
            rehearsalsCache = rehearsalsCache.filter((r) => r.id !== song.id);
            renderRehearsals(container);
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
  function showAddRehearsalModal(container, afterSave) {
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
    // Version de
    const labelVersion = document.createElement('label');
    labelVersion.textContent = 'Version de';
    const inputVersion = document.createElement('input');
    inputVersion.type = 'text';
    inputVersion.style.width = '100%';
    form.appendChild(labelTitle);
    form.appendChild(inputTitle);
    form.appendChild(labelAuthor);
    form.appendChild(inputAuthor);
    form.appendChild(labelYt);
    form.appendChild(inputYt);
    form.appendChild(labelSp);
    form.appendChild(inputSp);
    form.appendChild(labelVersion);
    form.appendChild(inputVersion);
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
      const versionOf = inputVersion.value.trim();
      try {
        const newSong = await api('/rehearsals', 'POST', {
          title,
          author,
          youtube,
          spotify,
          versionOf,
        });
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal); // or use modal.remove();
        }
        rehearsalsCache.push(newSong);
        if (typeof afterSave === 'function') afterSave();
        else renderRehearsals(container);
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
   * @param {Function?} afterSave Fonction appelée après sauvegarde
   */
  function showEditRehearsalModal(song, container, afterSave) {
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
    // Version de
    const labelVersion = document.createElement('label');
    labelVersion.textContent = 'Version de';
    const inputVersion = document.createElement('input');
    inputVersion.type = 'text';
    inputVersion.style.width = '100%';
    inputVersion.value = song.versionOf || '';
    form.appendChild(labelTitle);
    form.appendChild(inputTitle);
    form.appendChild(labelAuthor);
    form.appendChild(inputAuthor);
    form.appendChild(labelYt);
    form.appendChild(inputYt);
    form.appendChild(labelSp);
    form.appendChild(inputSp);
    form.appendChild(labelVersion);
    form.appendChild(inputVersion);
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
      const versionVal = inputVersion.value.trim();
      if (!titleVal) return;
      try {
        await api(`/rehearsals/${song.id}`, 'PUT', {
          title: titleVal,
          author: authorVal,
          youtube: ytVal,
          spotify: spVal,
          versionOf: versionVal,
        });
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal); // or use modal.remove();
        }
        const idx = rehearsalsCache.findIndex((r) => r.id === song.id);
        if (idx !== -1) {
          rehearsalsCache[idx] = {
            ...rehearsalsCache[idx],
            title: titleVal,
            author: authorVal || null,
            youtube: ytVal || null,
            spotify: spVal || null,
            versionOf: versionVal || null,
          };
        }
        if (typeof afterSave === 'function') afterSave();
        else {
          // Actualiser la page des répétitions
          renderRehearsals(container);
        }
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
    header.className = 'section-title';
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
        await syncRehearsalsCache();
      } catch (err) {
        // ignore
      }
    }
    const now = new Date();
    const upcoming = list.filter((p) => new Date(p.date) >= now);
    const past = list.filter((p) => new Date(p.date) < now);
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
        card.className = 'card collapsed bg-white rounded-lg shadow-md p-4 bg-green-50';
        const h3 = document.createElement('h3');
        h3.textContent = perf.name;
        h3.onclick = () => {
          card.classList.toggle('collapsed');
        };
        card.appendChild(h3);
        const details = document.createElement('div');
        details.className = 'card-details';
        const dateP = document.createElement('p');
        dateP.textContent = 'Date : ' + formatDateTime(perf.date);
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
   * Affiche l'agenda des répétitions et prestations.
   * @param {HTMLElement} container
   */
  async function renderAgenda(container) {
    container.innerHTML = '';

    const header = document.createElement('h2');
    header.textContent = 'Agenda';
    header.className = 'section-title';
    container.appendChild(header);

    // Navigation mois précédent / suivant
    const nav = document.createElement('div');
    nav.className = 'calendar-nav';
    const prev = document.createElement('button');
    prev.textContent = '<';
    prev.onclick = () => {
      agendaDate.setMonth(agendaDate.getMonth() - 1);
      renderAgenda(container);
    };
    const next = document.createElement('button');
    next.textContent = '>';
    next.onclick = () => {
      agendaDate.setMonth(agendaDate.getMonth() + 1);
      renderAgenda(container);
    };
    const label = document.createElement('span');
    label.textContent = agendaDate.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    nav.appendChild(prev);
    nav.appendChild(label);
    nav.appendChild(next);
    container.appendChild(nav);

    // Actions pour créer répétition ou prestation
    const topActions = document.createElement('div');
    topActions.className = 'actions';
    const addRehearsalBtn = document.createElement('button');
    addRehearsalBtn.className = 'btn-secondary';
    addRehearsalBtn.textContent = 'Nouvelle répétition';
    addRehearsalBtn.onclick = () =>
      showAddRehearsalEventModal(container, () => renderAgenda(container));
    const addPerformanceBtn = document.createElement('button');
    addPerformanceBtn.className = 'btn-secondary';
    addPerformanceBtn.textContent = 'Nouvelle prestation';
    addPerformanceBtn.onclick = () =>
      showAddPerformanceModal(container, () => renderAgenda(container));
    topActions.appendChild(addRehearsalBtn);
    topActions.appendChild(addPerformanceBtn);
    container.appendChild(topActions);

    // Récupération des événements du mois courant
    let items = [];
    try {
      const year = agendaDate.getFullYear();
      const month = agendaDate.getMonth() + 1;
      const monthStr = String(month).padStart(2, '0');
      const start = `${year}-${monthStr}-01`;
      const end = `${year}-${monthStr}-31`;
      items = await api(`/agenda?start=${start}&end=${end}`);
    } catch (err) {
      const p = document.createElement('p');
      p.style.color = 'var(--danger-color)';
      p.textContent = "Impossible de récupérer l'agenda";
      container.appendChild(p);
      return;
    }

    items.sort((a, b) => a.date.localeCompare(b.date));

    // Construction de la grille du calendrier
    const grid = document.createElement('div');
    grid.className = 'calendar-grid';

    const dayNames = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    dayNames.forEach((d) => {
      const dn = document.createElement('div');
      dn.className = 'calendar-day-name';
      dn.textContent = d;
      grid.appendChild(dn);
    });

    const year = agendaDate.getFullYear();
    const month = agendaDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const firstWeekday = (firstDay.getDay() + 6) % 7; // Lundi=0
    for (let i = 0; i < firstWeekday; i++) {
      const empty = document.createElement('div');
      empty.className = 'calendar-cell empty';
      grid.appendChild(empty);
    }

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const cell = document.createElement('div');
      cell.className = 'calendar-cell';
      const dateLabel = document.createElement('div');
      dateLabel.className = 'calendar-date';
      dateLabel.textContent = day;
      cell.appendChild(dateLabel);

      const dayStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const eventsForDay = items.filter((ev) => ev.date?.startsWith(dayStr));
      eventsForDay.forEach((ev) => {
        const evDiv = document.createElement('div');
        evDiv.className = `calendar-event ${ev.type === 'performance' ? 'performance' : 'rehearsal'}`;
        const label = ev.title || ev.location || '';
        const typeLabel = ev.type === 'performance' ? 'Prestation' : 'Répétition';
        evDiv.textContent = label || typeLabel;
        evDiv.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (ev.type === 'performance') {
            try {
              if (rehearsalsCache.length === 0) {
                await syncRehearsalsCache();
              }
              const perfs = await api('/performances');
              const perf = perfs.find((p) => p.id === ev.id);
              if (perf) {
                showEditPerformanceModal(perf, container, () => renderAgenda(container));
              }
            } catch (err) {
              alert(err.message);
            }
          } else {
            showEditRehearsalEventModal(ev, container, () => renderAgenda(container));
          }
        };
        cell.appendChild(evDiv);
      });

      if (eventsForDay.length === 0) {
        cell.onclick = async () => {
          if (!hasModRights()) return;
          const isPerf = confirm('Ajouter une prestation ? (Annuler pour une répétition)');
          if (isPerf) {
            try {
              if (rehearsalsCache.length === 0) {
                await syncRehearsalsCache();
              }
            } catch (err) {
              // ignore cache errors
            }
            showAddPerformanceModal(container, () => renderAgenda(container), dayStr);
          } else {
            showAddRehearsalEventModal(
              container,
              () => renderAgenda(container),
              `${dayStr}T20:00`
            );
          }
        };
      }

      grid.appendChild(cell);
    }

    container.appendChild(grid);
  }

  /**
   * Fenêtre modale pour ajouter une répétition.
   */
  function showAddRehearsalEventModal(container, afterSave, initialDate) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = 'Ajouter une répétition';
    content.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => e.preventDefault();
    // Date
    const labelDate = document.createElement('label');
    labelDate.textContent = 'Date et heure';
    const inputDate = document.createElement('input');
    inputDate.type = 'datetime-local';
    inputDate.required = true;
    inputDate.style.width = '100%';
    if (initialDate) inputDate.value = initialDate;
    // Lieu
    const labelLoc = document.createElement('label');
    labelLoc.textContent = 'Lieu';
    const inputLoc = document.createElement('input');
    inputLoc.type = 'text';
    inputLoc.style.width = '100%';
    form.appendChild(labelDate);
    form.appendChild(inputDate);
    form.appendChild(labelLoc);
    form.appendChild(inputLoc);
    content.appendChild(form);
    // Actions
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal);
      }
    };
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Ajouter';
    okBtn.onclick = async (e) => {
      e.preventDefault();
      const date = inputDate.value;
      if (!date) return;
      const location = inputLoc.value.trim();
      try {
        await api('/agenda', 'POST', { type: 'rehearsal', date, location });
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal);
        }
        if (typeof afterSave === 'function') afterSave();
      } catch (err) {
        alert(err.message);
      }
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    content.appendChild(actions);
    modal.appendChild(content);
    document.body.appendChild(modal);
    setTimeout(() => inputDate.focus(), 50);
  }

  /**
   * Affiche une modale pour ajouter une prestation.
   */
  async function showAddPerformanceModal(container, afterSave, initialDate) {
    // Refresh song list to ensure up-to-date averages
    try {
      await syncRehearsalsCache();
    } catch (err) {
      alert(err.message);
      return;
    }
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
    if (initialDate) inputDate.value = initialDate;
    // Heure
    const labelTime = document.createElement('label');
    labelTime.textContent = 'Heure';
    const inputTime = document.createElement('input');
    inputTime.type = 'time';
    inputTime.required = true;
    inputTime.style.width = '100%';
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
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = song.id;
      const titleSpan = document.createElement('span');
      titleSpan.textContent = song.title;
      titleSpan.style.marginLeft = '4px';
      const leftWrap = document.createElement('span');
      leftWrap.appendChild(checkbox);
      leftWrap.appendChild(titleSpan);
      const levelSpan = document.createElement('span');
      levelSpan.className = 'level-badge';
      const levels = Object.values(song.levels || {}).map(Number);
      const avg =
        levels.length > 0
          ? levels.reduce((sum, val) => sum + val, 0) / levels.length
          : 0;
      levelSpan.textContent = avg.toFixed(1);
      row.appendChild(leftWrap);
      row.appendChild(levelSpan);
      listDiv.appendChild(row);
    });
    form.appendChild(labelName);
    form.appendChild(inputName);
    form.appendChild(labelDate);
    form.appendChild(inputDate);
    form.appendChild(labelTime);
    form.appendChild(inputTime);
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
      const timeVal = inputTime.value;
      const locVal = inputLoc.value.trim();
      if (!name || !dateVal || !timeVal) return;
      const dateTime = `${dateVal}T${timeVal}`;
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
        await api('/performances', 'POST', { name, date: dateTime, location: locVal, songs: selected });
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal); // or use modal.remove();
        }
        if (typeof afterSave === 'function') afterSave();
        else renderPerformances(container);
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
   * Fenêtre modale pour modifier une répétition.
   */
  function showEditRehearsalEventModal(event, container, afterSave) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    const h3 = document.createElement('h3');
    h3.textContent = 'Modifier la répétition';
    content.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => e.preventDefault();
    // Date
    const labelDate = document.createElement('label');
    labelDate.textContent = 'Date et heure';
    const inputDate = document.createElement('input');
    inputDate.type = 'datetime-local';
    inputDate.required = true;
    inputDate.style.width = '100%';
    inputDate.value = event.date || '';
    // Lieu
    const labelLoc = document.createElement('label');
    labelLoc.textContent = 'Lieu';
    const inputLoc = document.createElement('input');
    inputLoc.type = 'text';
    inputLoc.style.width = '100%';
    inputLoc.value = event.location || '';
    form.appendChild(labelDate);
    form.appendChild(inputDate);
    form.appendChild(labelLoc);
    form.appendChild(inputLoc);
    content.appendChild(form);
    // Actions
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Annuler';
    cancelBtn.onclick = () => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal);
      }
    };
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'Enregistrer';
    okBtn.onclick = async (e) => {
      e.preventDefault();
      const date = inputDate.value;
      if (!date) return;
      const location = inputLoc.value.trim();
      try {
        await api(`/agenda/${event.id}`, 'PUT', {
          type: 'rehearsal',
          date,
          location,
        });
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal);
        }
        if (typeof afterSave === 'function') afterSave();
      } catch (err) {
        alert(err.message);
      }
    };
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    content.appendChild(actions);
    modal.appendChild(content);
    document.body.appendChild(modal);
    setTimeout(() => inputDate.focus(), 50);
  }

  /**
   * Affiche une modale pour modifier une prestation existante.  Les champs
   * sont pré-remplis avec les valeurs actuelles.
   */
  async function showEditPerformanceModal(perf, container, afterSave) {
    // Refresh song list to ensure up-to-date averages
    try {
      await syncRehearsalsCache();
    } catch (err) {
      alert(err.message);
      return;
    }
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
    const [perfDate, perfTime] = (perf.date || '').split('T');
    inputDate.value = perfDate;
    // Heure
    const labelTime = document.createElement('label');
    labelTime.textContent = 'Heure';
    const inputTime = document.createElement('input');
    inputTime.type = 'time';
    inputTime.required = true;
    inputTime.style.width = '100%';
    inputTime.value = (perfTime || '').slice(0, 5);
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
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = song.id;
      if (perf.songs.includes(song.id)) checkbox.checked = true;
      const titleSpan = document.createElement('span');
      titleSpan.textContent = song.title;
      titleSpan.style.marginLeft = '4px';
      const leftWrap = document.createElement('span');
      leftWrap.appendChild(checkbox);
      leftWrap.appendChild(titleSpan);
      const levelSpan = document.createElement('span');
      levelSpan.className = 'level-badge';
      const levels = Object.values(song.levels || {}).map(Number);
      const avg =
        levels.length > 0
          ? levels.reduce((sum, val) => sum + val, 0) / levels.length
          : 0;
      levelSpan.textContent = avg.toFixed(1);
      row.appendChild(leftWrap);
      row.appendChild(levelSpan);
      listDiv.appendChild(row);
    });
    form.appendChild(labelName);
    form.appendChild(inputName);
    form.appendChild(labelDate);
    form.appendChild(inputDate);
    form.appendChild(labelTime);
    form.appendChild(inputTime);
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
      const timeVal = inputTime.value;
      const locVal = inputLoc.value.trim();
      if (!name || !dateVal || !timeVal) return;
      const dateTime = `${dateVal}T${timeVal}`;
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
        await api(`/performances/${perf.id}`, 'PUT', { name, date: dateTime, location: locVal, songs: selected });
        if (modal.parentNode) {
          modal.parentNode.removeChild(modal); // or use modal.remove();
        }
        if (typeof afterSave === 'function') afterSave();
        else renderPerformances(container);
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
    dateP.textContent = 'Date : ' + formatDateTime(perf.date);
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
    h3.style.fontWeight = 'normal';
    const titleStrong = document.createElement('strong');
    titleStrong.textContent = 'Titre :';
    h3.appendChild(titleStrong);
    h3.appendChild(document.createTextNode(' ' + song.title));
    content.appendChild(h3);
    // Afficher les métadonnées (auteur et liens)
    const metaDiv = document.createElement('div');
    if (song.author) {
      const pAuth = document.createElement('p');
      pAuth.style.fontStyle = 'italic';
      const authStrong = document.createElement('strong');
      authStrong.textContent = 'Auteur :';
      pAuth.appendChild(authStrong);
      pAuth.appendChild(document.createTextNode(' ' + song.author));
      metaDiv.appendChild(pAuth);
    }
    if (song.versionOf) {
      const pVer = document.createElement('p');
      pVer.style.fontStyle = 'italic';
      const verStrong = document.createElement('strong');
      verStrong.textContent = 'Version de :';
      pVer.appendChild(verStrong);
      pVer.appendChild(document.createTextNode(' ' + song.versionOf));
      metaDiv.appendChild(pVer);
    }
    if (song.youtube) {
      const ytP = document.createElement('p');
      const ytStrong = document.createElement('strong');
      ytStrong.textContent = 'Lien Youtube : ';
      ytP.appendChild(ytStrong);
      const ytA = document.createElement('a');
      ytA.href = song.youtube;
      ytA.target = '_blank';
      ytA.rel = 'noopener noreferrer';
      ytA.textContent = song.youtube;
      ytP.appendChild(ytA);
      metaDiv.appendChild(ytP);
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

    // Notes audio pour l'utilisateur courant
    const audioSection = document.createElement('div');
    audioSection.style.marginTop = '8px';
    const myAudios = (song.audioNotes && song.audioNotes[currentUser.username]) || [];
    myAudios.forEach((note, idx) => {
      const wrap = document.createElement('div');
      if (note.title) {
        const t = document.createElement('div');
        t.textContent = note.title;
        wrap.appendChild(t);
      }
      const audioPlayer2 = document.createElement('audio');
      audioPlayer2.controls = true;
      audioPlayer2.src = note.audio;
      wrap.appendChild(audioPlayer2);
      const delAudioBtn2 = document.createElement('button');
      delAudioBtn2.className = 'btn-danger';
      delAudioBtn2.textContent = 'Supprimer audio';
      delAudioBtn2.style.marginLeft = '8px';
      delAudioBtn2.onclick = async (e) => {
        e.preventDefault();
        if (!confirm('Supprimer la note audio ?')) return;
        try {
          await api(`/rehearsals/${song.id}`, 'PUT', { audioIndex: idx });
          song.audioNotes[currentUser.username].splice(idx, 1);
          modal.remove();
          showSongDetail(song);
        } catch (err) {
          alert(err.message);
        }
      };
      wrap.appendChild(delAudioBtn2);
      audioSection.appendChild(wrap);
    });
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = 'Titre de la note';
    titleInput.style.display = 'block';
    titleInput.style.marginTop = '8px';
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
        const dataUrl = (ev.target?.result || '').toString();
        try {
          await api(`/rehearsals/${song.id}`, 'PUT', { audio: dataUrl, audioTitle: titleInput.value });
          song.audioNotes = song.audioNotes || {};
          song.audioNotes[currentUser.username] = song.audioNotes[currentUser.username] || [];
          song.audioNotes[currentUser.username].push({ title: titleInput.value, audio: dataUrl });
          modal.remove();
          showSongDetail(song);
        } catch (err) {
          alert(err.message);
        }
      };
      reader2.readAsDataURL(f);
    };
    audioSection.appendChild(titleInput);
    audioSection.appendChild(addBtn);
    audioSection.appendChild(fileInp);
    content.appendChild(audioSection);
    if (currentUser) {
      // Partitions
      const partSection = document.createElement('div');
      partSection.style.marginTop = '8px';
      const partLabel = document.createElement('label');
      partLabel.textContent = 'Partition(s)';
      partSection.appendChild(partLabel);
      const partList = document.createElement('div');
      (song.partitions || []).forEach((p) => {
        const row = document.createElement('div');
        const info = document.createElement('span');
        info.textContent = `${p.displayName} – ${p.uploader} – ${formatDateTime(p.date)}`;
        row.appendChild(info);
        const dl = document.createElement('a');
        dl.href = p.downloadUrl;
        dl.textContent = 'Télécharger';
        dl.target = '_blank';
        dl.rel = 'noopener noreferrer';
        dl.className = 'btn-secondary';
        dl.style.marginLeft = '8px';
        row.appendChild(dl);
        if (p.uploader === currentUser.username || isAdmin()) {
          const delBtn = document.createElement('button');
          delBtn.className = 'btn-danger';
          delBtn.textContent = 'Supprimer';
          delBtn.style.marginLeft = '8px';
          delBtn.onclick = async (e) => {
            e.preventDefault();
            if (!confirm('Supprimer cette partition ?')) return;
            try {
              await deletePartition(song.id, p.id);
              await syncRehearsalsCache();
              renderRehearsals(document.getElementById('app'));
              const updated = state.rehearsalsCache.find((s) => s.id === song.id);
              modal.remove();
              showSongDetail(updated);
            } catch (err) {
              alert(err.message);
            }
          };
          row.appendChild(delBtn);
        }
        partList.appendChild(row);
      });
      partSection.appendChild(partList);
      const partInput = document.createElement('input');
      partInput.type = 'file';
      partInput.accept = 'application/pdf';
      partInput.style.display = 'none';
      const partBtn = document.createElement('button');
      partBtn.className = 'btn-secondary';
      partBtn.textContent = 'Déposer une partition';
      partBtn.onclick = (e) => {
        e.preventDefault();
        partInput.click();
      };
      partInput.onchange = async () => {
        const file = partInput.files[0];
        if (!file) return;
        try {
          await uploadPartition(song.id, file, file.name);
          await syncRehearsalsCache();
          renderRehearsals(document.getElementById('app'));
          const updated = state.rehearsalsCache.find((s) => s.id === song.id);
          modal.remove();
          showSongDetail(updated);
        } catch (err) {
          alert(err.message);
        }
      };
      partSection.appendChild(partBtn);
      partSection.appendChild(partInput);
      content.appendChild(partSection);
    }
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
        const uStrong = document.createElement('strong');
        uStrong.textContent = u;
        p.appendChild(uStrong);
        p.appendChild(document.createTextNode(` – Niveau ${lev}/10${note ? ' – ' + note : ''}`));
        wrapper.appendChild(p);
        // Afficher les notes audio pour cet utilisateur s'il en existe
        const audioList = (song.audioNotes && song.audioNotes[u]) || [];
        audioList.forEach((note) => {
          if (note.title) {
            const t = document.createElement('div');
            t.textContent = note.title;
            t.style.marginTop = '4px';
            wrapper.appendChild(t);
          }
          const audioEl = document.createElement('audio');
          audioEl.controls = true;
          audioEl.src = note.audio;
          audioEl.style.display = 'block';
          audioEl.style.marginTop = '4px';
          wrapper.appendChild(audioEl);
        });
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

  function renderGroupSection(currentSettings) {
    const section = document.createElement('div');
    section.className = 'settings-section bg-white rounded-lg shadow-md p-4 bg-purple-50';
    const h3 = document.createElement('h3');
    h3.textContent = 'Groupes';
    section.appendChild(h3);
    const groupSelect = document.createElement('select');
    groupSelect.id = 'group-select';
    section.appendChild(groupSelect);
    const groupBtnRow = document.createElement('div');
    groupBtnRow.style.marginTop = '10px';
    const createBtn = document.createElement('button');
    createBtn.id = 'create-group-btn';
    createBtn.className = 'btn-secondary';
    createBtn.textContent = 'Créer';
    groupBtnRow.appendChild(createBtn);
    const joinBtn = document.createElement('button');
    joinBtn.id = 'join-group-btn';
    joinBtn.className = 'btn-secondary';
    joinBtn.textContent = 'Rejoindre';
    joinBtn.style.marginLeft = '8px';
    groupBtnRow.appendChild(joinBtn);
    const renameBtn = document.createElement('button');
    renameBtn.id = 'rename-group-btn';
    renameBtn.className = 'btn-secondary';
    renameBtn.textContent = 'Renommer';
    renameBtn.style.marginLeft = '8px';
    renameBtn.onclick = async () => {
      const newName = prompt('Nouveau nom du groupe', currentSettings.groupName);
      if (!newName || newName.trim() === '' || newName === currentSettings.groupName) return;
      const trimmed = newName.trim();
      const gid = currentSettings.id || currentUser.groupId;
      try {
        await api(`/groups/${gid}`, 'PUT', { name: trimmed });
        currentSettings.groupName = trimmed;
        document.title = `${currentSettings.groupName} – BandTrack`;
        const groupNameEl = document.getElementById('group-name');
        if (groupNameEl) groupNameEl.textContent = currentSettings.groupName;
        await refreshGroups(gid);
        await renderSettings(document.getElementById('app'));
      } catch (err) {
        alert(err.message);
      }
    };
    groupBtnRow.appendChild(renameBtn);
    section.appendChild(groupBtnRow);
    if (isAdmin()) {
      const inviteDiv = document.createElement('div');
      inviteDiv.style.marginTop = '8px';
      let invitationCode = currentSettings.invitationCode;
      const codeSpan = document.createElement('span');
      codeSpan.textContent = `Code d'invitation : ${invitationCode}`;
      inviteDiv.appendChild(codeSpan);
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copier';
      copyBtn.style.marginLeft = '8px';
      copyBtn.onclick = () => navigator.clipboard.writeText(invitationCode);
      inviteDiv.appendChild(copyBtn);
      const renewBtn = document.createElement('button');
      renewBtn.textContent = 'Renouveler';
      renewBtn.style.marginLeft = '8px';
      renewBtn.onclick = async () => {
        try {
          const data = await api('/groups/renew-code', 'POST');
          invitationCode = data.invitationCode;
          codeSpan.textContent = `Code d'invitation : ${invitationCode}`;
        } catch (err) {
          alert(err.message);
        }
      };
      inviteDiv.appendChild(renewBtn);
      section.appendChild(inviteDiv);
    }
    return section;
  }

  function renderPasswordSection() {
    const section = document.createElement('div');
    section.className = 'settings-section bg-white rounded-lg shadow-md p-4 bg-purple-50';
    const h3 = document.createElement('h3');
    h3.textContent = 'Mot de passe';
    section.appendChild(h3);
    const form = document.createElement('form');
    form.onsubmit = (e) => e.preventDefault();
    const labelOld = document.createElement('label');
    labelOld.textContent = 'Mot de passe actuel';
    const inputOld = document.createElement('input');
    inputOld.type = 'password';
    inputOld.required = true;
    inputOld.style.width = '100%';
    const labelNew = document.createElement('label');
    labelNew.textContent = 'Nouveau mot de passe';
    const inputNew = document.createElement('input');
    inputNew.type = 'password';
    inputNew.required = true;
    inputNew.style.width = '100%';
    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn-primary';
    submitBtn.type = 'submit';
    submitBtn.textContent = 'Modifier';
    submitBtn.style.marginTop = '8px';
    const msg = document.createElement('p');
    msg.style.marginTop = '8px';
    form.appendChild(labelOld);
    form.appendChild(inputOld);
    form.appendChild(labelNew);
    form.appendChild(inputNew);
    form.appendChild(submitBtn);
    form.appendChild(msg);
    form.onsubmit = async (e) => {
      e.preventDefault();
      msg.textContent = '';
      try {
        await api('/password', 'PUT', {
          oldPassword: inputOld.value,
          newPassword: inputNew.value,
        });
        msg.style.color = 'green';
        msg.textContent = 'Mot de passe mis à jour';
        inputOld.value = '';
        inputNew.value = '';
      } catch (err) {
        msg.style.color = 'var(--danger-color)';
        msg.textContent = err.message;
      }
    };
    section.appendChild(form);
    return section;
  }

  function renderThemeSection(currentSettings) {
    const section = document.createElement('div');
    section.className = 'settings-section bg-white rounded-lg shadow-md p-4 bg-purple-50';
    const h3 = document.createElement('h3');
    h3.textContent = 'Thème';
    section.appendChild(h3);
    const modeDiv = document.createElement('div');
    const modeLabel = document.createElement('label');
    modeLabel.textContent = 'Mode sombre';
    modeLabel.style.marginRight = '8px';
    const modeCheckbox = document.createElement('input');
    modeCheckbox.type = 'checkbox';
    modeCheckbox.checked = currentSettings.darkMode;
    modeCheckbox.onchange = async () => {
      currentSettings.darkMode = modeCheckbox.checked;
      try {
        await api('/settings', 'PUT', currentSettings);
        applyTheme(modeCheckbox.checked);
      } catch (err) {
        alert(err.message);
      }
    };
    modeDiv.appendChild(modeLabel);
    modeDiv.appendChild(modeCheckbox);
    section.appendChild(modeDiv);
    const templateDiv = document.createElement('div');
    templateDiv.style.marginTop = '20px';
    const templateLabel = document.createElement('label');
    templateLabel.textContent = 'Template (design)';
    templateLabel.style.marginRight = '8px';
    const templateSelect = document.createElement('select');
    const templateOptions = [
      { value: 'classic', label: 'Classique' },
      { value: 'groove', label: 'Groove' },
      { value: 'violet', label: 'Violet' },
      { value: 'imgbg', label: 'Image' },
    ];
    templateOptions.forEach((opt) => {
      const optEl = document.createElement('option');
      optEl.value = opt.value;
      optEl.textContent = opt.label;
      templateSelect.appendChild(optEl);
    });
    templateSelect.value = currentSettings.template || 'classic';
    templateSelect.onchange = async () => {
      const val = templateSelect.value;
      currentSettings.template = val;
      try {
        await api('/settings', 'PUT', currentSettings);
        applyTemplate(val);
      } catch (err) {
        alert(err.message);
      }
    };
    templateDiv.appendChild(templateLabel);
    templateDiv.appendChild(templateSelect);
    section.appendChild(templateDiv);
    return section;
  }

  async function renderMembersSection() {
    const section = document.createElement('div');
    section.className = 'settings-section bg-white rounded-lg shadow-md p-4 bg-purple-50';
    const h3 = document.createElement('h3');
    h3.textContent = 'Membres';
    section.appendChild(h3);
    if (activeGroupId == null || currentUser?.needsGroup) {
      const p = document.createElement('p');
      p.textContent = 'Aucun groupe actif';
      section.appendChild(p);
      return section;
    }
    try {
      const members = await api(`/groups/${activeGroupId}/members`);
      const table = document.createElement('table');
      table.className = 'user-table';
      const thead = document.createElement('thead');
      thead.innerHTML = '<tr><th>Membre</th><th>Rôle</th></tr>';
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      members.forEach((m) => {
        const tr = document.createElement('tr');
        const nameTd = document.createElement('td');
        nameTd.textContent = m.username;
        const roleTd = document.createElement('td');
        roleTd.textContent = m.role;
        tr.appendChild(nameTd);
        tr.appendChild(roleTd);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      section.appendChild(table);
    } catch (err) {
      const p = document.createElement('p');
      p.style.color = 'var(--danger-color)';
      p.textContent = 'Impossible de récupérer les membres du groupe';
      section.appendChild(p);
    }
    return section;
  }

  async function renderAdminSection(container) {
    const section = document.createElement('div');
    section.className = 'settings-section bg-white rounded-lg shadow-md p-4 bg-purple-50';
    const h3 = document.createElement('h3');
    h3.textContent = 'Administration';
    section.appendChild(h3);
    if (activeGroupId == null || currentUser?.needsGroup) {
      const p = document.createElement('p');
      p.textContent = 'Aucun groupe actif';
      section.appendChild(p);
      return section;
    }
    try {
      const group = await api('/context');
      if (!group) {
        const p = document.createElement('p');
        p.textContent = 'Aucun groupe actif';
        section.appendChild(p);
        return section;
      }
      const [members, users] = await Promise.all([
        api(`/groups/${activeGroupId}/members`),
        api('/users'),
      ]);
      const groupHeader = document.createElement('h4');
      groupHeader.textContent = 'Tableau de bord du groupe';
      groupHeader.style.marginTop = '10px';
      section.appendChild(groupHeader);
      const inviteDiv = document.createElement('div');
      let invitationCode = group.invitation_code;
      const codeSpan = document.createElement('span');
      codeSpan.textContent = `Code d'invitation : ${invitationCode}`;
      inviteDiv.appendChild(codeSpan);
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copier';
      copyBtn.style.marginLeft = '8px';
      copyBtn.onclick = () => navigator.clipboard.writeText(invitationCode);
      inviteDiv.appendChild(copyBtn);
      const renewBtn = document.createElement('button');
      renewBtn.textContent = 'Renouveler';
      renewBtn.style.marginLeft = '8px';
      renewBtn.onclick = async () => {
        try {
          const data = await api('/groups/renew-code', 'POST');
          invitationCode = data.invitationCode;
          codeSpan.textContent = `Code d'invitation : ${invitationCode}`;
        } catch (err) {
          alert(err.message);
        }
      };
      inviteDiv.appendChild(renewBtn);
      section.appendChild(inviteDiv);
      const memberTable = document.createElement('table');
      memberTable.className = 'user-table';
      const mthead = document.createElement('thead');
      mthead.innerHTML = '<tr><th>Membre</th><th>Rôle</th><th>Actions</th></tr>';
      memberTable.appendChild(mthead);
      const mtbody = document.createElement('tbody');
      members.forEach((m) => {
        const tr = document.createElement('tr');
        const nameTd = document.createElement('td');
        nameTd.textContent = m.username;
        const roleTd = document.createElement('td');
        const sel = document.createElement('select');
        ['user', 'moderator', 'admin'].forEach((r) => {
          const opt = document.createElement('option');
          opt.value = r;
          opt.textContent = r;
          if (m.role === r) opt.selected = true;
          sel.appendChild(opt);
        });
        if (m.userId === currentUser.id) sel.disabled = true;
        sel.onchange = async () => {
          try {
            await api(`/groups/${activeGroupId}/members`, 'PUT', { id: m.id, role: sel.value });
          } catch (err) {
            alert(err.message);
          }
        };
        roleTd.appendChild(sel);
        const actionsTd = document.createElement('td');
        const removeBtn = document.createElement('button');
        removeBtn.textContent = m.userId === currentUser.id ? 'Quitter' : 'Retirer';
        removeBtn.onclick = async () => {
          const confirmMsg = m.userId === currentUser.id ? 'Quitter le groupe ?' : 'Supprimer ce membre ?';
          if (!confirm(confirmMsg)) return;
          try {
            await api(`/groups/${activeGroupId}/members`, 'DELETE', { userId: m.userId });
            if (m.userId === currentUser.id) {
              alert('Quitter le groupe');
              currentUser.needsGroup = true;
              renderApp();
            } else {
              tr.remove();
              alert('Membre supprimé');
            }
          } catch (err) {
            alert(err.message);
          }
        };
        actionsTd.appendChild(removeBtn);
        tr.appendChild(nameTd);
        tr.appendChild(roleTd);
        tr.appendChild(actionsTd);
        mtbody.appendChild(tr);
      });
      memberTable.appendChild(mtbody);
      section.appendChild(memberTable);
      const memberIds = new Set(members.map((m) => m.userId));
      const nonMembers = users.filter((u) => !memberIds.has(u.id));
      if (nonMembers.length > 0) {
        const addDiv = document.createElement('div');
        const sel = document.createElement('select');
        nonMembers.forEach((u) => {
          const opt = document.createElement('option');
          opt.value = u.id;
          opt.textContent = u.username;
          sel.appendChild(opt);
        });
        addDiv.appendChild(sel);
        const addBtn = document.createElement('button');
        addBtn.textContent = 'Ajouter';
        addBtn.style.marginLeft = '8px';
        addBtn.onclick = async () => {
          try {
            const uid = Number(sel.value);
            await api(`/groups/${activeGroupId}/members`, 'POST', { userId: uid, role: 'user' });
            renderSettings(container);
          } catch (err) {
            alert(err.message);
          }
        };
        addDiv.appendChild(addBtn);
        section.appendChild(addDiv);
      }
      const inviteEmailDiv = document.createElement('div');
      const emailInput = document.createElement('input');
      emailInput.type = 'email';
      emailInput.placeholder = 'adresse e-mail';
      inviteEmailDiv.appendChild(emailInput);
      const inviteBtn = document.createElement('button');
      inviteBtn.textContent = 'Inviter';
      inviteBtn.style.marginLeft = '8px';
      inviteBtn.onclick = async () => {
        const email = emailInput.value.trim();
        if (!email) return;
        try {
          const res = await api(`/groups/${activeGroupId}/invite`, 'POST', { email });
          if (res.temporaryPassword) {
            alert(`Mot de passe temporaire : ${res.temporaryPassword}`);
          }
          renderSettings(container);
        } catch (err) {
          alert(err.message);
        }
      };
      inviteEmailDiv.appendChild(inviteBtn);
      section.appendChild(inviteEmailDiv);
      const adminHeader = document.createElement('h4');
      adminHeader.textContent = 'Gestion des utilisateurs';
      adminHeader.style.marginTop = '30px';
      section.appendChild(adminHeader);
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
      section.appendChild(table);
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn-primary';
      saveBtn.style.marginTop = '10px';
      saveBtn.textContent = 'Enregistrer les rôles';
      saveBtn.onclick = async () => {
        try {
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
      section.appendChild(saveBtn);
    } catch (err) {
      const p = document.createElement('p');
      p.style.color = 'var(--danger-color)';
      p.textContent = 'Impossible de récupérer les membres';
      section.appendChild(p);
    }
    return section;
  }

  /**
   * Rendu de la page paramètres.  Assemble les différentes sections de paramètres.
   * @param {HTMLElement} container
   */
  async function renderSettings(container) {
    container.innerHTML = '';
    const header = document.createElement('h2');
    header.className = 'section-title';
    header.textContent = 'Paramètres';
    container.appendChild(header);
    if (currentUser) {
      const info = document.createElement('p');
      info.className = 'user-info';
      info.textContent = `Utilisateur connecté: ${currentUser.username}`;
      container.appendChild(info);
    }
    const logoutSection = document.createElement('div');
    logoutSection.className = 'settings-section bg-white rounded-lg shadow-md p-4 bg-purple-50';
    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'logout-btn';
    logoutBtn.textContent = 'Se déconnecter';
    logoutBtn.onclick = handleLogout;
    logoutSection.appendChild(logoutBtn);
    const deleteBtn = document.createElement('button');
    deleteBtn.id = 'delete-account-btn';
    deleteBtn.className = 'delete-account-btn';
    deleteBtn.textContent = 'Supprimer mon compte';
    deleteBtn.onclick = handleDeleteAccount;
    logoutSection.appendChild(deleteBtn);
    let settings;
    try {
      settings = await api('/settings');
    } catch (err) {
      const p = document.createElement('p');
      p.style.color = 'var(--danger-color)';
      p.textContent = 'Impossible de récupérer les paramètres';
      container.appendChild(p);
      container.appendChild(logoutSection);
      return;
    }
    const currentSettings = { ...settings };
    const groupSection = renderGroupSection(currentSettings);
    container.appendChild(groupSection);
    try {
      await refreshGroups();
      const membersSection = await renderMembersSection();
      container.appendChild(membersSection);
    } catch (err) {
      console.error('Failed to load groups or members', err);
    }
    const themeSection = renderThemeSection(currentSettings);
    container.appendChild(themeSection);
    const passwordSection = renderPasswordSection();
    container.appendChild(passwordSection);
    container.appendChild(logoutSection);
    if (isAdmin()) {
      const adminSection = await renderAdminSection(container);
      container.appendChild(adminSection);
    }
  }

  // Lancement de l’application lorsque le DOM est prêt
  window.addEventListener('DOMContentLoaded', initApp);

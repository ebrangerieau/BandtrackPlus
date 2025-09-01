export const state = {
  currentUser: null,
  currentPage: 'home',
  rehearsalsCache: [],
  groupsCache: [],
  activeGroupId: null,
  agendaDate: new Date(),
  suggestionsCache: [],
};

export function resetCaches() {
  state.rehearsalsCache = [];
  state.suggestionsCache = [];
}

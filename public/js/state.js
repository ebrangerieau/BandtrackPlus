export const state = {
  currentUser: null,
  currentPage: 'home',
  rehearsalsCache: [],
  groupsCache: [],
  activeGroupId: null,
  agendaDate: new Date(),
};

export function resetCaches() {
  state.rehearsalsCache = [];
}

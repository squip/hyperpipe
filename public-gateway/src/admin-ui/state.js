export const appState = {
  token: null,
  busy: false,
  route: 'dashboard',
  userAuthorizationTab: 'allow-list',
  auth: {
    derivedPubkey: null
  },
  data: {
    overview: null,
    policy: null,
    allowList: [],
    banList: [],
    invites: [],
    activity: [],
    profilesByPubkey: {}
  }
};

export function resetAppData() {
  appState.data = {
    overview: null,
    policy: null,
    allowList: [],
    banList: [],
    invites: [],
    activity: [],
    profilesByPubkey: {}
  };
}

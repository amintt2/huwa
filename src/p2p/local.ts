// Minimal stub so the `bare` branch compiles on its own.
// The full AsyncStorage implementation lives on the UI branch and replaces this file at merge.
import type { P2P, P2PStatus } from './contract';

const notAvailable = () => Promise.reject(new Error('P2P local indisponible (stub)'));

export function createLocalP2P(): P2P {
  const status: P2PStatus = { state: 'offline', peers: 0 };
  return {
    status: () => status,
    onStatus: () => () => {},
    me: () => undefined,
    createIdentity: notAvailable,
    restoreIdentity: notAvailable,
    updateProfile: notAvailable,
    getProfile: async () => undefined,
    backupState: async () => ({ cloud: false, phraseVerified: false, devices: 0 }),
    markPhraseVerified: notAvailable,
    devices: async () => [],
    pairingInvite: notAvailable,
    acceptPairing: notAvailable,
    revokeDevice: notAvailable,
    watchComments: (_id, cb) => {
      cb([]);
      return () => {};
    },
    postComment: notAvailable,
    toggleLike: notAvailable,
    follow: notAvailable,
    unfollow: notAvailable,
    block: notAvailable,
    unblock: notAvailable,
    report: notAvailable,
    watchLabels: (cb) => {
      cb([]);
      return () => {};
    },
    subscribeLabeler: notAvailable,
    watchConversations: (cb) => {
      cb([]);
      return () => {};
    },
    watchMessages: (_peer, cb) => {
      cb([]);
      return () => {};
    },
    sendMessage: notAvailable,
    markRead: notAvailable,
    appendJournal: notAvailable,
    journal: async () => [],
  };
}

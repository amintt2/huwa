// Entry point of the P2P layer for the UI: `getP2P()` returns the `bare` implementation when the
// worklet starts, and falls back to the `local` one otherwise (web, Expo Go, worklet failure).
import * as Device from 'expo-device';
import { Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { HuwaKeychain } from '../../modules/huwa-keychain';

import type { BareP2P } from './bare';
import type { P2P, P2PStatus, Unsubscribe } from './contract';
import { isDemo } from '@/demo/flags';

import { createLocalP2P } from './local';

export type * from './contract';

export type P2PBackend = 'bare' | 'local';

/** Comma separated `host:port` list, e.g. a self-hosted `hyperdht --bootstrap` node. */
const BOOTSTRAP = String(process.env.EXPO_PUBLIC_HUWA_BOOTSTRAP ?? '')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);

let instance: SwitchingP2P | null = null;

export function getP2P(): P2P {
  if (!instance) instance = new SwitchingP2P();
  return instance;
}

/** Which implementation is currently serving `getP2P()`. */
export function p2pBackend(): P2PBackend {
  return instance?.backend ?? 'local';
}

/** Spike/diagnostic helpers, only available on the bare backend. */
export function bareDiagnostics(): BareP2P | null {
  return instance?.bare ?? null;
}

/**
 * The worklet keeps this device's identity secrets (device key, proof, DM box seed) in its store
 * under Documents: keep it out of iCloud / Finder backups, otherwise a backup restored on another
 * iPhone would carry them (and clone this device's writer keys).
 */
function excludeP2PStoreFromBackup() {
  const keychain = HuwaKeychain;
  if (!keychain?.excludeFromBackup) return;
  // The stats store is created on first use: excluded from the next launch on.
  for (const dir of ['huwa-p2p', 'huwa-p2p-stats']) {
    keychain.excludeFromBackup(`${documentsDir()}/${dir}`).catch((e: unknown) => console.warn('[huwa] exclusion de la sauvegarde', dir, e));
  }
}

function documentsDir() {
  const uri = Paths.document.uri;
  return decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/$/, '');
}

type WatchKey = 'watchComments' | 'watchLabels' | 'watchConversations' | 'watchMessages' | 'watchMapping';
type Watch = { method: WatchKey; args: unknown[]; unsub: Unsubscribe };

/**
 * Delegates to `bare` while it boots; if the worklet does not answer its handshake, swaps to
 * `local` and moves the status listeners and live subscriptions over.
 */
class SwitchingP2P implements P2P {
  backend: P2PBackend = 'local';
  bare: BareP2P | null = null;
  private impl: P2P;
  private statusCbs = new Set<(s: P2PStatus) => void>();
  private statusUnsub: Unsubscribe = () => {};
  private watches = new Set<Watch>();

  constructor() {
    this.impl = this.pick();
    this.bindStatus();
  }

  private pick(): P2P {
    // Demo mode (store screenshots): seeded single-device backend, no network.
    if (Platform.OS === 'web' || isDemo) return createLocalP2P();
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createBareP2P } = require('./bare') as typeof import('./bare');
      const bare = createBareP2P({
        storage: documentsDir(),
        bootstrap: BOOTSTRAP,
        deviceName: Device.deviceName ?? Device.modelName ?? 'appareil',
        onBoot: (ok, info) => console.log('[huwa] worklet', ok ? `prêt en ${info.readyMs} ms` : `échec: ${info.error}`),
      });
      bare.ready.then(() => excludeP2PStoreFromBackup(), () => this.fallback());
      this.bare = bare;
      this.backend = 'bare';
      return bare;
    } catch (err) {
      console.warn('[huwa] worklet indisponible, P2P local', err);
      return createLocalP2P();
    }
  }

  private fallback() {
    if (this.backend === 'local') return;
    this.backend = 'local';
    this.bare = null;
    this.impl = createLocalP2P();
    this.bindStatus();
    for (const w of this.watches) {
      w.unsub();
      w.unsub = this.subscribe(w.method, w.args);
    }
    const s = this.impl.status();
    for (const cb of this.statusCbs) cb(s);
  }

  private bindStatus() {
    this.statusUnsub();
    this.statusUnsub = this.impl.onStatus((s) => {
      for (const cb of this.statusCbs) cb(s);
    });
  }

  private subscribe(method: WatchKey, args: unknown[]): Unsubscribe {
    const fn = this.impl[method] as (...a: unknown[]) => Unsubscribe;
    return fn.apply(this.impl, args);
  }

  private track(method: WatchKey, args: unknown[]): Unsubscribe {
    const w: Watch = { method, args, unsub: this.subscribe(method, args) };
    this.watches.add(w);
    return () => {
      this.watches.delete(w);
      w.unsub();
    };
  }

  status() {
    return this.impl.status();
  }
  onStatus(cb: (s: P2PStatus) => void): Unsubscribe {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  me: P2P['me'] = () => this.impl.me();
  createIdentity: P2P['createIdentity'] = (...a) => this.impl.createIdentity(...a);
  restoreIdentity: P2P['restoreIdentity'] = (...a) => this.impl.restoreIdentity(...a);
  updateProfile: P2P['updateProfile'] = (...a) => this.impl.updateProfile(...a);
  getProfile: P2P['getProfile'] = (...a) => this.impl.getProfile(...a);
  backupState: P2P['backupState'] = () => this.impl.backupState();
  markPhraseVerified: P2P['markPhraseVerified'] = () => this.impl.markPhraseVerified();
  devices: P2P['devices'] = () => this.impl.devices();
  pairingInvite: P2P['pairingInvite'] = () => this.impl.pairingInvite();
  acceptPairing: P2P['acceptPairing'] = (...a) => this.impl.acceptPairing(...a);
  revokeDevice: P2P['revokeDevice'] = (...a) => this.impl.revokeDevice(...a);

  watchComments: P2P['watchComments'] = (...a) => this.track('watchComments', a);
  postComment: P2P['postComment'] = (...a) => this.impl.postComment(...a);
  toggleLike: P2P['toggleLike'] = (...a) => this.impl.toggleLike(...a);
  editComment: P2P['editComment'] = (...a) => this.impl.editComment(...a);
  deleteComment: P2P['deleteComment'] = (...a) => this.impl.deleteComment(...a);

  follow: P2P['follow'] = (...a) => this.impl.follow(...a);
  unfollow: P2P['unfollow'] = (...a) => this.impl.unfollow(...a);
  block: P2P['block'] = (...a) => this.impl.block(...a);
  unblock: P2P['unblock'] = (...a) => this.impl.unblock(...a);
  report: P2P['report'] = (...a) => this.impl.report(...a);
  watchLabels: P2P['watchLabels'] = (...a) => this.track('watchLabels', a);
  subscribeLabeler: P2P['subscribeLabeler'] = (...a) => this.impl.subscribeLabeler(...a);

  watchConversations: P2P['watchConversations'] = (...a) => this.track('watchConversations', a);
  watchMessages: P2P['watchMessages'] = (...a) => this.track('watchMessages', a);
  sendMessage: P2P['sendMessage'] = (...a) => this.impl.sendMessage(...a);
  markRead: P2P['markRead'] = (...a) => this.impl.markRead(...a);

  appendJournal: P2P['appendJournal'] = (...a) => this.impl.appendJournal(...a);
  journal: P2P['journal'] = (...a) => this.impl.journal(...a);

  watchMapping: P2P['watchMapping'] = (...a) => this.track('watchMapping', a);
  proposeMapping: P2P['proposeMapping'] = (...a) => this.impl.proposeMapping(...a);

  contributeStats: P2P['contributeStats'] = (...a) => this.impl.contributeStats(...a);
  communityStats: P2P['communityStats'] = () => this.impl.communityStats();
}

// Login flows of Huwa Web (D7), for the screens in src/components/web-login/. Every flow ends with
// the browser node holding the account; secrets never leave the browser and the recovery phrase
// is never written anywhere (src/p2p/phrase.web.ts keeps it in this tab's memory only).
import { useSyncExternalStore } from 'react';

import type { Profile, RestoreOptions } from '../contract';
import { social } from '../hooks';
import { webSession } from '../index';
import { buildLinkUrl, newLinkKeys, newTopic, waitLinkFrame, webCryptoAead } from '../link-web';

import type { WebP2P, WebSessionInfo } from './client';
import { defaultGateway } from './client';
import { browserLabel } from './device-name';

export type { WebSessionInfo } from './client';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function web(): WebP2P {
  const w = webSession();
  if (!w) throw new Error('Connexion indisponible : ce navigateur ne peut pas faire tourner Huwa.');
  return w;
}

const IDLE: WebSessionInfo = { state: 'idle', mode: null, hasAccount: false, me: null, gateway: '', deviceName: '', passkey: null, online: false, error: null, storageError: null };

/** The browser's account session (idle / locked / ready), or IDLE outside the web backend. */
export function useWebSession(): WebSessionInfo {
  return useSyncExternalStore(
    (l) => webSession()?.onSession(l) ?? (() => {}),
    () => webSession()?.session() ?? IDLE,
    () => IDLE,
  );
}

/** Gateway base URL for the QR code (https://host/p2p), from the WebSocket URL of the node. */
export function gatewayHttpUrl(ws = defaultGateway()): string {
  return ws.replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
}

export type LinkProgress = 'waiting' | 'pairing';

/**
 * "Lier avec mon téléphone". Calls `onUrl` with the QR code content (draw it), waits for the
 * phone's sealed invite on the gateway's rendezvous box, then pairs. Abort with `signal`.
 */
export async function linkWithPhone(opts: { mode: 'device' | 'memory'; onUrl: (url: string) => void; onProgress?: (p: LinkProgress) => void; signal?: AbortSignal; ms?: number }): Promise<Profile> {
  const keys = newLinkKeys(random);
  const topic = newTopic(random);
  const relay = gatewayHttpUrl();
  const w = web();
  // The QR code is drawn at once; the node starts meanwhile (it is connected to the gateway when
  // the invite arrives). A node that cannot start ends the wait with its error.
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  opts.signal?.addEventListener('abort', onAbort);
  w.setLoginMode(opts.mode);
  const starting = w.begin({ mode: opts.mode });
  let startError: unknown = null;
  starting.catch((e) => {
    startError = e;
    abort.abort();
  });
  try {
    opts.onUrl(buildLinkUrl({ key: keys.publicKey, relay, topic, name: browserLabel() }));
    opts.onProgress?.('waiting');
    let payload;
    try {
      payload = await waitLinkFrame({ relay, topic }, keys, { aead: webCryptoAead, signal: abort.signal, ms: opts.ms });
    } catch (e) {
      throw startError ?? e;
    }
    await starting;
    opts.onProgress?.('pairing');
    const profile = await social.acceptPairing(payload.invite);
    fetch(`${relay}/rendezvous/${topic}`, { method: 'DELETE' }).catch(() => {});
    return profile;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    keys.secretKey.fill(0);
  }
}

/** Recovery phrase: same restore path as the app (RESTORE_NOT_FOUND included). */
export async function restoreWithPhrase(words: string[], opts: { mode: 'device' | 'memory'; restore?: RestoreOptions }): Promise<Profile> {
  const w = web();
  w.setLoginMode(opts.mode);
  return social.restoreIdentity(words, opts.restore);
}

/** "Créer un compte dans ce navigateur": returns the phrase to show once for backup. */
export async function createAccount(name: string, opts: { mode: 'device' | 'memory' }) {
  const w = web();
  w.setLoginMode(opts.mode);
  return social.createIdentity(name);
}

/** Leaves a login flow that did not finish (wipes what the node stored). */
export const cancelLogin = () => webSession()?.cancel().catch(() => undefined);

/** Logout: signed remove-device of this browser, then everything is wiped. */
export async function logout() {
  const r = await web().logout();
  // The app's own caches (library, settings) belong to the account: reload to a clean state.
  return r;
}

export const lockSession = () => web().lock();
export const unlockSession = (kek: CryptoKey) => web().unlock(kek);

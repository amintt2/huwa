// PWA glue on the app side (docs/WEB_DOCKER_PLAN.md D19, §6). The service worker itself and its
// registration are written into dist/ by scripts/web-postexport.mjs; the registration script in
// index.html publishes what it finds on `window.__huwaSW` and fires `huwa:sw` events:
//   { state: 'ready' }                       first install, the shell now works offline
//   { state: 'update', registration }        a new version is installed and waiting
// This module turns that into a hook for the "Nouvelle version disponible" prompt.
import { useSyncExternalStore } from 'react';

type SWInfo = { state: 'none' | 'ready' | 'update'; registration?: ServiceWorkerRegistration };

declare global {
  interface Window {
    __huwaSW?: SWInfo;
    /** Read by the registration script: reload once the new worker has taken over. */
    __huwaSWReload?: boolean;
  }
}

const listeners = new Set<() => void>();
let snapshot: SWInfo = (typeof window !== 'undefined' && window.__huwaSW) || { state: 'none' };
let dismissed = false;

if (typeof window !== 'undefined') {
  window.addEventListener('huwa:sw', () => {
    snapshot = window.__huwaSW ?? { state: 'none' };
    if (snapshot.state === 'update') dismissed = false;
    listeners.forEach((l) => l());
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const updateSnapshot = () => snapshot.state === 'update' && !dismissed;

/** True while a new version waits and the user has not said "Plus tard". */
export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(subscribe, updateSnapshot, updateSnapshot);
}

/** Activates the waiting worker; the registration script reloads on `controllerchange`. */
export function applyUpdate() {
  const waiting = snapshot.registration?.waiting;
  if (!waiting) return window.location.reload();
  window.__huwaSWReload = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

export function dismissUpdate() {
  dismissed = true;
  listeners.forEach((l) => l());
}

/** Installed to the home screen / as an app window. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

let persistAsked = false;

/**
 * Asks the browser not to evict this origin's storage (account keys, library, progress live in
 * IndexedDB). Chrome decides silently from engagement; Firefox shows a prompt, so this is called
 * only once there is something worth keeping (signed in, or installed).
 */
export async function requestPersistence(): Promise<boolean> {
  if (persistAsked || typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  persistAsked = true;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ---------- install ----------

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let installEvent: InstallEvent | null = null;
const installListeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Kept for Réglages → Installer l'app instead of the browser's own mini-infobar.
    e.preventDefault();
    installEvent = e as InstallEvent;
    installListeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    installListeners.forEach((l) => l());
    void requestPersistence();
  });
}

const subscribeInstall = (l: () => void) => {
  installListeners.add(l);
  return () => {
    installListeners.delete(l);
  };
};
const canInstallSnapshot = () => installEvent !== null;

/** Chrome / Edge / Android offered to install the app (never on iOS: Partager → Sur l'écran d'accueil). */
export function useCanInstall(): boolean {
  return useSyncExternalStore(subscribeInstall, canInstallSnapshot, canInstallSnapshot);
}

export async function promptInstall(): Promise<boolean> {
  const e = installEvent;
  if (!e) return false;
  installEvent = null;
  installListeners.forEach((l) => l());
  await e.prompt();
  return (await e.userChoice).outcome === 'accepted';
}

/** iPhone / iPad Safari, where installing goes through the Share menu. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// "Rejoins la communauté Huwa sur Discord": a one-time invitation right after onboarding (account
// created, restored or linked), and a permanent row in Réglages. Native app and web.
//
// The invite link is configuration, never hard-coded:
//   · native: app.json `expo.extra.discordInvite` (https://discord.gg/JSwf34Kw3E; or
//     HUWA_DISCORD_INVITE at build time, see app.config.js), read by ./invite.ts;
//   · web: `/huwa-config.json` → `community.discord` (huwa-server: HUWA_DISCORD_INVITE), read by
//     ./invite.web.ts.
// No link (the default) = no card, no row.
//
// The invitation is shown once: `social.createIdentity / restoreIdentity / acceptPairing` mark it
// pending (src/p2p/hooks.ts), the card (src/components/discord-invite.tsx) shows it once the app
// is on screen, and either button closes it for good.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

const KEY = 'huwa/community/discord-invite/v1';

/** Discord invite links only (the row says "Discord": it must not lead anywhere else). */
export function cleanDiscordInvite(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    const host = u.hostname.toLowerCase();
    const discord = host === 'discord.gg' || host === 'discord.com' || host === 'www.discord.com' || host === 'discordapp.com' || host === 'www.discordapp.com';
    if (u.protocol !== 'https:' || !discord || u.username || u.password || u.port) return null;
    if (u.pathname.replace(/\/+$/, '').length < 2) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export type InviteState = 'none' | 'pending' | 'done';

let state: InviteState = 'none';
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function parseInviteState(raw: string | null | undefined): InviteState {
  return raw === 'pending' || raw === 'done' ? raw : 'none';
}

/** Reads the saved state once (later calls share the promise). */
export function loadInviteState(): Promise<void> {
  loaded ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      // A request made before the read finished wins over an older 'none'.
      const saved = parseInviteState(raw);
      if (saved === 'done' || state === 'none') state = saved;
    })
    .catch(() => {})
    .finally(emit);
  return loaded;
}

function save(next: InviteState) {
  state = next;
  emit();
  AsyncStorage.setItem(KEY, next).catch(() => {});
}

/** After a successful account creation / restore / link. Never re-opens a closed invitation. */
export async function requestDiscordInvite(): Promise<void> {
  await loadInviteState();
  if (state === 'none') save('pending');
}

/** "Rejoindre" or "Plus tard": the card never comes back (the Réglages row stays). */
export function finishDiscordInvite() {
  save('done');
}

export const inviteState = () => state;

/** True while the one-time invitation waits to be shown. */
export function useDiscordInvitePending(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      void loadInviteState();
      return () => {
        listeners.delete(l);
      };
    },
    () => state === 'pending',
    () => false,
  );
}

/** Tests only. */
export function resetInviteForTests() {
  state = 'none';
  loaded = null;
}

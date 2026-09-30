// Optional AniList sync (read-only import of the user's anime + manhwa lists).
//
// Two ways in:
//  1. Public username — no login, works for any public AniList profile (default path).
//  2. OAuth "implicit grant" — also reads private lists. It needs an API client registered at
//     https://anilist.co/settings/developer with the redirect URL `huwa://anilist-auth`
//     (Expo Go / dev builds use another scheme: log `Linking.createURL('anilist-auth')`).
//     Put its numeric client ID below. No secret is needed for the implicit grant.
//     Docs: https://docs.anilist.co/guide/auth/implicit
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { fetchUserList, fetchViewer, type ListStatus } from '@/data/anilist-api';
import { t } from '@/i18n';
import { setWatchStatuses, upsertListByName, type WatchStatus } from '@/store/lists';
import { getState, toggleMyList } from '@/store/store';

/** AniList API client ID (numeric string). Empty = OAuth disabled, username import only. */
export const ANILIST_CLIENT_ID = '';

export const oauthAvailable = () => ANILIST_CLIENT_ID.length > 0;

const STATUS: Record<ListStatus, WatchStatus> = {
  CURRENT: 'watching',
  REPEATING: 'watching',
  PLANNING: 'planned',
  PAUSED: 'planned',
  COMPLETED: 'completed',
  DROPPED: 'dropped',
};

/** Opens AniList's consent page; resolves with an access token, or null if cancelled. */
export async function loginWithAniList(): Promise<string | null> {
  if (!oauthAvailable()) throw new Error(t('anilist.noClient'));
  const redirect = Linking.createURL('anilist-auth');
  const url = `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(ANILIST_CLIENT_ID)}&response_type=token`;
  const res = await WebBrowser.openAuthSessionAsync(url, redirect);
  if (res.type !== 'success') return null;
  // Implicit grant: the token comes back in the fragment (#access_token=…&token_type=Bearer&expires_in=…).
  const fragment = res.url.split('#')[1] ?? '';
  const token = new URLSearchParams(fragment).get('access_token');
  return token || null;
}

/**
 * Import a user's lists: statuses are copied, every series goes into the custom list "AniList",
 * and what they're currently watching/reading joins "Ma liste" (so it gets episode notifications).
 * The token, if any, is used for this import only and never stored.
 */
export async function importAniList(opts: { userName?: string; token?: string }): Promise<number> {
  let name = opts.userName?.trim() ?? '';
  if (opts.token) name = (await fetchViewer(opts.token)).name;
  if (!name) throw new Error('username');

  const entries = await fetchUserList(name, opts.token);
  if (!entries.length) return 0;

  setWatchStatuses(Object.fromEntries(entries.map((e) => [e.series.id, STATUS[e.status]])));
  upsertListByName(t('anilist.listName'), entries.map((e) => e.series.id));
  const mine = new Set(getState().myList);
  for (const e of entries) {
    if ((e.status === 'CURRENT' || e.status === 'REPEATING') && !mine.has(e.series.id)) toggleMyList(e.series.id);
  }
  return entries.length;
}

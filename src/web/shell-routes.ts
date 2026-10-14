// Navigation model of the web shell (pure: no React Native, unit-tested).
import type { IconName } from '@/components/ui';

export type NavItem = { href: '/' | '/anime' | '/manhwa' | '/library' | '/calendar' | '/addons' | '/settings'; label: string; icon: IconName; active: IconName };

export const NAV: NavItem[] = [
  { href: '/', label: 'Accueil', icon: 'home-outline', active: 'home' },
  { href: '/anime', label: 'Anime', icon: 'tv-outline', active: 'tv' },
  { href: '/manhwa', label: 'Manhwa', icon: 'book-outline', active: 'book' },
  { href: '/library', label: 'Bibliothèque', icon: 'bookmark-outline', active: 'bookmark' },
  { href: '/calendar', label: 'Calendrier', icon: 'calendar-clear-outline', active: 'calendar-clear' },
  { href: '/addons', label: 'Extensions', icon: 'extension-puzzle-outline', active: 'extension-puzzle' },
  { href: '/settings', label: 'Réglages', icon: 'settings-outline', active: 'settings' },
];

/** Which rail item a path belongs to. */
export function navFor(path: string): NavItem['href'] | null {
  if (path === '/' || path === '') return '/';
  if (path.startsWith('/anime')) return '/anime';
  if (path.startsWith('/manhwa')) return '/manhwa';
  if (path.startsWith('/library') || path.startsWith('/lists') || path.startsWith('/list/')) return '/library';
  if (path.startsWith('/calendar')) return '/calendar';
  if (/^\/(addons?|addon-catalog|extension|install|pack|manga-sources|debrid)(\/|$)/.test(path)) return '/addons';
  if (path.startsWith('/settings')) return '/settings';
  return null;
}

/** Routes drawn edge to edge, without the shell (signed in: player and reader). */
export function isFullScreen(path: string, signedIn: boolean): boolean {
  if (/^\/(onboarding|anilist-auth|paperback)(\/|$)/.test(path)) return true;
  return signedIn && /^\/(watch|read)\//.test(path);
}


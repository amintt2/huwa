// Incoming links → app routes (pure, unit-tested; used by src/app/+native-intent.tsx).
//
// - Universal links on the site (https://huwa.mciut.fr, declared in
//   site/.well-known/apple-app-site-association and the `applinks:` entitlement): the pages people
//   share open the app when it is installed, and stay web pages otherwise.
//     /addon?url=…            → /addon?url=…       (Stremio addon sheet)
//     /install?url=…&type=…   → /install?url=…     (addon or Paperback repository)
//     /extensions?url=…       → /install?url=…     (the extensions page's share link)
//     /pack.html#<d>, #url=…  → /pack?d=… / /pack?url=…
//   Any other path of the site opens the home screen.
// - App Store flavor (no extensions, see PLAN.md « Version App Store »): links to extension,
//   pack, debrid and torrent screens land on the home screen instead.
import { parsePackLink } from '../packs/format';

export const SITE_HOST = 'huwa.mciut.fr';

/** First path segments of the screens that only exist in the full (sideload / AltStore) flavor. */
export const FULL_ONLY_ROUTES = [
  'addons',
  'addon',
  'install',
  'extension',
  'extension-add',
  'manga-sources',
  'paperback',
  'pack',
  'pack-create',
  'addon-catalog',
  'debrid',
  'discover',
  'meta',
  'downloads',
] as const;

const URL_RE = /^([a-z][\w+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;

/** First route segment of an app path or link (`/addon?url=…` → `addon`, `huwa://pack?d=…` → `pack`). */
export function routeOf(pathOrUrl: string): string {
  const m = URL_RE.exec(pathOrUrl);
  const path = m ? (/^https?$/i.test(m[1]) ? m[3] : `/${m[2]}${m[3]}`) : pathOrUrl.replace(/[?#].*$/, '');
  return path.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
}

export const isFullOnlyRoute = (pathOrUrl: string) => (FULL_ONLY_ROUTES as readonly string[]).includes(routeOf(pathOrUrl));

/** App path for a link to the site, or undefined when the link is not one of ours. */
export function sitePath(url: string): string | undefined {
  const m = URL_RE.exec(url.trim());
  if (!m || !/^https?$/i.test(m[1]) || m[2].toLowerCase().replace(/^www\./, '') !== SITE_HOST) return undefined;
  const path = m[3].replace(/\/+$/, '').toLowerCase();
  const query = m[4] ?? '';
  const hasUrl = /[?&]url=[^&]/.test(query);
  if (path === '/addon' || path === '/addon.html') return hasUrl ? `/addon${query}` : '/';
  if (path === '/install' || path === '/install.html') return hasUrl ? `/install${query}` : '/';
  if (path === '/extensions' || path === '/extensions.html') return hasUrl ? `/install${query}` : '/';
  if (path === '/pack' || path === '/pack.html') {
    const ref = parsePackLink(url.trim());
    if (!ref) return '/';
    return 'd' in ref ? `/pack?d=${ref.d}` : `/pack?url=${encodeURIComponent(ref.url)}`;
  }
  return '/';
}

/** What `redirectSystemPath` returns for an incoming link. */
export function redirectLink(url: string, opts: { store: boolean }): string {
  const target = sitePath(url) ?? url;
  if (opts.store && isFullOnlyRoute(target)) return '/';
  return target;
}

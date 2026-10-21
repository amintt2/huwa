// "Ouvre Huwa dans ton navigateur": links tapped in X (Twitter), Instagram, TikTok… open in the
// app's own browser. There the APK download often fails, nothing can be installed (no PWA, no
// home screen), passkeys are missing and storage may be wiped once the view closes. The web app
// (src/web/in-app-prompt.tsx) and the site pages (site/inapp-browser.js: /get, /pack,
// /extensions) detect it and offer to reopen the page in the real browser. Pure, unit-tested in
// src/web/__tests__/in-app-browser.test.ts; site/inapp-browser.js repeats the same rules in
// plain JS.
import type { InstallOS } from './install-suggest';

export type InAppApp = 'x' | 'instagram' | 'facebook' | 'tiktok' | 'snapchat' | 'linkedin' | 'line' | 'webview';

/** Markers the apps put in their user agent, most specific first. */
const APPS: readonly [InAppApp, RegExp][] = [
  // X still says "Twitter": "Twitter for iPhone", "TwitterAndroid".
  ['x', /Twitter/i],
  ['instagram', /Instagram/],
  ['facebook', /FBAN|FBAV|FB_IAB|FBIOS|FB4A/],
  ['tiktok', /musical_ly|Bytedance|TikTok/i],
  ['snapchat', /Snapchat/],
  ['linkedin', /LinkedInApp/],
  ['line', /\bLine\//],
];

export const IN_APP_NAMES: Record<InAppApp, string | null> = {
  x: 'X',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  snapchat: 'Snapchat',
  linkedin: 'LinkedIn',
  line: 'LINE',
  webview: null,
};

/**
 * The app whose built-in browser shows this page, or null in a real browser. Any other Android
 * WebView ("; wv)" in the UA) counts too: same limits, unknown app.
 */
export function detectInAppBrowser(userAgent: string): InAppApp | null {
  const ua = userAgent || '';
  for (const [app, re] of APPS) if (re.test(ua)) return app;
  if (/Android/.test(ua) && /; wv\)/.test(ua)) return 'webview';
  return null;
}

/**
 * A link that leaves the built-in browser for the real one, or null when there is none (desktop).
 * · Android: an `intent:` URL without a package, so Android picks the default browser (or the
 *   Huwa app itself through its App Links), with the page as fallback.
 * · iOS 17+: `x-safari-https://`, which opens Safari.
 * The fragment is dropped: `intent:` uses it, and the app never relies on it.
 */
export function externalBrowserUrl(href: string, os: InstallOS): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = '';
  const scheme = u.protocol.slice(0, -1);
  const rest = u.toString().slice(u.protocol.length + 2);
  if (os === 'android') {
    return `intent://${rest}#Intent;scheme=${scheme};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(u.toString())};end`;
  }
  if (os === 'ios') return `x-safari-${scheme}://${rest}`;
  return null;
}

/** Where the app hides "open in browser", for the manual steps. */
export function manualSteps(app: InAppApp, os: InstallOS): string {
  const browser = os === 'ios' ? 'Safari' : 'ton navigateur';
  if (app === 'x') return `Touche ••• (ou l’icône de partage) en haut de la page, puis « Ouvrir dans ${browser} ».`;
  if (app === 'instagram' || app === 'facebook' || app === 'linkedin') return `Touche ••• en haut à droite, puis « Ouvrir dans ${browser} ».`;
  if (app === 'tiktok' || app === 'snapchat') return `Touche ••• en haut à droite, puis « Ouvrir dans le navigateur ».`;
  return `Copie le lien et colle-le dans ${os === 'ios' ? 'Safari' : 'Chrome ou ton navigateur habituel'}.`;
}

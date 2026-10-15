// "Installer l'app" on the web: which install path fits this browser, and when the home page may
// suggest it. Pure (no DOM access here: the caller passes what it read), unit-tested in
// src/web/__tests__/install-suggest.test.ts. UI: src/web/install.tsx. The same rules, in plain
// JS, drive the primary button of the old landing page (site/index.html, served at /get).
//
// · Android browser → the APK of the latest GitHub release (Obtainium as second choice). Never
//   push "add to home screen" there: the native app does much more than the PWA.
// · iPhone / iPad → "Ajouter à l'écran d'accueil" (Share → Sur l'écran d'accueil) for now; the
//   native app comes through AltStore PAL in the EU, sideload for advanced users (/get).
// · Desktop → install the PWA (beforeinstallprompt where supported), and the mobile apps.
// · Already installed (standalone display mode) or dismissed less than 30 days ago → nothing.
import { apkUpdate, type LatestRelease } from '@/updates/release';

export const RELEASES_URL = 'https://github.com/amintt2/huwa/releases/latest';
export const RELEASES_API = 'https://api.github.com/repos/amintt2/huwa/releases/latest';
export const OBTAINIUM_URL = 'obtainium://add/https://github.com/amintt2/huwa';
export const LANDING_PATH = '/get';

export type InstallOS = 'android' | 'ios' | 'desktop';
export type InstallBrowser = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'other';

/** What the caller read from `navigator` / `matchMedia`. */
export type InstallEnv = {
  userAgent: string;
  /** `navigator.userAgentData` (Chromium): `platform` "Android", "macOS"…, `mobile`. */
  uaData?: { platform?: string; mobile?: boolean } | null;
  /** `navigator.platform` ("MacIntel" on iPadOS desktop-class Safari). */
  platform?: string;
  maxTouchPoints?: number;
  /** `(display-mode: standalone)` matches, or `navigator.standalone` (iOS home-screen app). */
  standalone?: boolean;
};

export type InstallPlatform = { os: InstallOS; browser: InstallBrowser; standalone: boolean };

export function detectPlatform(env: InstallEnv): InstallPlatform {
  const ua = env.userAgent || '';
  const uaPlatform = env.uaData?.platform?.toLowerCase() ?? '';
  // iPadOS 13+ Safari claims to be a Mac: a touch screen gives it away (only with a Mac UA, so a
  // touch laptop or an emulated Android on a Mac stays what its UA says).
  const iPadAsMac = /Macintosh/.test(ua) && (env.maxTouchPoints ?? 0) > 1;
  let os: InstallOS;
  if (/iPhone|iPad|iPod/.test(ua)) os = 'ios';
  else if (uaPlatform === 'android' || /Android/i.test(ua)) os = 'android';
  else if (iPadAsMac) os = 'ios';
  else os = 'desktop';

  let browser: InstallBrowser;
  if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = 'edge';
  else if (/FxiOS|Firefox\//.test(ua)) browser = 'firefox';
  else if (/SamsungBrowser/.test(ua)) browser = 'samsung';
  else if (/CriOS|Chrome\/|Chromium\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = 'safari';
  else browser = 'other';
  return { os, browser, standalone: env.standalone === true };
}

export type InstallSuggestion =
  /** Installed already: never suggest. */
  | { kind: 'installed' }
  | { kind: 'android-apk' }
  | { kind: 'ios-home-screen'; browser: InstallBrowser }
  /** `canPrompt`: the browser offered `beforeinstallprompt`; Safari macOS: File → Add to Dock. */
  | { kind: 'desktop-pwa'; canPrompt: boolean; browser: InstallBrowser };

export function suggestInstall(p: InstallPlatform, canPrompt: boolean): InstallSuggestion {
  if (p.standalone) return { kind: 'installed' };
  if (p.os === 'android') return { kind: 'android-apk' };
  if (p.os === 'ios') return { kind: 'ios-home-screen', browser: p.browser };
  return { kind: 'desktop-pwa', canPrompt, browser: p.browser };
}

/** The suggestion can be acted on from a banner (desktop Firefox has no install at all). */
export function actionable(s: InstallSuggestion): boolean {
  if (s.kind === 'installed') return false;
  if (s.kind === 'desktop-pwa') return s.canPrompt || s.browser === 'safari';
  return true;
}

// ---------- banner timing and dismissal ----------

export const DISMISS_DAYS = 30;
const DAY = 24 * 3600_000;
/** A new visit = the page opened at least this long after the previous one. */
export const VISIT_GAP_MS = 30 * 60_000;
/** First visit: wait a little before suggesting; from the second visit, almost at once. */
export const FIRST_VISIT_DELAY_MS = 8000;
export const RETURN_VISIT_DELAY_MS = 1500;

export type BannerState = { visits: number; lastVisit: number; dismissedAt?: number };

export const EMPTY_BANNER_STATE: BannerState = { visits: 0, lastVisit: 0 };

export function parseBannerState(raw: string | null | undefined): BannerState {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object') return EMPTY_BANNER_STATE;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
    const dismissedAt = num(v.dismissedAt);
    return { visits: num(v.visits), lastVisit: num(v.lastVisit), ...(dismissedAt ? { dismissedAt } : null) };
  } catch {
    return EMPTY_BANNER_STATE;
  }
}

/** Counts this page load as a visit unless the previous one was less than VISIT_GAP_MS ago. */
export function recordVisit(s: BannerState, now: number): BannerState {
  const fresh = now - s.lastVisit >= VISIT_GAP_MS;
  return { ...s, visits: fresh ? s.visits + 1 : Math.max(1, s.visits), lastVisit: now };
}

export function dismissBanner(s: BannerState, now: number): BannerState {
  return { ...s, dismissedAt: now };
}

export function dismissedRecently(s: BannerState, now: number): boolean {
  return !!s.dismissedAt && now - s.dismissedAt < DISMISS_DAYS * DAY;
}

/** Milliseconds before the home banner shows, or null when it must not. */
export function bannerDelay(s: BannerState, suggestion: InstallSuggestion, now: number): number | null {
  if (!actionable(suggestion) || dismissedRecently(s, now)) return null;
  return s.visits >= 2 ? RETURN_VISIT_DELAY_MS : FIRST_VISIT_DELAY_MS;
}

// ---------- Android APK ----------

/**
 * ABIs to look for, best first, from the Client Hints (`architecture`, `bitness`) when the
 * browser gives them: almost every Android phone is arm64.
 */
export function androidAbis(hints?: { architecture?: string; bitness?: string } | null): string[] {
  const arch = hints?.architecture?.toLowerCase();
  if (arch === 'x86') return hints?.bitness === '32' ? ['x86'] : ['x86_64'];
  if (arch === 'arm' && hints?.bitness === '32') return ['armeabi-v7a'];
  return ['arm64-v8a'];
}

/** Direct APK link from the "latest release" API answer (ABI build, else universal), else the release page. */
export function apkDownload(release: LatestRelease | null | undefined, abis: readonly string[]): { url: string; version?: string; direct: boolean } {
  const github = (u: unknown): u is string => typeof u === 'string' && u.startsWith('https://github.com/amintt2/huwa/');
  if (release && Array.isArray(release.assets) && typeof release.tag_name === 'string') {
    const hit = apkUpdate(release, '0.0.0', abis);
    if (hit && github(hit.url)) return { url: hit.url, version: hit.version, direct: true };
  }
  return { url: github(release?.html_url) ? release!.html_url! : RELEASES_URL, direct: false };
}

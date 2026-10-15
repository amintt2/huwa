import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  actionable,
  androidAbis,
  apkDownload,
  bannerDelay,
  detectPlatform,
  dismissBanner,
  dismissedRecently,
  EMPTY_BANNER_STATE,
  FIRST_VISIT_DELAY_MS,
  parseBannerState,
  recordVisit,
  RELEASES_URL,
  RETURN_VISIT_DELAY_MS,
  suggestInstall,
  VISIT_GAP_MS,
} from '../install-suggest';

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  // iPadOS Safari asks for the desktop site: a Mac UA, only the touch points tell.
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
};

test('detectPlatform: OS and browser from the user agent', () => {
  assert.deepEqual(detectPlatform({ userAgent: UA.androidChrome }), { os: 'android', browser: 'chrome', standalone: false });
  assert.equal(detectPlatform({ userAgent: UA.androidSamsung }).browser, 'samsung');
  assert.deepEqual(detectPlatform({ userAgent: UA.androidFirefox }), { os: 'android', browser: 'firefox', standalone: false });
  assert.deepEqual(detectPlatform({ userAgent: UA.iphoneSafari }), { os: 'ios', browser: 'safari', standalone: false });
  assert.deepEqual(detectPlatform({ userAgent: UA.iphoneChrome }), { os: 'ios', browser: 'chrome', standalone: false });
  assert.deepEqual(detectPlatform({ userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 }), { os: 'desktop', browser: 'safari', standalone: false });
  assert.deepEqual(detectPlatform({ userAgent: UA.macChrome }), { os: 'desktop', browser: 'chrome', standalone: false });
  assert.equal(detectPlatform({ userAgent: UA.winEdge }).browser, 'edge');
  assert.deepEqual(detectPlatform({ userAgent: UA.linuxFirefox }), { os: 'desktop', browser: 'firefox', standalone: false });
});

test('detectPlatform: iPad in desktop mode, Client Hints, standalone', () => {
  assert.equal(detectPlatform({ userAgent: UA.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 5 }).os, 'ios');
  // userAgentData wins over a reduced / frozen UA string.
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0', uaData: { platform: 'Android', mobile: true } }).os, 'android');
  assert.equal(detectPlatform({ userAgent: UA.iphoneSafari, standalone: true }).standalone, true);
  // Android emulated on a Mac (DevTools): navigator.platform stays MacIntel.
  assert.equal(detectPlatform({ userAgent: UA.androidChrome, platform: 'MacIntel', maxTouchPoints: 5 }).os, 'android');
});

test('suggestInstall: APK on Android, home screen on iOS, PWA on desktop, nothing once installed', () => {
  const p = (userAgent: string, standalone = false) => detectPlatform({ userAgent, standalone });
  assert.deepEqual(suggestInstall(p(UA.androidChrome), true), { kind: 'android-apk' });
  assert.deepEqual(suggestInstall(p(UA.iphoneSafari), false), { kind: 'ios-home-screen', browser: 'safari' });
  assert.deepEqual(suggestInstall(p(UA.macChrome), true), { kind: 'desktop-pwa', canPrompt: true, browser: 'chrome' });
  assert.deepEqual(suggestInstall(p(UA.androidChrome, true), true), { kind: 'installed' });
  assert.deepEqual(suggestInstall(p(UA.macChrome, true), true), { kind: 'installed' });
});

test('actionable: no banner where the browser cannot install (desktop Firefox, Chrome before the prompt)', () => {
  const p = (userAgent: string) => detectPlatform({ userAgent });
  assert.equal(actionable(suggestInstall(p(UA.linuxFirefox), false)), false);
  assert.equal(actionable(suggestInstall(p(UA.macChrome), false)), false);
  assert.equal(actionable(suggestInstall(p(UA.macChrome), true)), true);
  assert.equal(actionable(suggestInstall(p(UA.macSafari), false)), true);
  assert.equal(actionable(suggestInstall(p(UA.androidFirefox), false)), true);
  assert.equal(actionable({ kind: 'installed' }), false);
});

test('visits: one per 30 minutes, first visit waits longer', () => {
  const t0 = 1_700_000_000_000;
  const android = { kind: 'android-apk' } as const;
  let s = recordVisit(EMPTY_BANNER_STATE, t0);
  assert.equal(s.visits, 1);
  assert.equal(bannerDelay(s, android, t0), FIRST_VISIT_DELAY_MS);
  s = recordVisit(s, t0 + 60_000);
  assert.equal(s.visits, 1, 'a reload is not a new visit');
  s = recordVisit(s, t0 + 60_000 + VISIT_GAP_MS);
  assert.equal(s.visits, 2);
  assert.equal(bannerDelay(s, android, t0 + VISIT_GAP_MS * 2), RETURN_VISIT_DELAY_MS);
  assert.equal(bannerDelay(s, { kind: 'installed' }, t0), null);
});

test('dismissal: hidden for 30 days, then back', () => {
  const t0 = 1_700_000_000_000;
  const day = 24 * 3600_000;
  const ios = { kind: 'ios-home-screen', browser: 'safari' } as const;
  const s = dismissBanner(recordVisit(EMPTY_BANNER_STATE, t0), t0);
  assert.equal(dismissedRecently(s, t0 + 29 * day), true);
  assert.equal(bannerDelay(s, ios, t0 + 29 * day), null);
  assert.equal(dismissedRecently(s, t0 + 30 * day), false);
  assert.notEqual(bannerDelay(s, ios, t0 + 31 * day), null);
});

test('parseBannerState survives junk', () => {
  assert.deepEqual(parseBannerState(null), EMPTY_BANNER_STATE);
  assert.deepEqual(parseBannerState('{oops'), EMPTY_BANNER_STATE);
  assert.deepEqual(parseBannerState('[1]'), { visits: 0, lastVisit: 0 });
  assert.deepEqual(parseBannerState('{"visits":-3,"lastVisit":"x","dismissedAt":5}'), { visits: 0, lastVisit: 0, dismissedAt: 5 });
  const s = dismissBanner(recordVisit(EMPTY_BANNER_STATE, 10), 20);
  assert.deepEqual(parseBannerState(JSON.stringify(s)), s);
});

test('APK: arm64 build when published, universal otherwise, else the release page', () => {
  const base = 'https://github.com/amintt2/huwa/releases/download/v1.2.0/';
  const asset = (name: string) => ({ name, browser_download_url: base + name });
  const release = { tag_name: 'v1.2.0', html_url: 'https://github.com/amintt2/huwa/releases/tag/v1.2.0', assets: [asset('Huwa-1.2.0.apk'), asset('Huwa-1.2.0-arm64-v8a.apk'), asset('Huwa-1.2.0.ipa')] };
  assert.deepEqual(apkDownload(release, androidAbis(null)), { url: base + 'Huwa-1.2.0-arm64-v8a.apk', version: '1.2.0', direct: true });
  assert.equal(apkDownload(release, androidAbis({ architecture: 'arm', bitness: '32' })).url, base + 'Huwa-1.2.0.apk');
  assert.deepEqual(apkDownload({ ...release, assets: [asset('Huwa-1.2.0.ipa')] }, ['arm64-v8a']), { url: release.html_url, direct: false });
  assert.deepEqual(apkDownload(null, ['arm64-v8a']), { url: RELEASES_URL, direct: false });
  // Never a link outside the project's releases.
  const evil = { ...release, html_url: 'https://evil.example/', assets: [{ name: 'Huwa-1.2.0-arm64-v8a.apk', browser_download_url: 'https://evil.example/x.apk' }] };
  assert.deepEqual(apkDownload(evil, ['arm64-v8a']), { url: RELEASES_URL, direct: false });
  assert.deepEqual(androidAbis({ architecture: 'x86', bitness: '64' }), ['x86_64']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectInAppBrowser, externalBrowserUrl, manualSteps } from '../in-app-browser';

const UA = {
  xIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/11.10',
  xAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.81 Mobile Safari/537.36 TwitterAndroid',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.25.94 (iPhone15,3; iOS 18_6; fr_FR; fr; scale=3.00; 1290x2796; 650001923)',
  facebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.42.109;FBBV/650001923]',
  tiktok: 'Mozilla/5.0 (Linux; Android 14; SM-S921B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.81 Mobile Safari/537.36 musical_ly_2023709030 BytedanceWebview/d8a21c6',
  androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.81 Mobile Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

test('detects the X in-app browser on iPhone and Android', () => {
  assert.equal(detectInAppBrowser(UA.xIphone), 'x');
  // X before the generic WebView rule.
  assert.equal(detectInAppBrowser(UA.xAndroid), 'x');
});

test('detects the other social apps and any Android WebView', () => {
  assert.equal(detectInAppBrowser(UA.instagram), 'instagram');
  assert.equal(detectInAppBrowser(UA.facebook), 'facebook');
  assert.equal(detectInAppBrowser(UA.tiktok), 'tiktok');
  assert.equal(detectInAppBrowser(UA.androidWebView), 'webview');
});

test('real browsers are left alone', () => {
  for (const ua of [UA.androidChrome, UA.iphoneSafari, UA.iphoneChrome, UA.desktopChrome, '']) assert.equal(detectInAppBrowser(ua), null);
});

test('Android: intent URL to the default browser, page as fallback, fragment dropped', () => {
  const url = externalBrowserUrl('https://huwa.mciut.fr/anime/21?x=1#top', 'android');
  assert.equal(
    url,
    'intent://huwa.mciut.fr/anime/21?x=1#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=https%3A%2F%2Fhuwa.mciut.fr%2Fanime%2F21%3Fx%3D1;end',
  );
  // No package: Android chooses (default browser, or the Huwa app through App Links).
  assert.doesNotMatch(url!, /package=/);
});

test('iOS: x-safari scheme; desktop and odd URLs: nothing', () => {
  assert.equal(externalBrowserUrl('https://huwa.mciut.fr/get#installer', 'ios'), 'x-safari-https://huwa.mciut.fr/get');
  assert.equal(externalBrowserUrl('http://localhost:8081/', 'ios'), 'x-safari-http://localhost:8081/');
  assert.equal(externalBrowserUrl('https://huwa.mciut.fr/', 'desktop'), null);
  assert.equal(externalBrowserUrl('javascript:alert(1)', 'android'), null);
  assert.equal(externalBrowserUrl('pas une url', 'ios'), null);
});

test('manual steps name the browser of the platform', () => {
  assert.match(manualSteps('x', 'ios'), /Safari/);
  assert.match(manualSteps('x', 'android'), /ton navigateur/);
  assert.match(manualSteps('webview', 'android'), /Copie le lien/);
});
